/**
 * Markdown → 飞书 docx 块 的解析与预处理。
 *
 * 逐行对照 `/opt/ob-vault/37.律档通日更/飞书文档发布.py` 的 `parse_markdown`
 * 与 `/opt/ob-vault/14.待办事务/生成飞书发布版.py` 的 `build` 移植而来——
 * 那两个脚本是线上跑过的唯一事实源，改这里之前先看它们。
 */

/** 一个待发布的块。`value` 对图片是 URL，其余是文本。 */
export interface Item {
  kind: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'text' | 'bullet' | 'ordered' | 'code' | 'divider' | 'image' | 'blank'
  value: string
}

/** 飞书 docx 的块。block_type 见 `BLOCK_TYPES`。 */
export interface Block {
  block_type: number
  [key: string]: unknown
}

/** 飞书块类型编号。 */
export const BLOCK_TYPES = {
  text: 2,
  h1: 3,
  h2: 4,
  h3: 5,
  h4: 6,
  h5: 7,
  h6: 8,
  bullet: 12,
  ordered: 13,
  code: 14,
  divider: 22,
  image: 27,
} as const

const MAX_TEXT_LENGTH = 2000

const ORDERED_RE = /^(\d+)\.\s+(.*)$/
const BULLET_RE = /^[-*•]\s+(.*)$/
const IMAGE_RE = /^!\[([^\]]*)\]\(([^)]+)\)$/
const DIVIDERS = new Set(['* * *', '***', '---', '___'])
const HEADING_PREFIXES = ['###### ', '##### ', '#### ', '### ', '## ', '# ']

/** 把 `[文字](链接)` 变成 `文字（链接）`——飞书正文里没有链接语法。 */
export function normalizeInline(s: string): string {
  return s.trim().replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1（$2）')
}

/** 标题文本：先内联归一，再脱掉包裹的 `**`。 */
function normalizeHeadingText(s: string): string {
  let out = normalizeInline(s)
  if (out.startsWith('**') && out.endsWith('**') && out.length >= 4) {
    out = out.slice(2, -2).trim()
  }
  return out
}

function isBlockBoundary(s: string): boolean {
  const line = s.trim()
  if (!line) return true
  if (line === '**') return true
  if (DIVIDERS.has(line)) return true
  if (HEADING_PREFIXES.some(p => line.startsWith(p))) return true
  if (IMAGE_RE.test(line)) return true
  if (ORDERED_RE.test(line)) return true
  if (BULLET_RE.test(line)) return true
  if (/^```/.test(line)) return true
  if (/^( {4}|\t)/.test(s)) return true
  return false
}

/**
 * 解析 Markdown 成待发布的块序列。
 *
 * 与 Python 版一致的行为：空行不产生块（`preserve_blank_lines` 恒为 false），
 * 孤立的 `**` 当空行，列表项内容为空时吞掉下一非空行，
 * 段落把连续非边界行用空格拼起来。
 */
export function parseMarkdown(md: string): Item[] {
  const items: Item[] = []
  const lines = md.split('\n')
  let i = 0

  while (i < lines.length) {
    const raw = lines[i] ?? ''
    const line = raw.trim()

    // 缩进代码块
    if (/^( {4}|\t)/.test(raw)) {
      const codeLines = [raw.startsWith('    ') ? raw.slice(4) : raw.replace(/^\t+/, '')]
      let j = i + 1
      while (j < lines.length) {
        const next = lines[j] ?? ''
        if (!/^( {4}|\t)/.test(next)) break
        codeLines.push(next.startsWith('    ') ? next.slice(4) : next.replace(/^\t+/, ''))
        j++
      }
      const codeText = codeLines.join('\n').trim()
      if (codeText) items.push({ kind: 'code', value: codeText })
      i = j
      continue
    }

    // 围栏代码块。发布的准备步骤已把围栏改成缩进，这里仍认得它，
    // 以免这个解析器被单独使用时把围栏行贴进正文。
    if (/^```/.test(line)) {
      const codeLines: string[] = []
      let j = i + 1
      while (j < lines.length && !/^```/.test((lines[j] ?? '').trim())) {
        codeLines.push(lines[j] ?? '')
        j++
      }
      const codeText = codeLines.join('\n').trim()
      if (codeText) items.push({ kind: 'code', value: codeText })
      i = j < lines.length ? j + 1 : j
      continue
    }

    // 分隔线
    if (DIVIDERS.has(line)) {
      items.push({ kind: 'divider', value: '' })
      i++
      continue
    }

    // 空行
    if (!line || line === '**') {
      i++
      continue
    }

    // 图片
    const image = line.match(IMAGE_RE)
    if (image) {
      items.push({ kind: 'image', value: image[2] ?? '' })
      i++
      continue
    }

    // 标题
    const heading = HEADING_PREFIXES.find(p => line.startsWith(p))
    if (heading) {
      const level = heading.length - 1
      const kind = `h${level}` as Item['kind']
      items.push({ kind, value: normalizeHeadingText(line.slice(heading.length)) })
      i++
      continue
    }

    // 有序列表
    const ordered = line.match(ORDERED_RE)
    if (ordered) {
      const n = ordered[1] ?? ''
      const text = (ordered[2] ?? '').trim()
      if (text === `${n}.`) {
        let j = i + 1
        while (j < lines.length && !(lines[j] ?? '').trim()) j++
        if (j < lines.length) {
          items.push({ kind: 'ordered', value: normalizeInline(lines[j] ?? '') })
          i = j + 1
          continue
        }
      } else if (text) {
        items.push({ kind: 'ordered', value: normalizeInline(text) })
        i++
        continue
      }
    }

    // 无序列表
    const bullet = line.match(BULLET_RE)
    if (bullet) {
      let text = (bullet[1] ?? '').trim()
      if (['', '•', '-', '*'].includes(text) && i + 1 < lines.length) {
        let j = i + 1
        while (j < lines.length && !(lines[j] ?? '').trim()) j++
        if (j < lines.length) {
          text = (lines[j] ?? '').trim()
          i = j
        }
      }
      text = normalizeInline(text)
      if (text && !['•', '-', '*'].includes(text)) {
        items.push({ kind: 'bullet', value: text })
      }
      i++
      continue
    }

    // 段落
    const para = [normalizeInline(line)]
    let j = i + 1
    while (j < lines.length && !isBlockBoundary(lines[j] ?? '')) {
      para.push(normalizeInline(lines[j] ?? ''))
      j++
    }
    const text = para.filter(Boolean).join(' ').trim()
    if (text) items.push({ kind: 'text', value: text })
    i = j
  }

  return items
}

/**
 * 解析文本里的内联样式：`**粗体**` 与 `` `行内代码` ``。
 *
 * 与 Python 版一致：粗体在外层先行内代码，粗体里的代码同时带 bold 与 inline_code。
 */
export function richElements(text: string): unknown[] {
  const source = text.slice(0, MAX_TEXT_LENGTH)
  const elements: unknown[] = []

  for (const part of source.split(/(\*\*.*?\*\*)/)) {
    if (!part) continue
    const isBold = part.startsWith('**') && part.endsWith('**') && part.length >= 4
    elements.push(...inlineElements(isBold ? part.slice(2, -2) : part, isBold))
  }

  return elements.length > 0 ? elements : [{ text_run: { content: source } }]
}

function inlineElements(text: string, bold: boolean): unknown[] {
  const elements: unknown[] = []
  for (const part of text.split(/(`[^`]+`)/)) {
    if (!part) continue
    if (part.startsWith('`') && part.endsWith('`') && part.length >= 3) {
      const style: Record<string, unknown> = { inline_code: true }
      if (bold) style.bold = true
      elements.push({ text_run: { content: part.slice(1, -1), text_element_style: style } })
    } else if (bold) {
      elements.push({ text_run: { content: part, text_element_style: { bold: true } } })
    } else {
      elements.push({ text_run: { content: part } })
    }
  }
  return elements
}

function plainElements(text: string): unknown[] {
  return [{ text_run: { content: text.slice(0, MAX_TEXT_LENGTH) } }]
}

/** 把块序列转成飞书 docx 的块数组。 */
export function toBlocks(items: Item[]): Block[] {
  const blocks: Block[] = []
  for (const item of items) {
    switch (item.kind) {
      case 'h1':
        blocks.push({ block_type: BLOCK_TYPES.h1, heading1: { elements: plainElements(item.value) } })
        break
      case 'h2':
        blocks.push({ block_type: BLOCK_TYPES.h2, heading2: { elements: plainElements(item.value) } })
        break
      case 'h3':
        blocks.push({ block_type: BLOCK_TYPES.h3, heading3: { elements: plainElements(item.value) } })
        break
      case 'h4':
        blocks.push({ block_type: BLOCK_TYPES.h4, heading4: { elements: plainElements(item.value) } })
        break
      case 'h5':
        blocks.push({ block_type: BLOCK_TYPES.h5, heading5: { elements: plainElements(item.value) } })
        break
      case 'h6':
        blocks.push({ block_type: BLOCK_TYPES.h6, heading6: { elements: plainElements(item.value) } })
        break
      case 'text':
        blocks.push({ block_type: BLOCK_TYPES.text, text: { elements: richElements(item.value) } })
        break
      case 'bullet':
        blocks.push({ block_type: BLOCK_TYPES.bullet, bullet: { elements: richElements(item.value) } })
        break
      case 'ordered':
        blocks.push({ block_type: BLOCK_TYPES.ordered, ordered: { elements: richElements(item.value) } })
        break
      case 'code':
        blocks.push({ block_type: BLOCK_TYPES.code, code: { elements: plainElements(item.value) } })
        break
      case 'divider':
        blocks.push({ block_type: BLOCK_TYPES.divider, divider: {} })
        break
      case 'blank':
        blocks.push({ block_type: BLOCK_TYPES.text, text: { elements: richElements('') } })
        break
      case 'image':
        // 图片块要单独建（先建空块再上传），这里只做占位。
        blocks.push({ block_type: BLOCK_TYPES.image, image: { token: item.value } })
        break
    }
  }
  return blocks
}

/**
 * 取文档标题。
 *
 * 优先第一个 `# ` 标题；没有就取第一个非空非图片行，剥掉行首标记。
 */
export function resolveDocTitle(markdown: string): string {
  const lines = markdown.split('\n')

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (IMAGE_RE.test(line)) continue
    if (line.startsWith('# ')) return line.slice(2).trim()
  }

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (IMAGE_RE.test(line)) continue
    let out = line.replace(/^#+\s*/, '').replace(/^>\s*/, '')
    out = out.replace(/^[-*•]\s+/, '').replace(/^\d+\.\s+/, '')
    out = out.replace(/^\*\*(.*)\*\*$/, '$1')
    if (out.trim()) return out.trim()
  }

  throw new Error('cannot resolve document title')
}

/* ── 预处理（移植自 `生成飞书发布版.py`） ─────────────────────────────── */

/** 兜底脱敏：形如 `sk-` / `ak-` / `app-` 的长串。 */
const SECRET_PAT = /\b(?:sk|ak|app)-[A-Za-z0-9_\-]{16,}/g
/** 口令脱敏：按「密码 / 口令 / password + 分隔符 + ≥6 位值」的形状遮。 */
const PASSWORD_PAT =
  /(密码|口令|password|passwd|pwd)(\s*["'`「『]?\s*[│|:：=]\s*["'`「『]?\s*)([^\s│|,"'`]{6,})/gi
/** 内部路径 → 相对说法。公开文档里不该出现本机绝对路径。 */
const PATH_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\/opt\/ob-vault\/14\.待办事务\//g, '知识库笔记 '],
  [/\/opt\/ob-vault\/37\.\s*律档通日更\//g, ''],
  [/\/opt\/ob-vault\//g, ''],
]
/** callout 类型标记：飞书没有 callout 语法。 */
const CALLOUT_PAT = /^> \[!(abstract|info|warning|important|tip|note|success|example|question)\]\s*/
/** 引用前缀。 */
const QUOTE_PAT = /^\s*>\s?/
/** 围栏行：允许前置引用标记与缩进。 */
const FENCE_PAT = /^[^`]*?\s*(?:>\s*)*```(\w*)\s*$/

/** `[[A]]` → `A`；`[[A|B]]` → `B`；带路径的 `[[dir/A]]` → `A`。 */
export function dewikilink(s: string): string {
  return s
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, (_m, p1: string) => p1.split('/').pop() ?? p1)
}

/** 脱敏：密钥、口令、内部路径、双链。 */
export function clean(s: string): string {
  let out = s.replace(SECRET_PAT, 'sk-xxxxxxxxxxxx（已脱敏）')
  out = out.replace(PASSWORD_PAT, (_m, g1: string, g2: string) => `${g1}${g2}********（已脱敏）`)
  for (const [pat, replacement] of PATH_REPLACEMENTS) out = out.replace(pat, replacement)
  return dewikilink(out)
}

/** 去掉 frontmatter 整段。 */
export function cutFrontmatter(lines: string[]): string[] {
  if (!lines.length || (lines[0] ?? '').trim() !== '---') return lines
  for (let j = 1; j < lines.length; j++) {
    if ((lines[j] ?? '').trim() === '---') return lines.slice(j + 1)
  }
  return lines
}

function splitRow(s: string): string[] {
  let row = s.trim()
  if (row.startsWith('|')) row = row.slice(1)
  if (row.endsWith('|')) row = row.slice(0, -1)
  return row.split('|').map(c => c.trim())
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.filter(c => c !== '').every(c => /^:?-{2,}:?$/.test(c))
}

/** 加粗。值里已经有 `**` 就不再套。 */
function bold(s: string): string {
  const t = s.trim()
  return t.includes('**') ? t : `**${t}**`
}

/**
 * 表格 → 项目符号列表。
 *
 * 表头行作标签前缀：`- **列名**：值`；第一列值当分组标题独立成行；
 * 列数对不上就退化成 `- a / b`。
 */
export function convertTables(lines: string[]): string[] {
  const out: string[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (!line.trim().startsWith('|') || !line.trim().endsWith('|')) {
      out.push(line)
      i++
      continue
    }

    const block: string[] = []
    while (i < lines.length) {
      const row = lines[i] ?? ''
      if (!row.trim().startsWith('|') || !row.trim().endsWith('|')) break
      block.push(row)
      i++
    }

    const parsed = block.map(splitRow).filter(r => !isSeparatorRow(r))
    const header = parsed[0]
    if (!header) continue
    for (const r of parsed.slice(1)) {
      if (!r.length) continue
      if (header.length === r.length) {
        let pairs: Array<[string, string]> = []
        header.forEach((h, j) => { const v = r[j] ?? ''; if (v) pairs.push([h, v]) })
        if (!pairs.length) continue
        // 首列值与列名相同时，那一对是多余的，去掉。
        if (pairs.length > 1 && pairs[0]![0] === pairs[0]![1]) pairs = pairs.slice(1)
        if (!pairs.length) continue
        // 第一列当分组标题独立成行，其余列是该组的条目。
        if (pairs.length > 1) {
          out.push(bold(pairs[0]![1]))
          for (const [h, v] of pairs.slice(1)) out.push(`- ${bold(h)}：${v}`)
        } else {
          out.push(`- ${bold(pairs[0]![0])}：${pairs[0]![1]}`)
        }
      } else {
        out.push(`- ${r.filter(Boolean).join(' / ')}`)
      }
    }
  }

  return out
}

/**
 * 围栏代码块 → 缩进 4 格。
 *
 * 飞书 docx 只认缩进 4 格的连续行当代码块；围栏行本身会原样进正文。
 * 围栏可能被引用块包着（`> ```bash`），所以判定时允许前置引用标记。
 */
export function fenceToIndented(lines: string[]): string[] {
  const out: string[] = []
  let inFence = false
  let quoted = false

  for (const l of lines) {
    if (FENCE_PAT.test(l)) {
      if (!inFence) {
        inFence = true
        quoted = l.trim().startsWith('>')
        out.push('')
      } else {
        inFence = false
        out.push('')
      }
      continue
    }
    if (inFence) {
      out.push('    ' + (quoted ? l.replace(QUOTE_PAT, '') : l))
      continue
    }
    out.push(l)
  }

  return out
}

/** 代码块内的 `# xxx` 注释行会被解析器当成 H1 标题——换成全角空格。 */
export function protectCodeHeadings(lines: string[]): string[] {
  const out: string[] = []
  let inCode = false
  for (const l of lines) {
    if (l.trim().startsWith('```')) {
      inCode = !inCode
      out.push(l)
      continue
    }
    if (inCode && l.startsWith('# ')) {
      out.push('#　' + l.slice(2))
      continue
    }
    out.push(l)
  }
  return out
}

/** 尾部裁剪标记：命中即从这一行起删到文末。 */
export const CUT_MARKERS = ['## 四、代码与文档在哪', '## 附：', '## 相关']

/** 从第一个命中标记起删到文末。 */
export function cutTail(lines: string[], markers: string[] = CUT_MARKERS): string[] {
  if (!markers.length) return lines
  const out: string[] = []
  for (const l of lines) {
    if (markers.some(m => l.startsWith(m))) break
    out.push(l)
  }
  return out
}

/**
 * 完整预处理管线：源 Markdown → 可直接发布的文本。
 *
 * 顺序与 `生成飞书发布版.py` 的 `build` 一致。
 */
export function prepareMarkdown(markdown: string, options: { cut?: string[] } = {}): string {
  let lines = markdown.split('\n')
  lines = cutFrontmatter(lines)
  lines = convertTables(lines)
  lines = fenceToIndented(lines)
  lines = protectCodeHeadings(lines)
  lines = lines.map(clean)
  lines = lines.map(l => l.replace(CALLOUT_PAT, '> '))
  lines = lines.map(l => (l.trimStart().startsWith('>') ? l.replace(QUOTE_PAT, '') : l))
  lines = cutTail(lines, options.cut ?? CUT_MARKERS)
  while (lines.length && !(lines[lines.length - 1] ?? '').trim()) lines.pop()
  return lines.join('\n')
}
