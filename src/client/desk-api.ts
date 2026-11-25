/** Calls of the publishing desk's host routes (`src/feishu/desk-http.ts`), typed for the panel. */
import type { PublishResult } from '../feishu/publish.ts'
import { ApiError } from './api.ts'
import type { T } from './text.ts'

export interface DeskRoot { path: string; label: string }
/** One document of a root, and the Feishu document the desk published for it, if any. */
export interface DeskFile { path: string; name: string; bytes: number; modified: string; doc_id?: string }
export interface DeskPreview { blocks: number; text: string; before: number; after: number }
export type DeskResult = PublishResult
/** One document of a parallel batch: it published, or it says why it did not. */
export type DeskBatchItem = { path: string; ok: true; result: DeskResult } | { path: string; ok: false; error: string }
/** A fact the rewriting took from the code: a dependency, a route, an environment variable, a command. */
export interface DeskFact { id: string; kind: string; value: string }
/** What one rewriting did: which sections were written, and what the check found. */
export interface DeskRewrite {
  output: string
  changed: string[]
  text: string
  problems: { kind: string; detail: string }[]
  facts: DeskFact[]
  baseline?: string
  upToDate: boolean
}

/** The panel marks its own calls; the host answers only to them, and only from this machine. */
const DESK_HEADER = 'x-publish-desk'

async function call<R>(t: T, path: string, method: 'GET' | 'POST' | 'PUT', body?: unknown): Promise<R> {
  const json = body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
  let response: Response
  try {
    response = await fetch(`/feishu-publish/api/${path}`, { method, ...json, headers: { [DESK_HEADER]: '1', ...json.headers } })
  } catch {
    throw new ApiError(t('offline'), 0, { unreachable: true })
  }
  const text = await response.text()
  let value: unknown
  try { value = text ? JSON.parse(text) : {} } catch { value = undefined }
  if (!response.ok) {
    const failure = (value ?? {}) as { error?: unknown; issues?: unknown }
    const issues = Array.isArray(failure.issues) ? failure.issues as { path: string; message: string }[] : []
    // An empty 404 is the web server answering while the publishing plugin is not mounted.
    const message = typeof failure.error === 'string' && failure.error ? failure.error
      : !text && response.status === 404 ? t('deskOffline')
      : response.status >= 500 ? t('serverError', { status: response.status }) : t('requestFailed', { status: response.status })
    throw new ApiError(message, response.status, { issues, ...text ? {} : { unreachable: true } })
  }
  return value as R
}

/** The desk's calls, localized with the panel's translator. */
export const deskApi = (t: T) => ({
  roots: () => call<{ roots: DeskRoot[] }>(t, 'roots', 'GET'),
  files: (root: string) => call<{ root: string; files: DeskFile[] }>(t, `files?root=${encodeURIComponent(root)}`, 'GET'),
  file: (root: string, path: string) => call<{ root: string; path: string; content: string; modified: string }>(t,
    `file?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`, 'GET'),
  write: (root: string, path: string, content: string) => call<{ root: string; path: string; bytes: number; modified: string }>(t,
    'file', 'PUT', { root, path, content }),
  preview: (content: string) => call<DeskPreview>(t, 'preview', 'POST', { content }),
  rewrite: (root: string, path: string, force?: boolean) => call<DeskRewrite>(
    t, 'rewrite', 'POST', { root, path, ...force === undefined ? {} : { force } }),
  publish: (root: string, path: string, title?: string) => call<DeskResult>(t, 'publish', 'POST', { root, path, title }),
  publishMany: (root: string, paths: string[]) => call<{ root: string; results: DeskBatchItem[] }>(
    t, 'publish-many', 'POST', { root, paths }),
})
export type DeskApi = ReturnType<typeof deskApi>
