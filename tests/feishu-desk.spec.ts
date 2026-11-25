/** The publishing desk: the files it may open, the preview it shows, and the routes the panel calls. */
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { DeskError, deskRelative, deskRoots, listDeskFiles, previewDeskContent, readDeskFile, resolveDeskPath, writeDeskFile } from '../src/feishu/desk.ts'
import { fileDeskStore, memoryDeskStore } from '../src/feishu/desk-store.ts'
import { deskRoutes, sameDeskOrigin } from '../src/feishu/desk-http.ts'

/** A directory with a few Markdown files and one directory to skip. */
function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'desk-'))
  mkdirSync(join(root, 'notes'), { recursive: true })
  mkdirSync(join(root, 'node_modules'), { recursive: true })
  writeFileSync(join(root, 'a.md'), '# 甲\n\n正文\n', 'utf-8')
  writeFileSync(join(root, 'notes', 'b.md'), '# 乙\n', 'utf-8')
  writeFileSync(join(root, 'notes', 'c.txt'), '不是 Markdown\n', 'utf-8')
  writeFileSync(join(root, 'node_modules', 'd.md'), '# 不该被看见\n', 'utf-8')
  writeFileSync(join(root, '.hidden.md'), '# 隐藏\n', 'utf-8')
  return root
}

it('keeps every path inside its root', () => {
  const root = workspace()
  expect(resolveDeskPath(root, 'notes/b.md')).toBe(join(root, 'notes', 'b.md'))
  expect(resolveDeskPath(root, './notes/../a.md')).toBe(join(root, 'a.md'))
  expect(() => resolveDeskPath(root, '../escape.md')).toThrow(DeskError)
  expect(() => resolveDeskPath(root, '/etc/passwd')).toThrow(DeskError)
  expect(deskRelative(root, join(root, 'notes', 'b.md'))).toBe('notes/b.md')
})

it('lists the Markdown files of a root and nothing else', async () => {
  const root = workspace()
  const files = await listDeskFiles(root)
  expect(files.map(file => file.path)).toEqual(['a.md', 'notes/b.md'])
  expect(files[0]?.bytes).toBeGreaterThan(0)
  expect(files[0]?.modified).toMatch(/^\d{4}-\d{2}-\d{2}T/)
})

it('reads and writes a file', async () => {
  const root = workspace()
  expect((await readDeskFile(root, 'a.md')).content).toContain('# 甲')
  await expect(readDeskFile(root, 'missing.md')).rejects.toThrow(DeskError)
  const written = await writeDeskFile(root, 'a.md', '# 改过的\n')
  expect(written.path).toBe('a.md')
  expect((await readDeskFile(root, 'a.md')).content).toBe('# 改过的\n')
})

it('offers the working directory and the configured roots', () => {
  const roots = deskRoots(['/opt/ob-vault'], '/opt/dsh-superagent')
  expect(roots.map(root => root.path)).toEqual(['/opt/ob-vault', '/opt/dsh-superagent'])
})

it('previews what publishing would make of a note', () => {
  const preview = previewDeskContent('# 标题\n\n正文\n')
  expect(preview.blocks).toBe(2)
  expect(preview.text).toContain('# 标题')
  expect(preview.after).toBeLessThanOrEqual(preview.before)
})

it('answers the panel only for the roots it was given', async () => {
  const root = workspace()
  const publish = vi.fn(async (_input: { file: string; title?: string; docId?: string }) => ({
    doc_url: 'https://my.feishu.cn/docx/x', doc_id: 'x', title: 't', blocks: 2, contentBlocks: 1, imageBlocks: 0,
    images: 0, owner: '本人所有', chatNotified: [], rebuilt: false, madePublic: true,
  }))
  const routes = deskRoutes({ roots: () => deskRoots([root], root), publish, port: () => 3082, cut: () => [], store: () => memoryDeskStore() })
  type Call = { query: Record<string, string | undefined>; body: (maxBytes?: number) => Promise<unknown> }
  type Route = (call: Call) => Promise<unknown>
  const call = (name: string, input: { query?: Record<string, string | undefined>; body?: unknown }): Promise<unknown> => {
    const route = routes[name] as Route
    return route({ query: input.query ?? {}, body: async () => input.body })
  }

  const listed = await call('GET files', { query: { root } })
  expect(listed).toMatchObject({ root })
  await expect(call('GET files', { query: { root: '/etc' } })).rejects.toThrow(DeskError)
  await expect(call('PUT file', { body: { root, path: '../escape.md', content: 'x' } })).rejects.toThrow(DeskError)
  await call('PUT file', { body: { root, path: 'a.md', content: '# 新的\n' } })
  expect((await readDeskFile(root, 'a.md')).content).toBe('# 新的\n')
  expect(await call('POST preview', { body: { content: '# 甲\n' } })).toMatchObject({ blocks: 1 })
  await call('POST publish', { body: { root, path: 'a.md' } })
  expect(publish).toHaveBeenCalledWith(expect.objectContaining({ file: join(root, 'a.md') }))
  // The panel cannot name a document to rebuild: only the ones this desk published are rebuilt.
  await call('POST publish', { body: { root, path: 'a.md' } })
  expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ docId: 'x' }))
  expect(publish.mock.calls.some(call => call[0]?.docId === 'D1')).toBe(false)
})

it('refuses to rebuild a document the desk did not publish, and a file that is not Markdown', async () => {
  const root = workspace()
  const publish = vi.fn(async (_input: { file: string; title?: string; docId?: string }) => ({
    doc_url: 'https://my.feishu.cn/docx/x', doc_id: 'x', title: 't', blocks: 2, contentBlocks: 1, imageBlocks: 0,
    images: 0, owner: '本人所有', chatNotified: [], rebuilt: false, madePublic: true }))
  const routes = deskRoutes({ roots: () => deskRoots([root], root), publish, port: () => 3082, cut: () => [], store: () => memoryDeskStore() })
  type Call = { query: Record<string, string | undefined>; body: (maxBytes?: number) => Promise<unknown> }
  type Route = (call: Call) => Promise<unknown>
  const call = (name: string, input: { query?: Record<string, string | undefined>; body?: unknown }): Promise<unknown> => {
    const route = routes[name] as Route
    return route({ query: input.query ?? {}, body: async () => input.body })
  }
  // A document id from elsewhere is dropped: the desk rebuilds only what it published.
  await call('POST publish', { body: { root, path: 'a.md', doc_id: 'someone-elses-doc' } })
  expect(publish.mock.calls[0]?.[0]?.docId).toBeUndefined()
  // Only Markdown is open to the panel.
  await expect(call('GET file', { query: { root, path: 'notes/c.txt' } })).rejects.toThrow(DeskError)
  await expect(call('PUT file', { body: { root, path: 'notes/c.txt', content: 'x' } })).rejects.toThrow(DeskError)
})

it('treats two spellings of one path as the same document', async () => {
  const root = workspace()
  const publish = vi.fn(async (_input: { file: string; title?: string; docId?: string }) => ({
    doc_url: 'https://my.feishu.cn/docx/x', doc_id: 'x', title: 't', blocks: 2, contentBlocks: 1, imageBlocks: 0,
    images: 0, owner: '本人所有', chatNotified: [], rebuilt: false, madePublic: true,
  }))
  const routes = deskRoutes({ roots: () => deskRoots([root], root), publish, port: () => 3082, cut: () => [], store: () => memoryDeskStore() })
  type Route = (call: { query: Record<string, string | undefined>; body: (maxBytes?: number) => Promise<unknown> }) => Promise<unknown>
  const call = (name: string, body: unknown): Promise<unknown> => (routes[name] as Route)({ query: {}, body: async () => body })
  await call('POST publish', { root, path: 'a.md' })
  await call('POST publish', { root, path: './a.md' })
  expect(publish.mock.calls[1]?.[0]?.docId).toBe('x')
})

it('keeps the record another instance wrote while it was running', async () => {
  const file = join(tmpdir(), `desk-store-two-${process.pid}.json`)
  try {
    const first = fileDeskStore(file)
    first.set('/opt/ob-vault', 'a.md', 'doc-a')
    // A second instance writes its own record; the first one must not lose it.
    const second = fileDeskStore(file)
    second.set('/opt/proposal-rule', 'b.md', 'doc-b')
    first.set('/opt/ob-vault', 'c.md', 'doc-c')
    const third = fileDeskStore(file)
    expect(third.get('/opt/ob-vault', 'a.md')).toBe('doc-a')
    expect(third.get('/opt/proposal-rule', 'b.md')).toBe('doc-b')
    expect(third.get('/opt/ob-vault', 'c.md')).toBe('doc-c')
  } finally {
    rmSync(file, { force: true })
  }
})

it('remembers the document of a file across restarts, and forgets nothing else', async () => {
  const file = join(tmpdir(), `desk-store-${process.pid}.json`)
  try {
    const first = fileDeskStore(file)
    first.set('/opt/ob-vault', 'a.md', 'doc-a')
    // A second process reads the same file and finds the document.
    const second = fileDeskStore(file)
    expect(second.get('/opt/ob-vault', 'a.md')).toBe('doc-a')
    // The key is the root and the path, so the same name in another root is another document.
    expect(second.get('/opt/proposal-rule', 'a.md')).toBeUndefined()
    expect(second.get('/opt/ob-vault', 'b.md')).toBeUndefined()
  } finally {
    rmSync(file, { force: true })
  }
})

it('reads the older flat file, so a change of format does not lose the documents', () => {
  const file = join(tmpdir(), `desk-store-old-${process.pid}.json`)
  try {
    // The old format: one flat table, the key is the root and the path.
    writeFileSync(file, JSON.stringify({ '/opt/ob-vault\u0000a.md': 'doc-old' }), 'utf-8')
    const store = fileDeskStore(file)
    expect(store.get('/opt/ob-vault', 'a.md')).toBe('doc-old')
    // And the next write carries it into the new format.
    store.set('/opt/ob-vault', 'b.md', 'doc-new')
    const again = fileDeskStore(file)
    expect(again.get('/opt/ob-vault', 'a.md')).toBe('doc-old')
    expect(again.get('/opt/ob-vault', 'b.md')).toBe('doc-new')
  } finally {
    rmSync(file, { force: true })
  }
})

it('refuses a file that leaves the root through a symbolic link', async () => {
  const root = workspace()
  const outside = mkdtempSync(join(tmpdir(), 'desk-outside-'))
  writeFileSync(join(outside, 'secret.md'), '# 别人的文件\n', 'utf-8')
  symlinkSync(outside, join(root, 'link'), 'dir')
  await expect(readDeskFile(root, 'link/secret.md')).rejects.toThrow(DeskError)
  await expect(writeDeskFile(root, 'link/other.md', 'x')).rejects.toThrow(DeskError)
})

it('publishes several documents at once, each on its own, and keeps the failures apart', async () => {
  const root = workspace()
  let running = 0
  let peak = 0
  const publish = vi.fn(async (_input: { file: string; title?: string; docId?: string }) => {
    running++
    peak = Math.max(peak, running)
    await new Promise(resolve => setTimeout(resolve, 10))
    running--
    return { doc_url: 'https://my.feishu.cn/docx/x', doc_id: 'x', title: 't', blocks: 2, contentBlocks: 1, imageBlocks: 0,
      images: 0, owner: '本人所有', chatNotified: [], rebuilt: false, madePublic: true }
  })
  const routes = deskRoutes({ roots: () => deskRoots([root], root), publish, port: () => 3082, cut: () => [], store: () => memoryDeskStore() })
  type Call = { query: Record<string, string | undefined>; body: (maxBytes?: number) => Promise<unknown> }
  const route = routes['POST publish-many'] as (call: Call) => Promise<{ results: { path: string; ok: boolean }[] }>
  const answer = await route({ query: {}, body: async () => ({ root, paths: ['a.md', 'notes/b.md', 'missing.md'] }) })
  expect(answer.results).toHaveLength(3)
  expect(answer.results.filter(item => item.ok)).toHaveLength(2)
  expect(answer.results.find(item => item.path === 'missing.md')).toMatchObject({ ok: false })
  // The documents go out at the same time, not one after the other.
  expect(peak).toBeGreaterThan(1)
  expect(publish).toHaveBeenCalledTimes(2)
})

it('takes the panel\'s requests only from this machine', () => {
  expect(sameDeskOrigin({ headers: { host: '127.0.0.1:3082', 'x-publish-desk': '1' } }, 3082)).toBe(true)
  expect(sameDeskOrigin({ headers: { host: 'evil.example:3082', 'x-publish-desk': '1' } }, 3082)).toBe(false)
  expect(sameDeskOrigin({ headers: { host: '127.0.0.1:3082' } }, 3082)).toBe(false)
})

it('rewrites a document of a root, and answers with the product beside it', async () => {
  const root = workspace()
  const rewrite = vi.fn(async (input: { file: string; force?: boolean }) => ({
    output: join(root, 'a.飞书版.md'), changed: ['lead'], text: '# 甲\n', problems: [], facts: [],
    baseline: '/opt/thing @ 1', upToDate: false,
  }))
  const routes = deskRoutes({ roots: () => deskRoots([root], root), publish: vi.fn(), port: () => 3082, cut: () => [],
    store: () => memoryDeskStore(), rewrite })
  type Call = { query: Record<string, string | undefined>; body: (maxBytes?: number) => Promise<unknown> }
  const route = routes['POST rewrite'] as (call: Call) => Promise<{ output: string; changed: string[] }>
  const answer = await route({ query: {}, body: async () => ({ root, path: 'a.md' }) })
  expect(rewrite).toHaveBeenCalledWith(expect.objectContaining({ file: join(root, 'a.md') }))
  // The product is named the way the list names it, so the panel can open it.
  expect(answer.output).toBe('a.飞书版.md')
  expect(answer.changed).toEqual(['lead'])
  await expect(route({ query: {}, body: async () => ({ root, path: '../escape.md' }) })).rejects.toThrow(DeskError)
})
