/**
 * 发布台的 HTTP 接口：面板用它列文件、读写文件、看预览、发文档。
 *
 * 只挂在回环地址上，而且要求面板自己加的标记头——和 `src/app/http.ts`
 * 的管理接口一个路子，但**不共用**它：管理接口属于编排器，这里属于插件。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { DeskError, deskRelative, deskRoots, listDeskFiles, previewDeskContent, readDeskFile, resolveDeskPath, writeDeskFile, type DeskRoot } from './desk.ts'
import type { DeskStore } from './desk-store.ts'
import type { PublishResult } from './publish.ts'
import { isRewriteArtifact, type RewriteResult } from './rewrite.ts'

/** 面板请求要带的标记头，值固定为 `1`。 */
export const DESK_HEADER = 'x-publish-desk'

/** 一次请求能带多少正文。 */
const MAX_BODY = 4 * 1024 * 1024

/**
 * 发布台需要宿主提供的四件事。
 *
 * 面板**不能**扩大这些：公开与否、转不转所有者、通知哪个群，都由插件的
 * 配置说了算（那才是栅栏），这里只给出配置已经允许的那一份。
 */
export interface DeskHost {
  /** 面板能打开的根目录。 */
  roots(): DeskRoot[]
  /** 发一篇文档。`docId` 只由这个模块自己给：它记得自己发过什么。 */
  publish(input: { file: string; title?: string; docId?: string }): Promise<PublishResult>
  /** 面板的端口，用来校验同源。 */
  port(): number
  /** 发布前截断正文的标记，与真正发布时用的同一份。 */
  cut(): readonly string[]
  /** 记住哪篇文件发到了哪一篇文档。 */
  store(): DeskStore
  /** 把一份文档改写成通俗版，产物写在它旁边。宿主不做这件事时就没有它。 */
  rewrite?(input: { file: string; force?: boolean }): Promise<RewriteResult>
}

const FileQuery = z.object({ root: z.string().min(1), path: z.string().min(1) })
const WriteBody = z.object({ root: z.string().min(1), path: z.string().min(1), content: z.string() })
const PreviewBody = z.object({ content: z.string() })
const PublishBody = z.object({
  root: z.string().min(1),
  path: z.string().min(1),
  title: z.string().optional(),
})
const PublishManyBody = z.object({
  root: z.string().min(1),
  paths: z.array(z.string().min(1)).min(1).max(50),
})
const RewriteBody = z.object({
  root: z.string().min(1),
  path: z.string().min(1),
  force: z.boolean().optional(),
})

/** 一次最多同时发几篇文档。飞书的接口按篇计费，太多并发只会互相拖慢。 */
export const MAX_PARALLEL_PUBLISH = 4

/** 一条路由的输入。 */
interface Call {
  query: Record<string, string | undefined>
  body: (maxBytes?: number) => Promise<unknown>
}

type Route = (call: Call) => Promise<unknown>

/** 面板能用的接口。 */
export function deskRoutes(host: DeskHost): Record<string, Route> {
  const rootOf = (path: string | undefined): DeskRoot => {
    const roots = host.roots()
    const found = roots.find(root => root.path === path)
    if (!found) throw new DeskError(403, `根目录不在允许的列表里：${path ?? ''}`)
    return found
  }

  /**
   * 这个模块发过的文档，由宿主给的记忆保存。
   *
   * 只有这里记得的文档可以被重建。面板不能自己给一个 document_id——
   * 那等于让它清空并改写这台机器碰得到的任何一篇飞书文档。
   */
  const published = host.store()

  return {
    'GET roots': async () => ({ roots: host.roots() }),
    'GET files': async ({ query }) => {
      const root = rootOf(query.root)
      const files = await listDeskFiles(root.path)
      // Each file carries the document this desk published for it, so the panel knows what a second publication rebuilds.
      return { root: root.path, files: files.map(file => ({ ...file, doc_id: published.get(root.path, file.path) })) }
    },
    'GET file': async ({ query }) => {
      const parsed = FileQuery.parse(query)
      const root = rootOf(parsed.root)
      return { root: root.path, ...(await readDeskFile(root.path, parsed.path)) }
    },
    'PUT file': async ({ body }) => {
      const parsed = WriteBody.parse(await body(MAX_BODY))
      const root = rootOf(parsed.root)
      return { root: root.path, ...(await writeDeskFile(root.path, parsed.path, parsed.content)) }
    },
    'POST preview': async ({ body }) => {
      const parsed = PreviewBody.parse(await body(MAX_BODY))
      // 与真正发布走同一份截断标记，所以预览就是飞书上会看到的。
      return previewDeskContent(parsed.content, host.cut())
    },
    // 把一篇文档改写成通俗版。产物写在原文旁边，所以它也在根目录里，可以直接发布。
    'POST rewrite': async ({ body }) => {
      const parsed = RewriteBody.parse(await body(MAX_BODY))
      const root = rootOf(parsed.root)
      if (!host.rewrite) throw new DeskError(400, '这个插件没有开启改写')
      // 产物不是源文件：拿改写产物再改写一遍，只会多出一层后缀。
      if (isRewriteArtifact(parsed.path)) throw new DeskError(400, `${parsed.path} 是改写产物，不是源文件。要改写的是源文件。`)
      const file = resolveDeskPath(root.path, parsed.path)
      await readDeskFile(root.path, parsed.path)
      const result = await host.rewrite({ file, force: parsed.force })
      // 产物在根目录里，用相对路径回去，面板才能直接打开它。
      return { root: root.path, ...result, output: deskRelative(root.path, result.output) }
    },
    // Several documents publish at once, each in its own turn of the pool; one failure does not stop the others.
    'POST publish-many': async ({ body }) => {
      const parsed = PublishManyBody.parse(await body(MAX_BODY))
      const root = rootOf(parsed.root)
      // 每个文件带自己的序号：几篇同时发，答案按面板点选的顺序回去，不按谁先发完。
      const queue = parsed.paths.map((path, index) => ({ path, index }))
      const results: ({ path: string; ok: true; result: PublishResult } | { path: string; ok: false; error: string })[] = []
      const worker = async (): Promise<void> => {
        const job = queue.shift()
        if (job === undefined) return
        try {
          const file = resolveDeskPath(root.path, job.path)
          await readDeskFile(root.path, job.path)
          // The key is the canonical relative path, so `./a.md` and `a.md` are the same document.
          const key = deskRelative(root.path, file)
          const result = await host.publish({ file, docId: published.get(root.path, key) })
          published.set(root.path, key, result.doc_id)
          results[job.index] = { path: job.path, ok: true, result }
        } catch (error) {
          results[job.index] = { path: job.path, ok: false, error: error instanceof Error ? error.message : String(error) }
        }
        await worker()
      }
      await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL_PUBLISH, queue.length) }, worker))
      return { root: root.path, results }
    },
    'POST publish': async ({ body }) => {
      const parsed = PublishBody.parse(await body(MAX_BODY))
      const root = rootOf(parsed.root)
      const file = resolveDeskPath(root.path, parsed.path)
      await readDeskFile(root.path, parsed.path)
      // The key is the canonical relative path, so `./a.md` and `a.md` are the same document.
      const key = deskRelative(root.path, file)
      const result = await host.publish({
        file,
        title: parsed.title,
        docId: published.get(root.path, key),
      })
      published.set(root.path, key, result.doc_id)
      return result
    },
  }
}

/**
 * 面板的请求必须来自本机，带标记头，而且不带别处的来源。
 *
 * 与编排器的管理接口同一个规矩（`src/app/http.ts`）：来源要么没有，
 * 要么就是本机那个地址。网关把 Origin 清掉，所以从内网进来也算数。
 */
export function sameDeskOrigin(req: Pick<IncomingMessage, 'headers'>, port: number): boolean {
  const host = req.headers.host
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false
  const origin = req.headers.origin
  if (origin !== undefined && origin !== '' && origin !== `http://${host}`) return false
  return req.headers[DESK_HEADER] === '1'
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(value))
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > maxBytes) throw new DeskError(400, `请求体超过 ${maxBytes} 字节`)
    chunks.push(bytes)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf-8')) as unknown
  } catch {
    throw new DeskError(400, '请求体不是 JSON')
  }
}

function match(table: Record<string, Route>, method: string, segments: string[]): { route: Route; params: Record<string, string> } | undefined {
  for (const [pattern, route] of Object.entries(table)) {
    const [verb, path] = pattern.split(' ') as [string, string]
    if (verb !== method) continue
    const parts = path.split('/')
    if (parts.length !== segments.length) continue
    const params: Record<string, string> = {}
    let matched = true
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i] ?? ''
      const segment = segments[i] ?? ''
      if (part.startsWith(':')) {
        try {
          params[part.slice(1)] = decodeURIComponent(segment)
        } catch {
          throw new DeskError(400, '路径的写法不对')
        }
      }
      else if (part !== segment) { matched = false; break }
    }
    if (matched) return { route, params }
  }
  return undefined
}

/** 把发布台挂在宿主 Web 服务上。 */
export function registerDeskHttp(ctx: Context, host: DeskHost): () => void {
  const table = deskRoutes(host)
  // A host without the Web service has no panel to answer; the desk stays out of the way.
  if (!ctx.webServer?.register) return () => {}
  const dispose = ctx.webServer.register({
    kind: 'prefix',
    path: '/feishu-publish',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (!url.pathname.startsWith('/feishu-publish/api/')) {
        res.writeHead(404)
        res.end()
        return
      }
      if (!sameDeskOrigin(req, host.port())) {
        json(res, 403, { error: '发布台的请求必须来自本机的面板' })
        return
      }
      try {
        const matched = match(table, req.method ?? 'GET', url.pathname.slice('/feishu-publish/api/'.length).split('/'))
        if (!matched) throw new DeskError(404, '没有这个接口')
        const query = Object.fromEntries(url.searchParams) as Record<string, string | undefined>
        const value = await matched.route({ query, body: maxBytes => readBody(req, maxBytes ?? MAX_BODY) })
        json(res, 200, value)
      } catch (error) {
        if (error instanceof DeskError) json(res, error.code, { error: error.message })
        else if (error instanceof z.ZodError) json(res, 400, { error: '参数不对', issues: error.issues })
        else json(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  })
  return dispose
}

/** 宿主给的根目录清单，带上运行目录。 */
export function rootsOf(configured: readonly string[], cwd: string): DeskRoot[] {
  return deskRoots(configured, cwd)
}
