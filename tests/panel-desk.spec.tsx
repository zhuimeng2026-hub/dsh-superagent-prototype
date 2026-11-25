// @vitest-environment jsdom
// The Desk tab: the files of a directory, the open document, and the button that publishes it.
import { expect, it, vi } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, click, find, field, tab, all, text } from './fixtures/panel.tsx'

usePanel()

const ROOT = '/opt/ob-vault'
const DOC = 'PRD.md'
const CONTENT = '# 标题\n\n正文\n'

interface DeskCall { path: string; method: string; body?: unknown }
const calls: DeskCall[] = []
/** The documents the fake desk has published, so a second listing carries the document id. */
const published = new Set<string>()

/** The desk's own routes, answered like the plugin answers them; the panel's other calls go on. */
function deskRoutes(): void {
  const orchestrator = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    const address = new URL(url, 'http://127.0.0.1:3082')
    if (!address.pathname.startsWith('/feishu-publish/api/')) return orchestrator(url, init)
    const path = address.pathname.slice('/feishu-publish/api/'.length)
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ path: `${path}${address.search}`, method: init?.method ?? 'GET', ...body === undefined ? {} : { body } })
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status,
      headers: { 'content-type': 'application/json' } })
    if (path === 'roots') return json({ roots: [{ path: ROOT, label: ROOT }] })
    if (path === 'files') return json({ root: ROOT, files: [{ path: DOC, name: DOC, bytes: CONTENT.length,
      modified: '2026-11-20T10:00:00.000Z', doc_id: published.has(DOC) ? 'd1' : undefined }] })
    if (path === 'file' && (init?.method ?? 'GET') === 'GET') return json({ root: ROOT, path: DOC, content: CONTENT,
      modified: '2026-11-20T10:00:00.000Z' })
    if (path === 'file') return json({ root: ROOT, path: DOC, bytes: CONTENT.length, modified: '2026-11-20T10:00:00.000Z' })
    if (path === 'preview') return json({ blocks: 2, text: CONTENT, before: 3, after: 3 })
    if (path === 'publish') {
      published.add(DOC)
      return json({ doc_url: 'https://my.feishu.cn/docx/d1', doc_id: 'd1', title: '标题', blocks: 2, contentBlocks: 1,
        imageBlocks: 0, images: 0, owner: '本人所有', chatNotified: [], rebuilt: false, madePublic: true })
    }
    if (path === 'publish-many') return json({ root: ROOT, results: (body as { paths: string[] }).paths.map(path => ({
      path, ok: true, result: { doc_url: `https://my.feishu.cn/docx/${path}`, doc_id: path, title: path, blocks: 2,
        contentBlocks: 1, imageBlocks: 0, images: 0, owner: '本人所有', chatNotified: [], rebuilt: false, madePublic: true } })) })
    return json({ error: '没有这个接口' }, 404)
  }))
}

it('lists the documents of a directory, opens one, and publishes it to Feishu', async () => {
  deskRoutes()
  await mount()
  await click(tab(zh['tab.desk']))
  await find(DOC, '.dt-open')
  expect(calls.some(call => call.path.startsWith('roots'))).toBe(true)
  expect(calls.some(call => call.path.startsWith('files'))).toBe(true)
  expect(all('.dt-open').map(item => item.textContent)).toEqual([DOC])

  await click(find(DOC))
  expect(text()).toContain('标题')
  expect(calls.some(call => call.path.startsWith('file?'))).toBe(true)

  await click(find(zh.deskPublish))
  const published = calls.find(call => call.path === 'publish')
  expect(published).toMatchObject({ method: 'POST', body: { root: ROOT, path: DOC } })
  expect(document.querySelector<HTMLAnchorElement>('a.dt-inline-link')?.href).toBe('https://my.feishu.cn/docx/d1')
  // The panel never names a document to rebuild: the desk knows which one it published.
  expect(published?.body).not.toHaveProperty('doc_id')
})

it('publishes the ticked documents in one batch', async () => {
  deskRoutes()
  await mount()
  await click(tab(zh['tab.desk']))
  await find(DOC, '.dt-open')
  await click(field<HTMLInputElement>(zh.deskSelectAll))
  expect(field<HTMLInputElement>(DOC).checked).toBe(true)
  await click(find(zh.deskPublishSelected))
  const batch = calls.find(call => call.path === 'publish-many')
  expect(batch).toMatchObject({ method: 'POST', body: { root: ROOT, paths: [DOC] } })
})
