// Tests of the plain-language rewriting: the facts taken from the code, the sections kept and
// rewritten, and the check that stands between a draft and a published document.
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  affectedSections, buildDocument, changedFacts, extractFacts, hashOf, outputPathOf, parseDraft,
  rewriteDocument, splitDocument, validateDraft, type Fact, type RewriteModel,
} from '../src/feishu/rewrite.ts'

afterEach(() => { vi.unstubAllGlobals() })

const SOURCE = [
  '# AI 标书评分引擎',
  '',
  '## 目标',
  '',
  '跑起来就能给企业打分。',
  '',
  '## 验收',
  '',
  '```bash',
  'pip install -r requirements.txt',
  'uvicorn app.main:app --reload',
  '```',
  '',
  '给 ClaudeCode 的要求：不要只写计划。',
].join('\n')

/** A workspace with a small FastAPI project in it. */
async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'rewrite-'))
  await mkdir(join(root, 'app'), { recursive: true })
  await writeFile(join(root, 'requirements.txt'), 'fastapi==0.115.0\nuvicorn\n', 'utf-8')
  await writeFile(join(root, 'app', 'main.py'), [
    'import os',
    'from fastapi import FastAPI',
    'app = FastAPI()',
    'DATABASE_URL = os.getenv("DATABASE_URL")',
    '',
    '@app.get("/health")',
    'def health():',
    '    return {"ok": True}',
  ].join('\n'), 'utf-8')
  await writeFile(join(root, 'PRD.md'), SOURCE, 'utf-8')
  return root
}

/** The model, answering with these sections. */
function answering(sections: { id: string; title: string; body: string; facts?: string[] }[]): { model: RewriteModel; asked: string[] } {
  const asked: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body?: string }) => {
    const body = JSON.parse(init.body ?? '{}') as { messages: { content: string }[] }
    asked.push(body.messages[1]!.content)
    const answer = JSON.stringify({ sections })
    return Response.json({ choices: [{ message: { content: answer } }] })
  }))
  return {
    model: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'test', timeoutMs: 5000 },
    asked,
  }
}

const FULL = [
  { id: 'lead', title: '企业标书评分', body: '给企业打分的评分引擎，装好就能用。', facts: [] },
  { id: 'audience', title: '一、什么时候需要用', body: '投标前给合作企业估个分。', facts: [] },
  { id: 'howto', title: '二、怎么用', body: '装好依赖，起服务，调用接口。', facts: ['route:GET /health'] },
  { id: 'pitfalls', title: '三、坑', body: '要先备好数据库。', facts: ['dep:fastapi'] },
  { id: 'notes', title: '四、相关', body: '代码在 proposal-rule 仓库。', facts: [] },
]

it('takes the facts from the code, not from the prose', async () => {
  const root = await workspace()
  const facts = await extractFacts(root, SOURCE)
  const ids = facts.map(fact => fact.id)
  expect(ids).toContain('dep:fastapi')
  expect(ids).toContain('dep:uvicorn')
  expect(ids).toContain('route:GET /health')
  expect(ids).toContain('env:DATABASE_URL')
  expect(ids).toContain('cmd:pip install -r requirements.txt')
  // The version is part of the fact: a new version is a changed fact.
  expect(facts.find(fact => fact.id === 'dep:fastapi')?.value).toBe('fastapi 0.115.0')
})

it('sees a changed version and a removed route as changed facts', () => {
  const before: Fact[] = [
    { id: 'dep:fastapi', kind: 'dependency', value: 'fastapi 0.115.0' },
    { id: 'route:GET /health', kind: 'route', value: 'GET /health' },
  ]
  const after: Fact[] = [
    { id: 'dep:fastapi', kind: 'dependency', value: 'fastapi 0.116.0' },
  ]
  const changed = changedFacts(before, after)
  expect(changed.map(fact => fact.id).sort()).toEqual(['dep:fastapi', 'route:GET /health'])
})

it('rewrites only the sections a changed fact reaches', () => {
  const sections = [
    { id: 'lead', title: 't', body: '一句话', facts: [] },
    { id: 'howto', title: 't', body: '起服务', facts: ['route:GET /health'] },
    { id: 'pitfalls', title: 't', body: '先备数据库', facts: ['dep:fastapi'] },
  ]
  const changed: Fact[] = [{ id: 'dep:fastapi', kind: 'dependency', value: 'fastapi 0.116.0' }]
  expect(affectedSections(sections, changed, false)).toEqual(['pitfalls'])
  // A changed source rewrites everything: nobody knows what a changed requirement touches.
  expect(affectedSections(sections, changed, true)).toEqual(['lead', 'howto', 'pitfalls'])
})

it('splits a document into its sections and puts it back together', () => {
  const text = buildDocument(FULL)
  const split = splitDocument(text)
  expect(split.title).toBe('企业标书评分')
  expect(split.lead).toContain('给企业打分的评分引擎')
  expect(split.sections.map(section => section.title)).toEqual([
    '一、什么时候需要用', '二、怎么用', '三、坑', '四、相关',
  ])
  expect(split.sections[1]?.body).toBe('装好依赖，起服务，调用接口。')
})

it('refuses a draft with a secret, a password, an internal path or an invented number', () => {
  const corpus = { facts: [{ id: 'dep:fastapi', kind: 'dependency' as const, value: 'fastapi 0.115.0' }], source: SOURCE }
  expect(validateDraft('装依赖：fastapi 0.115.0', corpus)).toEqual([])
  const problems = validateDraft([
    '钥匙是 sk-abcdefghijklmnopqrstuvwx',
    '密码： hunter2000',
    '代码在 /opt/proposal-rule 里',
    '这次一共 99 步',
    '给 ClaudeCode 的要求',
  ].join('\n'), corpus)
  const kinds = problems.map(problem => problem.kind)
  expect(kinds).toContain('secret')
  expect(kinds).toContain('path')
  expect(kinds).toContain('number')
  expect(kinds).toContain('forbidden')
  expect(problems.filter(problem => problem.kind === 'number').map(problem => problem.detail)).toContain('99')
})

it('writes the plain-language version and its facts, then leaves it alone while nothing changed', async () => {
  const root = await workspace()
  const source = join(root, 'PRD.md')
  const { model, asked } = answering(FULL)
  const first = await rewriteDocument({ file: source, model, repo: root })
  expect(first.problems).toEqual([])
  expect(first.upToDate).toBe(false)
  expect(first.changed).toEqual(['lead', 'audience', 'howto', 'pitfalls', 'notes'])
  const output = outputPathOf(source)
  expect(await readFile(output, 'utf-8')).toContain('# 企业标书评分')
  const meta = JSON.parse(await readFile(output.replace(/\.md$/, '.meta.json'), 'utf-8')) as { facts: Fact[]; sourceHash: string }
  expect(meta.sourceHash).toBe(hashOf(SOURCE))
  expect(meta.facts.map(fact => fact.id)).toContain('route:GET /health')

  // Nothing changed: the model is not asked again.
  const again = await rewriteDocument({ file: source, model, repo: root })
  expect(again.upToDate).toBe(true)
  expect(asked).toHaveLength(1)
})

it('rewrites only the section a changed fact reaches', async () => {
  const root = await workspace()
  const source = join(root, 'PRD.md')
  const { model, asked } = answering(FULL)
  await rewriteDocument({ file: source, model, repo: root })
  asked.length = 0
  // The dependency moved: only the section that used it is written again.
  await writeFile(join(root, 'requirements.txt'), 'fastapi==0.116.0\nuvicorn\n', 'utf-8')
  const second = await rewriteDocument({ file: source, model, repo: root })
  expect(second.upToDate).toBe(false)
  expect(second.changed).toEqual(['pitfalls'])
  expect(asked[0]).toContain('id=pitfalls')
  expect(asked[0]).not.toContain('id=howto')
})

it('does not write a draft the check refuses', async () => {
  const root = await workspace()
  const source = join(root, 'PRD.md')
  const { model } = answering(FULL.map(section => section.id === 'notes'
    ? { ...section, body: '代码在 /opt/proposal-rule 里' }
    : section))
  const result = await rewriteDocument({ file: source, model, repo: root })
  expect(result.problems.map(problem => problem.kind)).toContain('path')
  expect(result.problems.every(problem => problem.severity === 'block')).toBe(true)
  expect(result.text).toBe('')
  await expect(readFile(outputPathOf(source), 'utf-8')).rejects.toThrow()
})

it('writes a draft whose only problem is a number, and says which number', async () => {
  const root = await workspace()
  const source = join(root, 'PRD.md')
  const { model } = answering(FULL.map(section => section.id === 'notes'
    ? { ...section, body: '一共 99 步' }
    : section))
  const result = await rewriteDocument({ file: source, model, repo: root })
  expect(result.problems).toEqual([{ kind: 'number', severity: 'warn', detail: '99' }])
  expect(result.text).toContain('一共 99 步')
  expect(await readFile(outputPathOf(source), 'utf-8')).toContain('一共 99 步')
})

it('reads the sections out of a model answer', () => {
  const sections = parseDraft('```json\n{"sections":[{"id":"lead","title":"t","body":"b","facts":["dep:x"]}]}\n```')
  expect(sections).toEqual([{ id: 'lead', title: 't', body: 'b', facts: ['dep:x'] }])
  expect(() => parseDraft('这不是 JSON')).toThrow()
})

it('takes the answer out of an answer that starts with the model thinking', () => {
  const answer = [
    '<think>先想想有几节：{"id":"lead","body":"想到的"}</think>',
    '{"sections":[{"id":"lead","title":"t","body":"真正的答案","facts":[]}]}',
  ].join('\n')
  expect(parseDraft(answer)).toEqual([{ id: 'lead', title: 't', body: '真正的答案', facts: [] }])
})

it('keeps the frontmatter out of the model, and out of the hash', async () => {
  const root = await workspace()
  const source = join(root, 'PRD.md')
  const withNote = (link: string) => `---\n飞书文档: ${link}\n---\n\n${SOURCE}`
  await writeFile(source, withNote('https://my.feishu.cn/docx/abc'), 'utf-8')
  const { model, asked } = answering(FULL)
  await rewriteDocument({ file: source, model, repo: root })
  // The metadata is not content: the model never sees the link.
  expect(asked[0]).not.toContain('my.feishu.cn')
  // And it does not count as a change of the source.
  expect((await rewriteDocument({ file: source, model, repo: root })).upToDate).toBe(true)
  await writeFile(source, withNote('https://my.feishu.cn/docx/xyz'), 'utf-8')
  expect((await rewriteDocument({ file: source, model, repo: root })).upToDate).toBe(true)
})
