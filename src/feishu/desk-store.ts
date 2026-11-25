/**
 * 发布台的记忆：哪篇文件对应哪一篇飞书文档，以及这个插件发过哪些文档。
 *
 * 面板**不能**自己给一个 document_id——那等于让它清空并改写这台机器
 * 碰得到的任何一篇飞书文档。所以这个对应关系由发布台自己记：面板只说
 * 「再发一次这篇」，发到哪一篇由这里回答。
 *
 * 同样的道理也管着工具那条路：工具重建一篇文档时，只能重建**这个插件
 * 亲手发过**的那一篇。否则一条被注入的指令就能让应用清空并公开任意一篇
 * 租户里的文档。
 *
 * 这个记忆要活得比进程长：上周发的文档，这一周改了文件再发，还是同一篇
 * 文档、同一个链接。所以它写在一个文件里。
 */

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 一篇文档的来历。 */
export interface PublishedDoc {
  /** 文档 id。 */
  docId: string
  /** 发它的那个根目录（从工具那条路发的就没有）。 */
  root?: string
  /** 相对根目录的路径。 */
  path?: string
  /** 什么时候发的，ISO 8601。 */
  at: string
}

/** 发布台记住的那些对应关系。 */
export interface DeskStore {
  /** 一篇文件对应哪一篇文档；没有就返回 undefined。 */
  get(root: string, path: string): string | undefined
  /** 记住一篇文件对应哪一篇文档。 */
  set(root: string, path: string, docId: string): void
  /** 这个插件发过哪些文档。 */
  docs(): PublishedDoc[]
  /** 记下一篇发过的文档。 */
  remember(doc: PublishedDoc): void
  /** 这篇文档是这个插件发过的吗。 */
  published(docId: string): boolean
}

/** 键：根目录与相对路径，中间用一个不会出现在路径里的分隔符。 */
const keyOf = (root: string, path: string): string => `${root}\u0000${path}`

/** 只在内存里记的；进程退出就没了。 */
export function memoryDeskStore(): DeskStore {
  const map = new Map<string, string>()
  const docs = new Map<string, PublishedDoc>()
  return {
    get: (root, path) => map.get(keyOf(root, path)),
    set: (root, path, docId) => { map.set(keyOf(root, path), docId) },
    docs: () => [...docs.values()],
    remember: doc => { docs.set(doc.docId, doc) },
    published: docId => docs.has(docId),
  }
}

/** 记忆默认放在凭据文件旁边。 */
export const DEFAULT_STORE_FILE = join(homedir(), '.config', 'feishu-publish-desk.json')

/** 记在一个文件里的两样东西：文件与文档的对应，以及发过的文档。 */
interface StoreFile {
  files?: Record<string, string>
  docs?: Record<string, PublishedDoc>
}

/**
 * 旧格式：一个扁平的表，键是「根目录\0相对路径」，值是文档 id。
 *
 * 早先的版本只记这一样。现在文件里多了一层，两种都读：换了格式不该把
 * 已经记下的对应关系弄丢——丢掉的后果是「再发一次」会另起一篇新文档，
 * 而不是重建原来那篇。
 */
function readStore(raw: unknown): { files: Record<string, string>; docs: Record<string, PublishedDoc> } {
  const files: Record<string, string> = {}
  const docs: Record<string, PublishedDoc> = {}
  if (!raw || typeof raw !== 'object') return { files, docs }
  const record = raw as Record<string, unknown>
  for (const [key, value] of Object.entries((record.files ?? {}) as Record<string, unknown>)) {
    if (typeof value === 'string') files[key] = value
  }
  for (const value of Object.values((record.docs ?? {}) as Record<string, PublishedDoc>)) {
    if (value && typeof value.docId === 'string') docs[value.docId] = value
  }
  // 旧格式：没有 `files` 也没有 `docs`，键里带着那个分隔符。
  if (!record.files && !record.docs) {
    for (const [key, value] of Object.entries(record)) {
      if (typeof value === 'string' && key.includes('\u0000')) files[key] = value
    }
  }
  return { files, docs }
}

/**
 * 记在一个 JSON 文件里的。
 *
 * 读不到就当没有：第一次发布之后才会有对应关系，丢了也只是重建一篇新
 * 文档，不是错误。
 */
export function fileDeskStore(file: string = DEFAULT_STORE_FILE): DeskStore {
  const map = new Map<string, string>()
  const docs = new Map<string, PublishedDoc>()
  let loaded = false
  const load = (): void => {
    if (loaded) return
    loaded = true
    try {
      const raw = JSON.parse(readFileSync(file, 'utf-8')) as StoreFile
      const read = readStore(raw)
      for (const [key, value] of Object.entries(read.files)) map.set(key, value)
      for (const [docId, value] of Object.entries(read.docs)) docs.set(docId, value)
    } catch {
      // 文件还没有，或者坏了：从空记忆开始。
    }
  }
  const save = (): void => {
    // 存盘前先重读一遍，把别人的记录也带上：另一个实例（另一个 profile）
    // 可能刚记过一篇文档，整份覆盖会把那条记丢掉。
    const files = new Map<string, string>()
    const allDocs = new Map<string, PublishedDoc>()
    try {
      const raw = JSON.parse(readFileSync(file, 'utf-8')) as StoreFile
      const read = readStore(raw)
      for (const [key, value] of Object.entries(read.files)) files.set(key, value)
      for (const [docId, value] of Object.entries(read.docs)) allDocs.set(docId, value)
    } catch {
      // 文件还没有，或者坏了：以自己的为准。
    }
    for (const [key, value] of map) files.set(key, value)
    for (const [key, value] of docs) allDocs.set(key, value)
    const body = JSON.stringify({ files: Object.fromEntries(files), docs: Object.fromEntries(allDocs) }, null, 2)
    // 先写临时文件再改名，免得中途断电留下半个 JSON；落盘前 fsync 一下，
    // 让改名之前的那个文件真的到了盘上。
    const temporary = `${file}.${process.pid}.tmp`
    mkdirSync(dirname(file), { recursive: true })
    const handle = openSync(temporary, 'w', 0o600)
    try {
      writeFileSync(handle, body, 'utf-8')
      fsyncSync(handle)
    } finally {
      closeSync(handle)
    }
    renameSync(temporary, file)
    map.clear()
    for (const [key, value] of files) map.set(key, value)
    docs.clear()
    for (const [key, value] of allDocs) docs.set(key, value)
  }
  return {
    get(root, path) { load(); return map.get(keyOf(root, path)) },
    set(root, path, docId) {
      load()
      map.set(keyOf(root, path), docId)
      try { save() } catch { /* 记不住也不影响发布本身。 */ }
    },
    docs() { load(); return [...docs.values()] },
    remember(doc) {
      load()
      docs.set(doc.docId, doc)
      try { save() } catch { /* 记不住也不影响发布本身。 */ }
    },
    published(docId) { load(); return docs.has(docId) },
  }
}
