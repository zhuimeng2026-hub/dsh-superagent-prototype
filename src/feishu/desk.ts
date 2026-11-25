/**
 * 飞书发布台的文件面：能看、能改的文件，发布前的预览。
 *
 * 这一层只做文件与预览，**不做鉴权也不做发布**——那两件事在插件里
 * （`src/feishu-publish.ts`）。所有路径都锁在一个根目录里：
 * 根目录之外一律拒绝，避免面板变成任意读写。
 */

import type { Dirent } from 'node:fs'
import { constants } from 'node:fs'
import { open, readdir, readFile, realpath, readlink, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseMarkdown, prepareMarkdown } from './markdown.ts'

/** 面板可以打开的根目录。 */
export interface DeskRoot {
  /** 绝对路径。 */
  path: string
  /** 面板上显示的名字。 */
  label: string
}

/** 根目录下一个可编辑的文件。 */
export interface DeskFile {
  /** 相对根目录的路径，斜杠分隔。 */
  path: string
  /** 文件名。 */
  name: string
  /** 字节数。 */
  bytes: number
  /** 最后修改时间，ISO 8601。 */
  modified: string
}

/** 文件面的错误。`code` 是 HTTP 状态码。 */
export class DeskError extends Error {
  constructor(readonly code: 400 | 403 | 404, message: string) {
    super(message)
    this.name = 'DeskError'
  }
}

/** 面板一次能列多少个文件。 */
export const MAX_FILES = 500
/** 列目录时往下走几层。 */
export const MAX_DEPTH = 4
/** 不进这些目录。 */
const SKIP_DIRECTORIES = new Set(['node_modules', '.git', '.obsidian', '.trash', 'dist', 'build', 'lib', '__pycache__'])
/** 只列这些后缀。 */
const EDITABLE = /\.md$/i
/** 目录列表跳过以点开头的名字，路由也跳过：面板看不见的东西，路由也不该给。 */
const HIDDEN = /(^|\/)\.[^/]*/

/** 面板能打开的根目录：配置的目录，加上运行目录。 */
export function deskRoots(configured: readonly string[], cwd: string): DeskRoot[] {
  const roots = new Map<string, DeskRoot>()
  for (const path of configured) {
    const absolute = resolve(path)
    roots.set(absolute, { path: absolute, label: absolute })
  }
  const here = resolve(cwd)
  if (!roots.has(here)) roots.set(here, { path: here, label: here })
  return [...roots.values()]
}

/**
 * 把面板给的相对路径变成根目录里的绝对路径。
 *
 * 相对路径可以带 `..`，但结果必须还在根目录里，否则拒绝。
 *
 * 这只是**字面**上的检查：符号链接指向的目录不在其中，所以读与写还要
 * 经过 {@link ensureInsideRoot}，那一步跟着链接走，看真实的位置。
 */
export function resolveDeskPath(root: string, relativePath: string): string {
  const base = resolve(root)
  const target = isAbsolute(relativePath) ? resolve(relativePath) : resolve(base, relativePath)
  const inside = relative(base, target)
  if (inside.startsWith('..') || isAbsolute(inside)) {
    throw new DeskError(403, `路径越出了根目录：${relativePath}`)
  }
  // `.git`、`.config` 这样的目录列表里不显示，路由也不该让面板打开。
  if (HIDDEN.test(inside)) {
    throw new DeskError(403, `不能打开以点开头的路径：${relativePath}`)
  }
  return target
}

/**
 * 跟着符号链接走一遍路径，返回它**真正**指向哪里。
 *
 * `realpath` 不够用：它要求路径的每一段都存在，所以一个**指向还不存在
 * 的文件**的符号链接会让它抛错。恰恰是这种链接最危险——写文件时系统
 * 会顺着它把文件建到根目录外面去。所以这里一段一段地走：每一段是符
 * 号链接就读出它指向哪里，再从那里继续。
 */
export async function resolveThroughLinks(path: string, depth = 0): Promise<string> {
  if (depth > 32) throw new DeskError(403, '符号链接套得太深')
  const parent = dirname(path)
  const realParent = parent === path ? path : await resolveThroughLinks(parent, depth + 1)
  // 链接的目标可以是绝对的，也可以是相对目录的。
  const link = await readlink(join(realParent, basename(path))).catch(() => undefined)
  if (link === undefined) return join(realParent, basename(path))
  const target = isAbsolute(link) ? link : resolve(realParent, link)
  return resolveThroughLinks(target, depth + 1)
}

/**
 * 确认真实的位置还在根目录里，返回那个位置。
 *
 * 词法检查挡不住符号链接：根目录里的 `link` 指向 `/etc`，那么
 * `link/passwd` 的路径在根目录内，文件却在根目录外。这里跟着链接
 * 走一遍，看文件到底在哪；还不存在的文件看它的目录。
 */
export async function ensureInsideRoot(root: string, absolute: string): Promise<string> {
  const base = await realpath(resolve(root)).catch(() => resolve(root))
  const target = await resolveThroughLinks(absolute)
  const inside = relative(base, target)
  if (inside.startsWith('..') || isAbsolute(inside)) {
    throw new DeskError(403, `路径越出了根目录：${relative(root, absolute)}`)
  }
  return target
}

/** 根目录里相对路径的写法，斜杠分隔。 */
export function deskRelative(root: string, absolute: string): string {
  return relative(resolve(root), resolve(absolute)).split(sep).join('/')
}

/** 列出根目录里的 Markdown 文件。 */
export async function listDeskFiles(root: string): Promise<DeskFile[]> {
  const base = resolve(root)
  const files: DeskFile[] = []

  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || files.length >= MAX_FILES) return
    let entries: Dirent[]
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return
      if (entry.name.startsWith('.')) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue
        await walk(path, depth + 1)
        continue
      }
      if (!entry.isFile() || !EDITABLE.test(entry.name)) continue
      try {
        const info = await stat(path)
        files.push({ path: deskRelative(base, path), name: entry.name, bytes: info.size, modified: info.mtime.toISOString() })
      } catch {
        // 读不到就当它不在。
      }
    }
  }

  await walk(base, 0)
  files.sort((a, b) => a.path.localeCompare(b.path, 'zh-Hans-CN'))
  return files
}

/**
 * 读一个文件的内容。
 *
 * 读的是**链接真正指向**的那个文件，不是链接本身——所以面板看到的
 * 是文件的样子，而链接留在原地不动。
 */
export async function readDeskFile(root: string, relativePath: string): Promise<{ path: string; content: string; modified: string }> {
  const path = resolveDeskPath(root, relativePath)
  if (!EDITABLE.test(relativePath)) throw new DeskError(403, `只能打开 Markdown 文件：${relativePath}`)
  const real = await ensureInsideRoot(root, path)
  try {
    const [content, info] = await Promise.all([readFile(real, 'utf-8'), stat(real)])
    return { path: deskRelative(root, path), content, modified: info.mtime.toISOString() }
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') throw new DeskError(404, `文件不存在：${relativePath}`)
    throw new DeskError(400, `读不了文件：${relativePath}`)
  }
}

/**
 * 写一个文件的内容。
 *
 * 写的也是**链接真正指向**的那个文件。写之前用 `O_NOFOLLOW` 打开：
 * 免得检查和写入之间那一刻链接被换掉（那是本机上的另一条路径，
 * 换成符号链接），把内容写到别处去。
 */
export async function writeDeskFile(root: string, relativePath: string, content: string): Promise<{ path: string; bytes: number; modified: string }> {
  const path = resolveDeskPath(root, relativePath)
  if (!EDITABLE.test(relativePath)) throw new DeskError(403, `只能改 Markdown 文件：${relativePath}`)
  const real = await ensureInsideRoot(root, path)
  try {
    const handle = await open(real, 'w', constants.O_NOFOLLOW)
    try {
      await handle.writeFile(content, 'utf-8')
    } finally {
      await handle.close()
    }
    const info = await stat(real)
    return { path: deskRelative(root, path), bytes: info.size, modified: info.mtime.toISOString() }
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') throw new DeskError(404, `文件不存在：${relativePath}`)
    throw new DeskError(400, `写不了文件：${relativePath}`)
  }
}

/** 发布前的预览：正文会被改成什么样。 */
export interface DeskPreview {
  /** 转换后的块数。 */
  blocks: number
  /** 转换后的全文。 */
  text: string
  /** 转换前后的行数。 */
  before: number
  after: number
}

/**
 * 预览一份 Markdown 会变成什么。
 *
 * 走的是发布时同一条预处理管线（`prepareMarkdown`），所以这里看到的就是
 * 飞书上会看到的；只是不建文档。
 */
export function previewDeskContent(content: string, cut?: readonly string[]): DeskPreview {
  const prepared = prepareMarkdown(content, cut ? { cut: [...cut] } : {})
  const items = parseMarkdown(prepared)
  return {
    blocks: items.length,
    text: prepared,
    before: content.split('\n').length,
    after: prepared.split('\n').length,
  }
}
