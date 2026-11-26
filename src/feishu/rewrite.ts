/**
 * 把一份技术文档改写成给非技术读者看的中文说明。
 *
 * 分工是死的：**事实由代码抽，文案由模型写**。模型只负责把事实说成人话，
 * 不负责判断事实——版本号、接口、命令、依赖都由抽取器确定，模型引用它们，
 * 不许自己编。写完还有一道确定性检查：数字要有出处，密钥、口令、本机路径
 * 一律不许出现；通不过就不落盘。
 *
 * 改写是**按节**的。事实没变的那几节原样留着，只有变了的那几节重新写。
 * 全文重写会让每次改动都看不出来，也会把手工改过的句子冲掉。
 *
 * 产物是两份文件：`<名字>.飞书版.md` 是给人看的正文，`<名字>.飞书版.meta.json`
 * 是给程序看的：源文件的指纹、代码基线、事实清单、每节用到了哪些事实。
 * 有了它，下次才知道哪几节该重写。
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/** 一条事实：从代码或原文里确定下来的东西。 */
export interface Fact {
  /** 稳定标识：同一个 id 的 value 变了，就是这条事实变了。 */
  id: string
  kind: 'dependency' | 'route' | 'env' | 'command'
  /** 给人看的写法。 */
  value: string
}

/** 文档的一节。 */
export interface DraftSection {
  id: string
  title: string
  body: string
  /** 这一节用到了哪些事实的 id。 */
  facts: string[]
}

/** 一节该怎么写。 */
export interface SectionPlan {
  id: string
  title: string
  hint: string
}

/**
 * 通俗版的骨架。
 *
 * 不是把原文的目录照抄一遍——技术栈、目录结构、数据模型、给开发者的要求
 * 都不进正文。留下来的只有「这是什么、给谁用、怎么用、有什么坑、在哪」。
 */
export const SECTION_TEMPLATE: SectionPlan[] = [
  { id: 'lead', title: '', hint: '文档标题加一句话，说清这是什么、给谁用；标题里不要出现 PRD、MVP、版本号这类内部说法。正文里不要再把标题写一遍' },
  { id: 'audience', title: '一、什么时候需要用', hint: '谁在什么场景下用它，各自用它做什么' },
  { id: 'howto', title: '二、怎么用', hint: '怎么跑起来、怎么操作；命令照抄原文，不要改' },
  { id: 'pitfalls', title: '三、坑', hint: '前置条件、限制、常见问题与解法' },
  { id: 'notes', title: '四、相关', hint: '版本、依赖、代码在哪个仓库；不写本机路径' },
]

/** 产物正文的后缀，与知识库里 `*.飞书版.md` 的约定一致。 */
export const OUTPUT_SUFFIX = '.飞书版.md'
/** 产物元数据的后缀。 */
export const META_SUFFIX = '.飞书版.meta.json'

/* ── 事实抽取 ──────────────────────────────────────────────────────────── */

const CODE_EXTENSIONS = new Set(['.py', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.go', '.rs', '.java', '.rb', '.php'])
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', 'dist', 'build', 'lib', '.next', '.cache', 'vendor', 'target', 'site-packages'])
const MAX_CODE_FILES = 800
/** 依赖声明最多看多少个：一个仓库里通常只有两三个。 */
const MAX_MANIFESTS = 40
const MAX_DEPTH = 5
/** 事实太多会把提示词撑爆，也说明这份文档本来就不该讲这些。 */
export const MAX_FACTS = 160

const PY_ROUTE = /@(?:app|router|bp|blueprint)\.(get|post|put|delete|patch)\(\s*["']([^"']+)["']/g
const JS_ROUTE = /\b(?:app|router)\.(get|post|put|delete|patch)\(\s*["'`]([^"'`]+)["'`]/g
const PY_ENV = [/os\.getenv\(\s*["']([A-Z][A-Z0-9_]{2,})["']/g, /os\.environ\.get\(\s*["']([A-Z][A-Z0-9_]{2,})["']/g, /os\.environ\[\s*["']([A-Z][A-Z0-9_]{2,})["']\s*\]/g]
const JS_ENV = [/process\.env\.([A-Z][A-Z0-9_]{2,})/g, /process\.env\[["']([A-Z][A-Z0-9_]{2,})["']\]/g]
const BASH_FENCE = /```(?:bash|sh|shell|console)\n([\s\S]*?)```/g
/** 行内代码里像命令的：`pip install -r requirements.txt`。 */
const INLINE_COMMAND = /`([a-z][\w.\-]*(?:\/[\w.\-]+)*[^`\n]{2,80})`/g

/** 跑一条 git 命令；不是仓库或者没有 git，就当没有。 */
async function git(root: string, args: string[]): Promise<string | undefined> {
  try {
    // 只读的命令，但仓库可能不是 root 建的：safe.directory 让 git 愿意回答，
    // 而不是因为属主不对就拒绝。
    const { stdout } = await exec('git', ['-c', 'safe.directory=*', '-C', root, ...args],
      { timeout: 10000, maxBuffer: 1024 * 1024 })
    return stdout.trim()
  } catch {
    return undefined
  }
}

/** 目录所在的 git 仓库根；不在仓库里就返回这个目录本身。 */
export async function repoRootOf(directory: string): Promise<string> {
  const top = await git(directory, ['rev-parse', '--show-toplevel'])
  return top ? resolve(top) : resolve(directory)
}

/** 代码基线：哪个仓库的哪个 commit。文档变了要能对上号。 */
export async function codeBaseline(repo: string): Promise<string | undefined> {
  const commit = await git(repo, ['rev-parse', '--short', 'HEAD'])
  if (!commit) return undefined
  const date = await git(repo, ['log', '-1', '--format=%cI'])
  return date ? `${repo} @ ${commit}（${date.slice(0, 10)}）` : `${repo} @ ${commit}`
}

/**
 * 基线的另一种说法：分支、提交、日期，不带本机路径。
 *
 * 提示词里用这个。源笔记里的「代码基线」是活文档里的行，会过期——Octop 的
 * PRD 写的还是一条已经不存在的分支的旧提交号。文档里的基线要跟着仓库走，
 * 不能跟着那行字走。
 */
export async function codeBaselineNote(repo: string): Promise<string | undefined> {
  const commit = await git(repo, ['rev-parse', '--short', 'HEAD'])
  if (!commit) return undefined
  const branch = await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const date = await git(repo, ['log', '-1', '--format=%cI'])
  const parts = [branch && branch !== 'HEAD' ? `分支 ${branch}` : undefined, `提交 ${commit}`]
  const text = parts.filter(Boolean).join('，')
  return date ? `${text}（${date.slice(0, 10)}）` : text
}

/** 依赖声明的文件名。 */
const MANIFESTS = new Set(['requirements.txt', 'package.json', 'pyproject.toml'])

/**
 * 仓库里的依赖声明。
 *
 * 单独走一遍，不跟代码文件抢名额：代码文件有上限（几百个），大仓库里光
 * 一个子目录就把它占满了，根目录的 `pyproject.toml` 反而读不到——于是后端
 * 依赖一条都没进事实。
 */
async function listManifests(root: string): Promise<string[]> {
  const files: string[] = []
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || files.length >= MAX_MANIFESTS) return
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (files.length >= MAX_MANIFESTS) return
      if (entry.name.startsWith('.')) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue
        await walk(path, depth + 1)
        continue
      }
      if (entry.isFile() && MANIFESTS.has(entry.name)) files.push(path)
    }
  }
  await walk(root, 0)
  return files
}

/** 仓库里的代码文件，不含依赖与构建产物。 */
async function listCodeFiles(root: string): Promise<string[]> {
  const files: string[] = []
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || files.length >= MAX_CODE_FILES) return
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (files.length >= MAX_CODE_FILES) return
      if (entry.name.startsWith('.')) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue
        await walk(path, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      if (MANIFESTS.has(entry.name)) continue
      if (CODE_EXTENSIONS.has(extname(entry.name))) files.push(path)
    }
  }
  await walk(root, 0)
  return files
}

/** 一条依赖声明：名字，后面可能带 extras 和版本约束。 */
const DEP_SPEC = /^([A-Za-z0-9][A-Za-z0-9_.\-]*)\s*(?:\[[^\]]*\])?\s*(.*)$/

/**
 * 一条依赖的事实。
 *
 * 版本约束的符号要留着：`>=0.110` 是「至少 0.110」，写成「0.110」就成了
 * 「锁死在 0.110」，是另一回事。多个约束（`>=2.6,<2.14`）也照原样留着。
 * 直接引用（`pkg @ https://…`）没有版本，不算依赖事实。
 */
function dependencyOf(spec: string): Fact | undefined {
  const match = DEP_SPEC.exec(spec.trim())
  if (!match) return undefined
  const key = match[1]!
  const rest = match[2]!.split('#')[0]!.split(';')[0]!.trim()
  if (!rest) return { id: `dep:${key}`, kind: 'dependency', value: key }
  if (!/^[<>=!~]/.test(rest)) return undefined
  return { id: `dep:${key}`, kind: 'dependency', value: `${key} ${rest}` }
}

/**
 * 从 `pyproject.toml` 的 `[project]` 段取依赖。
 *
 * PEP 621 把依赖写成数组：`dependencies = ["fastapi>=0.110", "uvicorn[standard]>=0.30"]`。
 * 行式的解析器读不懂这种格式——之前 Octop 的后端依赖一条都没进事实，文档里
 * 只剩前端那批。
 */
function pyprojectDependencies(text: string): Fact[] {
  const facts: Fact[] = []
  const section = /^\[project\](?:(?!^\[)[\s\S])*?^dependencies\s*=\s*\[([\s\S]*?)\]\s*$/m.exec(text)
  if (!section) return facts
  const items = section[1]!.match(/"([^"]+)"|'([^']+)'/g) ?? []
  for (const item of items) {
    const fact = dependencyOf(item.slice(1, -1))
    if (fact) facts.push(fact)
  }
  return facts
}

/** 锁文件里装出来的版本；没有就是没装。 */
function installedVersion(lock: string, name: string): string | undefined {
  try {
    const value = JSON.parse(lock) as { packages?: Record<string, { version?: string }> }
    return value.packages?.[`node_modules/${name}`]?.version
  } catch { return undefined }
}

/**
 * 从依赖声明里取依赖。
 *
 * npm 的包里，若旁边有 `package-lock.json`，写**装出来的版本**并把声明的区间
 * 带上：文档里写「5.29.1」而实际装的是「5.29.3」，读者会以为装的是前者。
 */
function dependenciesOf(name: string, text: string, directory: string): Fact[] {
  const facts: Fact[] = []
  if (name === 'package.json') {
    let value: { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; peerDependencies?: Record<string, string> }
    try { value = JSON.parse(text) as typeof value } catch { return facts }
    let lock: string | undefined
    try { lock = readFileSync(join(directory, 'package-lock.json'), 'utf-8') } catch { lock = undefined }
    for (const group of [value.dependencies, value.devDependencies, value.peerDependencies]) {
      for (const [key, version] of Object.entries(group ?? {})) {
        const installed = lock ? installedVersion(lock, key) : undefined
        facts.push({
          id: `dep:${key}`,
          kind: 'dependency',
          value: installed ? `${key} ${installed}（声明 ${version}）` : `${key} ${version}`.trim(),
        })
      }
    }
    return facts
  }
  if (name === 'pyproject.toml') return pyprojectDependencies(text)
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith('-')) continue
    const fact = dependencyOf(line)
    if (fact) facts.push(fact)
  }
  return facts
}

/**
 * 抽事实。
 *
 * 事实分四种：依赖、接口、环境变量、命令。前三种从代码里抽（确定的），
 * 命令从原文里抽（原文是需求，需求里的命令就是该跑的命令）。
 */
export async function extractFacts(repo: string, source: string): Promise<Fact[]> {
  const facts = new Map<string, Fact>()
  const add = (fact: Fact): void => { if (!facts.has(fact.id)) facts.set(fact.id, fact) }

  // 依赖先抽：它们在仓库的哪儿都要算数，不能被代码文件的名额挤掉。
  for (const path of await listManifests(repo)) {
    let text: string
    try { text = await readFile(path, 'utf-8') } catch { continue }
    const name = path.slice(path.lastIndexOf('/') + 1)
    for (const fact of dependenciesOf(name, text, dirname(path))) add(fact)
  }

  for (const path of await listCodeFiles(repo)) {
    let text: string
    try { text = await readFile(path, 'utf-8') } catch { continue }
    const name = path.slice(path.lastIndexOf('/') + 1)
    if (MANIFESTS.has(name)) continue
    for (const pattern of [PY_ROUTE, JS_ROUTE]) {
      pattern.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = pattern.exec(text)) !== null) {
        const method = (match[1] ?? '').toUpperCase()
        const route = match[2] ?? ''
        add({ id: `route:${method} ${route}`, kind: 'route', value: `${method} ${route}` })
      }
    }
    for (const pattern of [...PY_ENV, ...JS_ENV]) {
      pattern.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = pattern.exec(text)) !== null) {
        const key = match[1] ?? ''
        add({ id: `env:${key}`, kind: 'env', value: key })
      }
    }
  }

  BASH_FENCE.lastIndex = 0
  let fence: RegExpExecArray | null
  while ((fence = BASH_FENCE.exec(source)) !== null) {
    for (const raw of (fence[1] ?? '').split('\n')) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      add({ id: `cmd:${line}`, kind: 'command', value: line })
    }
  }
  INLINE_COMMAND.lastIndex = 0
  let inline: RegExpExecArray | null
  while ((inline = INLINE_COMMAND.exec(source)) !== null) {
    const line = (inline[1] ?? '').trim()
    if (!line.includes(' ')) continue
    // 函数调用与路径不是命令。
    if (/[()[\]{}]/.test(line)) continue
    add({ id: `cmd:${line}`, kind: 'command', value: line })
  }

  const list = [...facts.values()]
  // 截断不能只按字母。Octop 有一百多条依赖：`dep:` 按名字排在 `route:`、`env:`
  // 前面，一截就把接口、变量、命令全挤掉；而大仓库的接口又有几百条，反过来
  // 也把依赖挤掉。所以分两步：先把原文点过名的留下（读者要看的正是这些），
  // 剩下的按种类轮流补，直到满额。
  const named = (fact: Fact): boolean => {
    const stem = fact.id.slice(fact.id.indexOf(':') + 1)
    return stem.length >= 3 && source.toLowerCase().includes(stem.toLowerCase())
  }
  const kept: Fact[] = list.filter(named).slice(0, MAX_FACTS)
  const seen = new Set(kept.map(fact => fact.id))
  const rest = list.filter(fact => !seen.has(fact.id))
  const queues = ['command', 'route', 'env', 'dependency']
    .map(kind => rest.filter(fact => fact.kind === kind))
  while (kept.length < MAX_FACTS && queues.some(queue => queue.length)) {
    for (const queue of queues) {
      const fact = queue.shift()
      if (fact && kept.length < MAX_FACTS) kept.push(fact)
    }
  }
  kept.sort((a, b) => a.id.localeCompare(b.id, 'en'))
  return kept
}

/** 事实变了没有：值不同的，加上原来有现在没有的。 */
export function changedFacts(previous: readonly Fact[], current: readonly Fact[]): Fact[] {
  const before = new Map(previous.map(fact => [fact.id, fact]))
  const after = new Map(current.map(fact => [fact.id, fact]))
  const changed: Fact[] = []
  for (const [id, fact] of after) {
    const old = before.get(id)
    if (!old || old.value !== fact.value) changed.push(fact)
  }
  for (const [id, fact] of before) {
    if (!after.has(id)) changed.push(fact)
  }
  return changed
}

/* ── 节的拆分与合并 ──────────────────────────────────────────────────────── */

/** 一篇通俗版文档拆成的几节。 */
export interface SplitDocument {
  title: string
  lead: string
  sections: { title: string; body: string }[]
}

/**
 * 把一篇通俗版文档拆成节。
 *
 * 第一节是正文里 `# ` 之后、第一个 `## ` 之前的那段（导语），其余每节
 * 以 `## ` 开头。拆出来的顺序和 `SECTION_TEMPLATE` 一致。
 */
export function splitDocument(text: string): SplitDocument {
  const lines = text.split('\n')
  let title = ''
  let index = 0
  while (index < lines.length) {
    const line = (lines[index] ?? '').trim()
    if (line.startsWith('# ')) { title = line.slice(2).trim(); index++; break }
    if (line) break
    index++
  }
  const lead: string[] = []
  const sections: { title: string; body: string[] }[] = []
  let current: { title: string; body: string[] } | undefined
  for (let i = index; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const heading = /^##\s+(.*)$/.exec(line.trim())
    if (heading) {
      current = { title: (heading[1] ?? '').trim(), body: [] }
      sections.push(current)
      continue
    }
    if (current) current.body.push(line)
    else lead.push(line)
  }
  return {
    title,
    lead: lead.join('\n').trim(),
    sections: sections.map(section => ({ title: section.title, body: section.body.join('\n').trim() })),
  }
}

/**
 * 去掉正文里对标题的重复。
 *
 * 模型常把标题又写一遍（`**Octop 产品使用说明**`），而标题已经单独成行了——
 * 页面上就连着出现三次。这里只去掉正文**开头**那一段与标题一样的文字。
 */
export function dropTitleEcho(body: string, title: string): string {
  const want = title.trim()
  if (!want) return body
  const lines = body.split('\n')
  let index = 0
  while (index < lines.length && !(lines[index] ?? '').trim()) index++
  const first = lines[index] ?? ''
  const plain = first.trim().replace(/^#+\s*/, '').replace(/\*\*/g, '').trim()
  if (plain !== want) return body
  return lines.slice(index + 1).join('\n').trim()
}

/** 把几节写回一篇文档。 */
export function buildDocument(sections: readonly DraftSection[]): string {
  const out: string[] = []
  for (const section of sections) {
    const body = dropTitleEcho(section.body, section.title)
    if (section.id === 'lead') {
      out.push(`# ${section.title}`.trimEnd())
      if (body) out.push('', body)
      continue
    }
    out.push('', `## ${section.title}`, '', body)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

/**
 * 哪几节该重写。
 *
 * 两种理由：这节记着的事实变了；或者变化的事实的字面出现在这节里
 * ——后者兜住「模型记错了事实的归属」这种情况。
 */
/**
 * 事实变了，哪几节要重写。
 *
 * 先看节的「事实归属」——上一版写这节时用了哪几条事实，那几条变了，这节就
 * 过期了。再兜一层：事实的**种类**落在哪一节里是模板定死的（依赖在「相关」，
 * 接口、命令、环境变量在「怎么用」），所以新加一条依赖也会把「相关」带出来
 * ——不然清单里就少了一条，而正文里那个包名根本不会出现，靠字符串匹配找不到。
 */
const KIND_SECTIONS: Record<string, readonly string[]> = {
  dependency: ['notes'],
  route: ['howto'],
  env: ['howto'],
  command: ['howto'],
}

export function affectedSections(
  sections: readonly DraftSection[],
  changed: readonly Fact[],
  sourceChanged: boolean,
): string[] {
  if (sourceChanged) return sections.map(section => section.id)
  const ids = new Set(changed.map(fact => fact.id))
  const values = changed.map(fact => fact.value).filter(value => value.length >= 4)
  // 事实 id 的后一半是它说的那个东西（包名、接口路径、变量名）。
  const stems = changed
    .map(fact => fact.id.slice(fact.id.indexOf(':') + 1))
    .filter(stem => stem.length >= 3)
  // 已经写进某节的事实，按那一节的归属算；没人写过的，才按种类兜底。
  const bound = new Set(sections.flatMap(section => section.facts))
  const byKind = new Set<string>()
  for (const fact of changed) {
    if (bound.has(fact.id)) continue
    for (const id of KIND_SECTIONS[fact.kind] ?? []) byKind.add(id)
  }
  return sections.filter(section => {
    if (section.facts.some(id => ids.has(id))) return true
    if (byKind.has(section.id)) return true
    if (values.some(value => section.body.includes(value))) return true
    return stems.some(stem => section.body.toLowerCase().includes(stem.toLowerCase()))
  }).map(section => section.id)
}

/* ── 模型的写作 ─────────────────────────────────────────────────────────── */

/** 模型怎么接。 */
export interface RewriteModel {
  /** OpenAI 兼容接口的地址，到 `/v1` 为止。 */
  baseUrl: string
  apiKey: string
  model: string
  timeoutMs: number
}

/** 让模型写的那几节，连同它们现在的正文。 */
export interface SectionRequest {
  id: string
  title: string
  hint: string
  body?: string
}

const SYSTEM_PROMPT = [
  '你是一名技术文档编辑。你的活是把一份内部的、写得很技术的中文文档，改写成给非技术读者看的中文说明。',
  '',
  '硬规则：',
  '- 只输出 JSON，形如 {"sections":[{"id":"...","title":"...","body":"...","facts":["..."]}]}，不要输出别的文字，也不要用 Markdown 代码块包起来。',
  '- body 是 Markdown。飞书里表格会被压成一行，所以不要用表格，用段落和列表。',
  '- 不写模块名、文件名、目录结构、数据库表结构、类名、函数名。',
  '- 不写本机绝对路径、端口、内网地址、账号口令。',
  '- 不写给开发者或模型的指令（例如「必须」「不要只写计划」「给 ClaudeCode」「Read this PRD」这一类段落一律不进正文）。',
  '- 每一个数字、命令、接口都必须来自「事实」或「原文」，不许自己编；确实不确定的写「待核实」。',
  '- 依赖事实可能写成「包名 版本（声明 区间）」：写实际装着的那个版本。',
  '- 代码基线（分支、提交号）以【代码基线】为准，不要抄原文里的——原文里的基线会过期。',
  '- 依赖事实里带版本约束（>=、< 这类符号）时，约束要照抄，不能只写一个数字：'
    + '「fastapi >=0.100.0」是「至少 0.100.0」，写成「0.100.0」就变成了「锁死在 0.100.0」。',
  '- 不要写生成日期。',
  '- 链接写成「[文字](网址)」，不要写「<网址>」：尖括号只是 Markdown 的记号，'
    + '带着它点开会 404。',
  '- facts 写这一节用到了哪些事实的 id。',
].join('\n')

/** 提示词里各部分的上限，防止提示词被撑爆。 */
const STYLE_LIMIT = 8000
const RULES_LIMIT = 12000
const SOURCE_LIMIT = 24000
const BODY_LIMIT = 6000

/** 组提示词。 */
export function buildPrompt(input: {
  source: string
  facts: readonly Fact[]
  style?: string
  /** 项目自己的发布规则：写什么、不写什么、置顶区长什么样。 */
  rules?: string
  sections: readonly SectionRequest[]
  /** 仓库现在的分支与提交；比原文里的基线新。 */
  baseline?: string
}): string {
  const parts: string[] = []
  if (input.style) parts.push(`【风格样例】\n${input.style.slice(0, STYLE_LIMIT)}`)
  if (input.rules) parts.push(`【发布规则】\n${input.rules.slice(0, RULES_LIMIT)}`)
  parts.push(`【原文】\n${input.source.slice(0, SOURCE_LIMIT)}`)
  parts.push(`【事实】\n${JSON.stringify(input.facts, null, 1)}`)
  if (input.baseline) parts.push(`【代码基线】\n${input.baseline}`)
  parts.push('【要写的节】')
  for (const section of input.sections) {
    const here = section.body ? `\n现有正文：\n${section.body.slice(0, BODY_LIMIT)}` : '\n现有正文：（空，这一节是新写的）'
    parts.push(`- id=${section.id} 标题=${section.title || '（文档标题）'}\n  这一节写什么：${section.hint}${here}`)
  }
  parts.push([
    '【输出】',
    '严格输出下面这个形状的 JSON，不要有别的文字，也不要用 Markdown 代码块包起来：',
    '{"sections":[{"id":"lead","title":"文档标题","body":"这一节的正文","facts":["dep:fastapi"]}]}',
    '按上面「要写的节」里的 id 逐节输出，节数与顺序都要一致；title 用给定的标题（lead 用文档标题）；'
    + 'facts 只填这一节用到的事实 id，没有就留空数组。',
  ].join('\n'))
  return parts.join('\n\n')
}

/** 从模型的回答里取出节。取不出来就说实话，不猜。 */
export function parseDraft(text: string): DraftSection[] {
  const sections = parseDraftSections(text)
  if (!sections.length) throw new Error('模型没有给出任何一节')
  return sections
}

/** 模型的思考过程不算答案。 */
function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<thinking>[\s\S]*?<\/thinking>/g, '')
}

/**
 * 找出回答里的 JSON 块。
 *
 * 回答里可能夹着思考过程、说明文字和代码围栏，所以挨个试：每一个括号配平
 * 的 `{...}` 都试着解一次，取**最后一个**解得开的——真正的答案在最后面。
 */
function jsonBlocks(text: string): string[] {
  const blocks: string[] = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{' && text[i] !== '[') continue
    let depth = 0
    let inString = false
    let escaped = false
    for (let j = i; j < text.length; j++) {
      const ch = text[j]!
      if (inString) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') { inString = true; continue }
      if (ch === '{' || ch === '[') depth++
      else if (ch === '}' || ch === ']') {
        depth--
        if (depth === 0) { blocks.push(text.slice(i, j + 1)); break }
      }
    }
  }
  return blocks
}

/** 把模型回答里的节读出来。 */
function parseDraftSections(text: string): DraftSection[] {
  const cleaned = stripThinking(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  for (const block of jsonBlocks(cleaned).reverse()) {
    let value: unknown
    try { value = JSON.parse(block) } catch { continue }
    const list = Array.isArray(value) ? value : (value as { sections?: unknown }).sections
    if (!Array.isArray(list)) continue
    const sections: DraftSection[] = []
    for (const item of list) {
      const entry = item as { id?: unknown; title?: unknown; body?: unknown; facts?: unknown }
      const id = typeof entry.id === 'string' ? entry.id : ''
      const body = typeof entry.body === 'string' ? entry.body.trim() : ''
      if (!id || !body) continue
      const facts = Array.isArray(entry.facts) ? entry.facts.filter((fact): fact is string => typeof fact === 'string') : []
      sections.push({ id, title: typeof entry.title === 'string' ? entry.title.trim() : '', body, facts })
    }
    if (sections.length) return sections
  }
  throw new Error('模型没有给出任何一节')
}

/** 问模型一次。 */
export async function callModel(model: RewriteModel, system: string, user: string): Promise<string> {
  const base = model.baseUrl.replace(/\/+$/, '')
  const send = async (json: boolean): Promise<Response> => await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${model.apiKey}` },
    body: JSON.stringify({
      model: model.model,
      temperature: 0.2,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    }),
    signal: AbortSignal.timeout(model.timeoutMs),
  })
  let response = await send(true)
  // 有些模型不认 response_format，退回普通请求再来一次。
  if (response.status === 400) response = await send(false)
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300)
    throw new Error(`模型网关回答 ${response.status}：${detail}`)
  }
  const value = await response.json() as { choices?: { message?: { content?: string } }[] }
  const content = value.choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content.trim()) throw new Error('模型没有回答')
  return content
}

/** 让模型写这几节。 */
export async function rewriteSections(input: {
  model: RewriteModel
  source: string
  facts: readonly Fact[]
  style?: string
  rules?: string
  sections: readonly SectionRequest[]
  baseline?: string
}): Promise<DraftSection[]> {
  const answer = await callModel(input.model, SYSTEM_PROMPT, buildPrompt(input))
  const sections = parseDraft(answer)
  const wanted = new Set(input.sections.map(section => section.id))
  const picked = sections.filter(section => wanted.has(section.id))
  if (!picked.length) throw new Error('模型写的节和要写的节对不上')
  return picked
}

/* ── 写完之后的检查 ─────────────────────────────────────────────────────── */

/** 检查发现的问题。 */
export interface DraftProblem {
  kind: 'forbidden' | 'secret' | 'path' | 'number'
  /**
   * `block` 表示这份稿子不写盘：密钥、口令、本机路径、给模型的指令。
   * `warn` 表示写了但人该看一眼：数字在事实里找不到出处，多半是模型编的。
   */
  severity: 'block' | 'warn'
  detail: string
}

/** 不该出现在公开文档里的说法。 */
const FORBIDDEN = [
  'ClaudeCode', 'Claude Code', 'Read this PRD', 'Do not only write', 'Strict requirements',
  '不要只写', '不要问确认', '给 ClaudeCode', '必须生成', 'Read this PRD and implement',
]
/** 密钥形状。 */
const SECRET_PAT = /\b(?:sk|ak|app)-[A-Za-z0-9_\-]{16,}/g
/** 口令形状：口令这个词后面跟着一个值。 */
const PASSWORD_PAT = /(密码|口令|password|passwd|pwd)(\s*["'`「『]?\s*[│|:：=]\s*["'`「『]?\s*)([^\s│|,"'`]{6,})/gi
/** 本机路径：公开文档里不该出现。 */
const INTERNAL_PATH = /(?:^|[\s`"'(（])\/(?:opt|root|home|Users|mnt|srv|var)\/[^\s`"')）]*/g
const WINDOWS_PATH = /[A-Za-z]:\\[^\s`"']+/g
/** 值得核对的数字：两位以上，或带小数点。 */
const NUMBER_PAT = /\d+(?:\.\d+)+|\d{2,}/g

/**
 * 检查一篇草稿。
 *
 * 三件事：不该有的说法不许有；密钥与口令不许有；本机路径不许有。
 * 还有数字：文里出现的每一个两位以上的数字，都得在事实或原文里找得到，
 * 否则就是模型自己编的。
 */
export function validateDraft(text: string, corpus: { facts: readonly Fact[]; source: string; style?: string; rules?: string; baseline?: string }): DraftProblem[] {
  const problems: DraftProblem[] = []
  for (const phrase of FORBIDDEN) {
    if (text.includes(phrase)) problems.push({ kind: 'forbidden', severity: 'block', detail: phrase })
  }
  for (const match of text.matchAll(SECRET_PAT)) problems.push({ kind: 'secret', severity: 'block', detail: match[0] })
  for (const match of text.matchAll(PASSWORD_PAT)) problems.push({ kind: 'secret', severity: 'block', detail: `${match[1]} ${match[3]}` })
  for (const match of text.matchAll(INTERNAL_PATH)) problems.push({ kind: 'path', severity: 'block', detail: match[0].trim() })
  for (const match of text.matchAll(WINDOWS_PATH)) problems.push({ kind: 'path', severity: 'block', detail: match[0] })
  // 代码基线也算出处：提交号里那串数字不是模型编的。
  const allowed = [...corpus.facts.map(fact => fact.value), corpus.source, corpus.style ?? '', corpus.rules ?? '', corpus.baseline ?? '', new Date().toISOString().slice(0, 10)].join('\n')
  for (const match of text.matchAll(NUMBER_PAT)) {
    const token = match[0]
    if (!allowed.includes(token)) problems.push({ kind: 'number', severity: 'warn', detail: token })
  }
  return problems
}

/* ── 一次完整的改写 ─────────────────────────────────────────────────────── */

/** 产物的元数据。 */
export interface RewriteMeta {
  version: number
  /** 源文件的路径。 */
  source: string
  /** 源文件的指纹：变了就说明需求改了。 */
  sourceHash: string
  /** 代码基线。 */
  baseline?: string
  /** 生成时间。 */
  generatedAt: string
  /** 事实清单。 */
  facts: Fact[]
  /** 每一节，以及它用到了哪些事实。 */
  sections: { id: string; title: string; facts: string[] }[]
}

/** 改写的结果。 */
export interface RewriteResult {
  /** 产物的路径。 */
  output: string
  /** 这次重写了哪几节。 */
  changed: string[]
  /** 写下去的正文；有问题时为空。 */
  text: string
  /** 检查发现的问题。 */
  problems: DraftProblem[]
  /** 事实清单。 */
  facts: Fact[]
  /** 代码基线。 */
  baseline?: string
  /** 事实没变，不用重写。 */
  upToDate: boolean
}

/** 文本的指纹。 */
export function hashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

/**
 * 去掉开头的 YAML frontmatter。
 *
 * frontmatter 是笔记自己的元数据（飞书链接、代码基线、标签），不是正文。
 * 它会被发布脚本剥掉，所以改写时也不能把它当原文喂给模型——否则模型
 * 可能把里面的链接抄进公开文档里。它也不该影响「源文件变了没有」的判断：
 * 补一条链接不等于改了需求。
 */
export function stripFrontmatter(text: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n/.exec(text)
  return match ? text.slice(match[0].length) : text
}

/** 产物的路径：源文件旁边，同名的 `*.飞书版.md`。 */
export function outputPathOf(source: string): string {
  const base = source.slice(0, source.length - extname(source).length)
  return `${base}${OUTPUT_SUFFIX}`
}

/** 元数据的路径。 */
export function metaPathOf(source: string): string {
  const base = source.slice(0, source.length - extname(source).length)
  return `${base}${META_SUFFIX}`
}

/**
 * 这个路径是不是改写产物。
 *
 * 产物不是源文件：拿 `PRD.飞书版.md` 去改写，会生出 `PRD.飞书版.飞书版.md`，
 * 越改越多层。
 */
export function isRewriteArtifact(file: string): boolean {
  return file.endsWith(OUTPUT_SUFFIX) || file.endsWith(META_SUFFIX)
}

/** 读旧产物与它的元数据；没有就当第一次写。 */
async function readPrevious(output: string, metaPath: string): Promise<{ text?: string; meta?: RewriteMeta }> {
  const [text, meta] = await Promise.all([
    readFile(output, 'utf-8').catch(() => undefined),
    readFile(metaPath, 'utf-8').then(raw => {
      try { return JSON.parse(raw) as RewriteMeta } catch { return undefined }
    }).catch(() => undefined),
  ])
  return { text, meta }
}

/**
 * 改写一篇文档。
 *
 * 第一次写是整篇写；之后只写事实变了的那几节，其余原样留着。源文件本身
 * 变了就整篇重写——需求变了，谁也不知道哪几节受影响。
 */
export async function rewriteDocument(input: {
  /** 源文件的绝对路径。 */
  file: string
  /** 模型。 */
  model: RewriteModel
  /** 风格样例；不给就用旧产物自己。 */
  style?: string
  /** 项目自己的发布规则：写什么、不写什么、置顶区长什么样。 */
  rules?: string
  /** 事实从哪个目录抽；不给就找源文件所在的 git 仓库。 */
  repo?: string
  /** 强制全部重写。 */
  force?: boolean
}): Promise<RewriteResult> {
  if (isRewriteArtifact(input.file)) {
    throw new Error(`${input.file} 是改写产物，不是源文件。要改写的是源文件，产物每次都会重新生成。`)
  }
  const source = stripFrontmatter(await readFile(input.file, 'utf-8'))
  const repo = input.repo ?? await repoRootOf(dirname(input.file))
  const facts = await extractFacts(repo, source)
  const baseline = await codeBaseline(repo)
  const baselineNote = await codeBaselineNote(repo)
  const output = outputPathOf(input.file)
  const metaPath = metaPathOf(input.file)
  const previous = await readPrevious(output, metaPath)
  const style = input.style ?? previous.text

  const sourceHash = hashOf(source)
  // 源文件变了就是需求变了：谁也不知道哪几节受影响，整篇重写。
  const sourceChanged = previous.meta ? previous.meta.sourceHash !== sourceHash : true
  const changed = previous.meta ? changedFacts(previous.meta.facts, facts) : []

  // 旧产物的几节：正文按顺序拆出来，身份（元数据里的 id 与事实归属）按顺序对上。
  let sections: DraftSection[] = []
  let aligned = false
  if (previous.text && previous.meta) {
    const split = splitDocument(previous.text)
    const bodies = [split.lead, ...split.sections.map(section => section.body)]
    // 旧产物的节数要和元数据对得上，对不上说明人动过结构，那就整篇重写。
    aligned = bodies.length === previous.meta.sections.length
    if (aligned) {
      sections = previous.meta.sections.map((entry, index) => ({
        id: entry.id,
        title: entry.title || (entry.id === 'lead' ? split.title : split.sections[index - 1]?.title || ''),
        body: bodies[index] ?? '',
        facts: entry.facts ?? [],
      }))
    }
  }

  const hasPrevious = Boolean(previous.meta && previous.text && aligned)
  const full = Boolean(input.force) || !hasPrevious
  const affected = full
    ? SECTION_TEMPLATE.map(plan => plan.id)
    : affectedSections(sections, changed, sourceChanged)
  if (!full && !affected.length) {
    return { output, changed: [], text: previous.text ?? '', problems: [], facts, baseline, upToDate: true }
  }

  const requests: SectionRequest[] = full
    ? SECTION_TEMPLATE.map(plan => ({ id: plan.id, title: plan.title, hint: plan.hint }))
    : SECTION_TEMPLATE
      .filter(plan => affected.includes(plan.id))
      .map(plan => ({
        id: plan.id,
        title: sections.find(section => section.id === plan.id)?.title || plan.title,
        hint: plan.hint,
        body: sections.find(section => section.id === plan.id)?.body,
      }))

  const written = await rewriteSections({ model: input.model, source, facts, style, rules: input.rules, sections: requests, baseline: baselineNote })

  // 合并：没让重写的节原样留着，让重写的换成新的。
  const merged = SECTION_TEMPLATE.map(plan => {
    const fresh = written.find(section => section.id === plan.id)
    const old = sections.find(section => section.id === plan.id)
    if (fresh) return { id: plan.id, title: fresh.title || old?.title || plan.title, body: fresh.body, facts: fresh.facts }
    if (old) return old
    return { id: plan.id, title: plan.title, body: '', facts: [] }
  })

  const text = buildDocument(merged)
  const rewritten = written.map(section => section.id)
  const problems = validateDraft(text, { facts, source, style, rules: input.rules, baseline: baselineNote })
  // 密钥、口令、本机路径、给模型的指令：不写盘。数字对不上出处：写了，但标出来。
  if (problems.some(problem => problem.severity === 'block')) {
    return { output, changed: rewritten, text: '', problems, facts, baseline, upToDate: false }
  }

  const meta: RewriteMeta = {
    version: 1,
    source: input.file,
    sourceHash,
    baseline,
    generatedAt: new Date().toISOString(),
    facts,
    sections: merged.map(section => ({ id: section.id, title: section.title, facts: section.facts })),
  }
  await writeFile(output, text, 'utf-8')
  await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf-8')
  return {
    output,
    changed: rewritten,
    text,
    problems,
    facts,
    baseline,
    upToDate: false,
  }
}
