/** The Feishu publishing plugin: the Markdown it reads, the blocks it makes, and the fence its configuration draws. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Config, apply, rewriteRulePaths } from '../src/feishu-publish.ts'
import { CUT_MARKERS, clean, convertTables, fenceToIndented, parseMarkdown, prepareMarkdown, resolveDocTitle, richElements, toBlocks } from '../src/feishu/markdown.ts'
import { resolveCredentials } from '../src/feishu/publish.ts'

const publish = vi.hoisted(() => vi.fn<(_input: Record<string, unknown>) => Promise<Record<string, unknown>>>(async () => ({
  doc_url: 'https://my.feishu.cn/docx/DSuXdEXsgoWZnyxUSymcuVHOnug',
  doc_id: 'DSuXdEXsgoWZnyxUSymcuVHOnug',
  title: '标题',
  blocks: 4,
  contentBlocks: 3,
  imageBlocks: 0,
  images: 0,
  owner: '本人所有',
  chatNotified: [] as string[],
  rebuilt: false,
  madePublic: true,
})))
vi.mock('../src/feishu/publish.ts', async importOriginal => ({ ...await importOriginal<typeof import('../src/feishu/publish.ts')>(), publish }))

afterEach(() => {
  publish.mockClear()
  delete process.env.FEISHU_APP_ID
  delete process.env.FEISHU_APP_SECRET
})

it('reads a heading, a paragraph, a list and a divider as the blocks Feishu shows', () => {
  const items = parseMarkdown('# 标题\n\n正文一行。\n\n- 甲\n- 乙\n\n---\n')
  expect(items.filter(item => item.kind !== 'blank')).toEqual([
    { kind: 'h1', value: '标题' },
    { kind: 'text', value: '正文一行。' },
    { kind: 'bullet', value: '甲' },
    { kind: 'bullet', value: '乙' },
    { kind: 'divider', value: '' },
  ])
  const blocks = toBlocks(items)
  expect(blocks.map(block => block.block_type)).toEqual([3, 2, 12, 12, 22])
  expect(blocks[0]).toEqual({ block_type: 3, heading1: { elements: [{ text_run: { content: '标题' } }] } })
})

it('writes a link as a clickable run, because a Feishu body has link styles', () => {
  const items = parseMarkdown('看 [下载页](https://example.com/a) 与 <https://example.com/b>')
  expect(items[0]).toEqual({ kind: 'text', value: '看 [下载页](https://example.com/a) 与 [https://example.com/b](https://example.com/b)' })
  expect(richElements(items[0]!.value)).toEqual([
    { text_run: { content: '看 ' } },
    { text_run: { content: '下载页', text_element_style: { link: { url: 'https://example.com/a' } } } },
    { text_run: { content: ' 与 ' } },
    { text_run: { content: 'https://example.com/b', text_element_style: { link: { url: 'https://example.com/b' } } } },
  ])
})

it('keeps the angle brackets and the trailing punctuation out of the address, so the link opens', () => {
  const elements = richElements('见 <https://gitee.com/webheat/octop_client/releases>。') as Array<{
    text_run: { content: string; text_element_style?: { link?: { url?: string } } }
  }>
  const urls = elements.map(element => element.text_run.text_element_style?.link?.url).filter(Boolean)
  expect(urls).toEqual(['https://gitee.com/webheat/octop_client/releases'])
  // 尖括号是记号，不是地址的一部分；地址也不能把后面的标点吃进去。
  expect(richElements('（https://example.com/a.zip）里')).toEqual([
    { text_run: { content: '（' } },
    { text_run: { content: 'https://example.com/a.zip', text_element_style: { link: { url: 'https://example.com/a.zip' } } } },
    { text_run: { content: '）里' } },
  ])
})

it('keeps an indented block as code and a fenced block as code', () => {
  expect(parseMarkdown('    ls -l\n    pwd')).toEqual([{ kind: 'code', value: 'ls -l\npwd' }])
  expect(parseMarkdown('```bash\nls -l\n```')).toEqual([{ kind: 'code', value: 'ls -l' }])
  expect(toBlocks([{ kind: 'code', value: 'ls -l' }])[0]).toEqual({ block_type: 14, code: { elements: [{ text_run: { content: 'ls -l' } }] } })
})

it('takes the next line of a list item whose own text is empty', () => {
  expect(parseMarkdown('- -\n有内容')).toEqual([{ kind: 'bullet', value: '有内容' }])
})

it('marks bold and inline code in a paragraph', () => {
  expect(richElements('**粗** 与 `码`')).toEqual([
    { text_run: { content: '粗', text_element_style: { bold: true } } },
    { text_run: { content: ' 与 ' } },
    { text_run: { content: '码', text_element_style: { inline_code: true } } },
  ])
})

it('takes the first heading as the title, and skips a leading image', () => {
  expect(resolveDocTitle('![封面](a.png)\n\n# 真正的标题\n\n正文')).toBe('真正的标题')
  expect(resolveDocTitle('![封面](a.png)\n\n一行文字')).toBe('一行文字')
})

it('turns a table into lists, because a Feishu document has no table', () => {
  const lines = ['| 名字 | 值 |', '| --- | --- |', '| 甲 | 一 |']
  // The first column names the group, so it stands alone; the other columns become its entries.
  expect(convertTables(lines)).toEqual(['**甲**', '- **值**：一'])
})

it('turns a fenced block into an indented one, and a quoted fence too', () => {
  expect(fenceToIndented(['```bash', 'ls -l', '```'])).toEqual(['', '    ls -l', ''])
  expect(fenceToIndented(['> ```bash', '> ls -l', '> ```'])).toEqual(['', '    ls -l', ''])
})

it('masks a key, a password and an internal path, and drops the frontmatter', () => {
  expect(clean('token sk-abcdefghijklmnopqrst')).toBe('token sk-xxxxxxxxxxxx（已脱敏）')
  expect(clean('密码: hunter2000')).toBe('密码: ********（已脱敏）')
  expect(clean('在 /opt/ob-vault/14.待办事务/x.md 里')).toBe('在 知识库笔记 x.md 里')
  expect(prepareMarkdown('---\n标题: x\n---\n\n正文')).toBe('\n正文')
})

it('drops the internal sections of a note from the tail', () => {
  const prepared = prepareMarkdown('# 标题\n\n正文\n\n## 相关\n\n- 别的笔记')
  expect(prepared).toBe('# 标题\n\n正文')
  expect(CUT_MARKERS).toContain('## 相关')
})

it('reads the credentials of the profile before the ones of the environment, and names what it used', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'feishu-profiles-'))
  const file = join(directory, 'profiles.json')
  writeFileSync(file, JSON.stringify({ personal: { app_id: 'cli_personal', app_secret: 'secret', owner_open_id: 'ou_owner' } }))
  // The profile decides the tenant, so it wins over an environment that still holds another tenant's application.
  process.env.FEISHU_APP_ID = 'cli_env'
  process.env.FEISHU_APP_SECRET = 'env-secret'
  const fromFile = await resolveCredentials({ profile: 'personal', profilesFile: file })
  expect(fromFile.source).toBe('profile:personal')
  expect(fromFile.credentials).toEqual({ appId: 'cli_personal', appSecret: 'secret' })
  expect(fromFile.ownerOpenId).toBe('ou_owner')
  // Without that profile, the environment is the way in.
  const fromEnv = await resolveCredentials({ profile: 'missing', profilesFile: file })
  expect(fromEnv.source).toBe('env')
  expect(fromEnv.credentials).toEqual({ appId: 'cli_env', appSecret: 'env-secret' })
  await expect(resolveCredentials({ profile: 'company', profilesFile: file, env: {} })).rejects.toThrow('company')
})

/** A credentials file of the plugin's own, so a test never reads the machine's. */
function credentialsFile(): string {
  const directory = mkdtempSync(join(tmpdir(), 'feishu-publish-'))
  const file = join(directory, 'profiles.json')
  writeFileSync(file, JSON.stringify({ personal: { app_id: 'cli_test', app_secret: 'secret', owner_open_id: 'ou_test' } }))
  return file
}

/** A Cordis context that records what the plugin registers. */
function context() {
  const handlers = new Map<string, (payload: never) => void>()
  const skills: Array<{ name: string; description: string; content: string }> = []
  const ctx = {
    on: vi.fn((name: string, handler: (payload: never) => void) => { handlers.set(name, handler) }),
    inject: vi.fn((_services: string[], callback: (child: unknown) => void) => {
      callback({ effect: (effect: () => unknown) => effect(), skills: { register: (skill: { name: string; description: string; content: string }) => { skills.push(skill); return () => {} } } })
    }),
    effect: vi.fn(),
    logger: { warn: vi.fn(), error: vi.fn() },
  }
  return { ctx, handlers, skills }
}

/** An agent with the tool registry the plugin writes to. */
interface Tool {
  name: string
  description: string
  execute: (args: unknown, execution: { signal: AbortSignal }) => Promise<unknown>
}

function agent(cwd = '/tmp') {
  const tools = new Map<string, Tool>()
  const value = {
    id: 'agent-1',
    session: { header: { cwd } },
    ctx: { tools: { register: (definition: Tool) => { tools.set(definition.name, definition); return () => tools.delete(definition.name) } } },
  }
  return { value, tools }
}

it('gives every agent the publishing tool and every session the skill', () => {
  const { ctx, handlers, skills } = context()
  apply(ctx as never, Config({}))
  const { value, tools } = agent()
  handlers.get('agent/created')!({ agent: value } as never)
  expect([...tools.keys()]).toEqual(['feishu_publish'])
  expect(skills.map(skill => skill.name)).toEqual(['dsh-superagent-feishu-publish'])
  expect(skills[0]!.description).not.toBe('')
  expect(skills[0]!.content).toContain('feishu_publish')
})

it('takes the tool off the agent when it is disposed', () => {
  const { ctx, handlers } = context()
  apply(ctx as never, Config({}))
  const { value, tools } = agent()
  handlers.get('agent/created')!({ agent: value } as never)
  expect(tools.size).toBe(1)
  handlers.get('agent/disposed')!({ agent: value } as never)
  expect(tools.size).toBe(0)
})

/** A workspace of the test's own, so the tool's fence has something real to stand on. */
function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'feishu-tool-'))
  writeFileSync(join(root, 'note.md'), '# 标题\n\n正文\n', 'utf-8')
  writeFileSync(join(root, 'secret.txt'), 'sk-0123456789abcdef0123\n', 'utf-8')
  mkdirSync(join(root, '.git'), { recursive: true })
  return root
}

/** The tool, as an agent of a workspace of the test's own sees it. */
function toolOf(root: string, settings: Record<string, unknown> = {}) {
  const { ctx, handlers } = context()
  apply(ctx as never, Config({ roots: [root], deskStoreFile: join(root, '.store.json'), profilesFile: credentialsFile(), ...settings }))
  const { value, tools } = agent(root)
  handlers.get('agent/created')!({ agent: value } as never)
  return tools.get('feishu_publish')!
}

it('publishes within the fence the configuration draws', async () => {
  const root = workspace()
  const tool = toolOf(root, { publish: false, chatIds: ['oc_allowed'] })
  await tool.execute({ file: 'note.md' }, { signal: new AbortController().signal })
  expect(publish).toHaveBeenCalledWith(expect.objectContaining({ file: join(root, 'note.md'), publish: false, chatIds: [], cwd: root }), expect.anything())
  rmSync(root, { recursive: true, force: true })
})

it('refuses a group the configuration does not allow', async () => {
  const root = workspace()
  const tool = toolOf(root, { chatIds: ['oc_allowed'] })
  await expect(tool.execute({ file: 'note.md', chat_id: 'oc_other' }, { signal: new AbortController().signal }))
    .rejects.toThrow('oc_other')
  expect(publish).not.toHaveBeenCalled()
  rmSync(root, { recursive: true, force: true })
})

it('publishes only a Markdown file inside a directory the plugin may publish from', async () => {
  const root = workspace()
  const tool = toolOf(root)
  const signal = new AbortController().signal
  // A file outside the roots, by absolute path or by climbing out of them.
  await expect(tool.execute({ file: '/root/.ssh/id_rsa' }, { signal })).rejects.toThrow('not inside')
  await expect(tool.execute({ file: '../../etc/passwd' }, { signal })).rejects.toThrow('not inside')
  await expect(tool.execute({ file: join(root, '..', 'outside.md') }, { signal })).rejects.toThrow('not inside')
  // A file inside the roots that is not Markdown.
  await expect(tool.execute({ file: 'secret.txt' }, { signal })).rejects.toThrow('only a Markdown file')
  expect(publish).not.toHaveBeenCalled()
  rmSync(root, { recursive: true, force: true })
})

it('rebuilds only a document this plugin published, and remembers the ones it creates', async () => {
  const root = workspace()
  const tool = toolOf(root)
  const signal = new AbortController().signal
  // A document id from elsewhere is not a way in: the model cannot clear someone else's document.
  await expect(tool.execute({ file: 'note.md', doc_id: 'someone-elses-doc' }, { signal })).rejects.toThrow('was not published by this plugin')
  expect(publish).not.toHaveBeenCalled()
  await tool.execute({ file: 'note.md' }, { signal })
  expect(publish.mock.calls[0]?.[0]?.docId).toBeUndefined()
  // The document it just created can be rebuilt, so a second call keeps the link.
  await tool.execute({ file: 'note.md', doc_id: 'DSuXdEXsgoWZnyxUSymcuVHOnug' }, { signal })
  expect(publish.mock.calls[1]?.[0]?.docId).toBe('DSuXdEXsgoWZnyxUSymcuVHOnug')
  // And the record outlives the process: a fresh plugin reads the same file.
  const again = toolOf(root)
  await again.execute({ file: 'note.md', doc_id: 'DSuXdEXsgoWZnyxUSymcuVHOnug' }, { signal })
  expect(publish.mock.calls[2]?.[0]?.docId).toBe('DSuXdEXsgoWZnyxUSymcuVHOnug')
  rmSync(root, { recursive: true, force: true })
})

it('gives a document the general rules and the rules of the project it belongs to', () => {
  const config = Config({
    rewriteRules: ['/rules/general.md'],
    rewriteRulesByRoot: [{ root: '/projects/alpha', rules: ['/rules/alpha.md'] },
      { root: '/projects/beta/deep', rules: ['/rules/beta.md'] }],
  })
  // A document of a project gets the general rules first, then its own project's.
  expect(rewriteRulePaths('/projects/alpha/doc.md', config)).toEqual(['/rules/general.md', '/rules/alpha.md'])
  // A document of no project gets only the general rules: one project's wording does not govern another's document.
  expect(rewriteRulePaths('/projects/gamma/doc.md', config)).toEqual(['/rules/general.md'])
  // The nearest root wins, so a nested project is not ruled by its parent.
  expect(rewriteRulePaths('/projects/beta/deep/doc.md', config)).toEqual(['/rules/general.md', '/rules/beta.md'])
  // A directory whose name is a prefix of another directory is not inside it.
  expect(rewriteRulePaths('/projects/alpha-extra/doc.md', config)).toEqual(['/rules/general.md'])
})

it('has no project rules when the configuration names none', () => {
  expect(Config({}).rewriteRulesByRoot).toEqual([])
  expect(rewriteRulePaths('/anywhere/doc.md', Config({}))).toEqual([])
})
