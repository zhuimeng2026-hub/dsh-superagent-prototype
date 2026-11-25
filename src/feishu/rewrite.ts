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
  { id: 'lead', title: '', hint: '文档标题加一句话，说清这是什么、给谁用；标题里不要出现 PRD、MVP、版本号这类内部说法' },
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
const REQUIREMENT = /^([A-Za-z0-9][A-Za-z0-9_.\-]*)\s*(?:([=<>!~]=?|===)\s*([\w.\*+-]+))?$/

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
      if (entry.name === 'requirements.txt' || entry.name === 'package.json' || entry.name === 'pyproject.toml') {
        files.push(path)
        continue
      }
      if (CODE_EXTENSIONS.has(extname(entry.name))) files.push(path)
    }
  }
  await walk(root, 0)
  return files
}

/** 从依赖声明里取依赖。 */
function dependenciesOf(name: string, text: string): Fact[] {
  const facts: Fact[] = []
  if (name === 'package.json') {
    let value: { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; peerDependencies?: Record<string, string> }
    try { value = JSON.parse(text) as typeof value } catch { return facts }
    for (const group of [value.dependencies, value.devDependencies, value.peerDependencies]) {
      for (const [key, version] of Object.entries(group ?? {})) {
        facts.push({ id: `dep:${key}`, kind: 'dependency', value: `${key} ${version}`.trim() })
      }
    }
    return facts
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith('-')) continue
    const match = REQUIREMENT.exec(line)
    if (!match) continue
    const key = match[1]!
    const version = match[3]
    facts.push({ id: `dep:${key}`, kind: 'dependency', value: version ? `${key} ${version}` : key })
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

  for (const path of await listCodeFiles(repo)) {
    let text: string
    try { text = await readFile(path, 'utf-8') } catch { continue }
    const name = path.slice(path.lastIndexOf('/') + 1)
    if (name === 'requirements.txt' || name === 'package.json' || name === 'pyproject.toml') {
      for (const fact of dependenciesOf(name, text)) add(fact)
      continue
    }
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
  list.sort((a, b) => a.id.localeCompare(b.id, 'en'))
  return list.slice(0, MAX_FACTS)
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

/** 把几节写回一篇文档。 */
export function buildDocument(sections: readonly DraftSection[]): string {
  const out: string[] = []
  for (const section of sections) {
    if (section.id === 'lead') {
      out.push(`# ${section.title}`.trimEnd())
      if (section.body) out.push('', section.body)
      continue
    }
    out.push('', `## ${section.title}`, '', section.body)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

/**
 * 哪几节该重写。
 *
 * 两种理由：这节记着的事实变了；或者变化的事实的字面出现在这节里
 * ——后者兜住「模型记错了事实的归属」这种情况。
 */
export function affectedSections(
  sections: readonly DraftSection[],
  changed: readonly Fact[],
  sourceChanged: boolean,
): string[] {
  if (sourceChanged) return sections.map(section => section.id)
  const ids = new Set(changed.map(fact => fact.id))
  const values = changed.map(fact => fact.value).filter(value => value.length >= 4)
  return sections.filter(section => {
    if (section.facts.some(id => ids.has(id))) return true
    return values.some(value => section.body.includes(value))
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
  '- 不要写生成日期。',
  '- facts 写这一节用到了哪些事实的 id。',
].join('\n')

/** 提示词里各部分的上限，防止提示词被撑爆。 */
const STYLE_LIMIT = 8000
const SOURCE_LIMIT = 24000
const BODY_LIMIT = 6000

/** 组提示词。 */
export function buildPrompt(input: {
  source: string
  facts: readonly Fact[]
  style?: string
  sections: readonly SectionRequest[]
}): string {
  const parts: string[] = []
  if (input.style) parts.push(`【风格样例】\n${input.style.slice(0, STYLE_LIMIT)}`)
  parts.push(`【原文】\n${input.source.slice(0, SOURCE_LIMIT)}`)
  parts.push(`【事实】\n${JSON.stringify(input.facts, null, 1)}`)
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
  sections: readonly SectionRequest[]
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
export function validateDraft(text: string, corpus: { facts: readonly Fact[]; source: string; style?: string }): DraftProblem[] {
  const problems: DraftProblem[] = []
  for (const phrase of FORBIDDEN) {
    if (text.includes(phrase)) problems.push({ kind: 'forbidden', severity: 'block', detail: phrase })
  }
  for (const match of text.matchAll(SECRET_PAT)) problems.push({ kind: 'secret', severity: 'block', detail: match[0] })
  for (const match of text.matchAll(PASSWORD_PAT)) problems.push({ kind: 'secret', severity: 'block', detail: `${match[1]} ${match[3]}` })
  for (const match of text.matchAll(INTERNAL_PATH)) problems.push({ kind: 'path', severity: 'block', detail: match[0].trim() })
  for (const match of text.matchAll(WINDOWS_PATH)) problems.push({ kind: 'path', severity: 'block', detail: match[0] })
  const allowed = [...corpus.facts.map(fact => fact.value), corpus.source, corpus.style ?? '', new Date().toISOString().slice(0, 10)].join('\n')
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
  /** 事实从哪个目录抽；不给就找源文件所在的 git 仓库。 */
  repo?: string
  /** 强制全部重写。 */
  force?: boolean
}): Promise<RewriteResult> {
  const source = await readFile(input.file, 'utf-8')
  const repo = input.repo ?? await repoRootOf(dirname(input.file))
  const facts = await extractFacts(repo, source)
  const baseline = await codeBaseline(repo)
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

  const written = await rewriteSections({ model: input.model, source, facts, style, sections: requests })

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
  const problems = validateDraft(text, { facts, source, style })
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
