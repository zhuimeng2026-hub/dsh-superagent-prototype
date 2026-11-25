/**
 * 飞书开放平台 docx / drive / im 的最小客户端。
 *
 * 逐行对照 `/opt/ob-vault/37.律档通日更/飞书文档发布.py` 移植——
 * 里面的注释记着踩过的坑（type 是 query 参数、v1/v2 两套公开接口都要设、
 * 改名要 docx:document:write_only），改之前先读。
 */

const OPEN_BASE = 'https://open.feishu.cn/open-apis'

export interface Credentials {
  appId: string
  appSecret: string
}

/** 飞书接口返回的错误。带业务 code 与 msg。 */
export class FeishuError extends Error {
  readonly code: number
  readonly detail: unknown

  constructor(message: string, code: number, detail?: unknown) {
    super(message)
    this.name = 'FeishuError'
    this.code = code
    this.detail = detail
  }
}

interface ApiResponse<T = unknown> {
  code: number
  msg?: string
  data?: T
}

/**
 * 取 tenant_access_token。
 *
 * 这个接口的响应把 token 放在**顶层**，不像别的接口那样放在 `data` 里。
 */
export async function fetchTenantToken(credentials: Credentials, signal?: AbortSignal): Promise<string> {
  const json = await requestJson<ApiResponse & { tenant_access_token?: string }>(
    'POST',
    `${OPEN_BASE}/auth/v3/tenant_access_token/internal`,
    {
      body: { app_id: credentials.appId, app_secret: credentials.appSecret },
      signal,
    },
  )
  if (json.code !== 0) {
    throw new FeishuError(`获取 tenant_access_token 失败：${json.msg ?? ''}`, json.code, json)
  }
  const token = json.tenant_access_token
  if (!token) throw new FeishuError('获取 tenant_access_token 失败：响应里没有 token', json.code, json)
  return token
}

interface RequestOptions {
  body?: unknown
  query?: Record<string, string | number | boolean | undefined>
  signal?: AbortSignal
  headers?: Record<string, string>
  raw?: boolean
}

/**
 * 调一次开放平台接口。
 *
 * `raw: true` 时返回原始 Response（图片上传用 multipart，需要自己读 body）。
 */
export async function call<T = unknown>(
  token: string,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const url = new URL(path.startsWith('http') ? path : `${OPEN_BASE}${path}`)
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    ...options.headers,
  }
  const init: RequestInit = { method, headers, signal: options.signal }
  if (options.body !== undefined && !options.raw) {
    headers['Content-Type'] = 'application/json; charset=utf-8'
    init.body = JSON.stringify(options.body)
  }

  const response = await fetch(url, init)
  const text = await response.text()
  let parsed: ApiResponse
  try {
    parsed = JSON.parse(text) as ApiResponse
  } catch {
    throw new FeishuError(`飞书接口返回的不是 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`, response.status, text)
  }
  if (parsed.code !== 0) {
    throw new FeishuError(`飞书接口报错 ${parsed.code}：${parsed.msg ?? ''}`, parsed.code, parsed)
  }
  return parsed.data as T
}

/** 新建文档，返回 document_id。 */
export async function createDocument(token: string, title: string, signal?: AbortSignal): Promise<string> {
  const data = await call<{ document?: { document_id?: string } }>(
    token,
    'POST',
    '/docx/v1/documents',
    { body: { title }, signal },
  )
  const id = data.document?.document_id
  if (!id) throw new FeishuError('新建文档失败：响应里没有 document_id', 0, data)
  return id
}

/** 文档块。飞书返回的字段随块类型而变，这里保留原样。 */
export type DocBlock = {
  block_id?: string
  parent_id?: string
  block_type?: number
  [key: string]: unknown
}

/** 列出文档块。 */
export async function listBlocks(token: string, docId: string, signal?: AbortSignal): Promise<DocBlock[]> {
  const data = await call<{ items?: DocBlock[] }>(token, 'GET', `/docx/v1/documents/${docId}/blocks`, {
    query: { page_size: 500 },
    signal,
  })
  return data.items ?? []
}

/** 清空文档正文（保留根块）。 */
export async function clearDocument(token: string, docId: string, signal?: AbortSignal): Promise<void> {
  const items = await listBlocks(token, docId, signal)
  const childIds = items
    .filter(b => b.parent_id === docId && b.block_type !== 1)
    .map(b => b.block_id)
    .filter((id): id is string => Boolean(id))
  if (!childIds.length) return
  await call(token, 'DELETE', `/docx/v1/documents/${docId}/blocks/${docId}/children/batch_delete`, {
    body: { start_index: 0, end_index: childIds.length },
    signal,
  })
}

/** 追加子块，每批最多 20 个。返回创建出来的块。 */
export async function appendBlocks(
  token: string,
  docId: string,
  blocks: unknown[],
  signal?: AbortSignal,
): Promise<Array<{ block_id?: string; block_type?: number }>> {
  const out: Array<{ block_id?: string; block_type?: number }> = []
  for (let i = 0; i < blocks.length; i += 20) {
    const batch = blocks.slice(i, i + 20)
    const data = await call<{ children?: Array<{ block_id?: string; block_type?: number }> }>(
      token,
      'POST',
      `/docx/v1/documents/${docId}/blocks/${docId}/children`,
      { body: { children: batch }, signal },
    )
    out.push(...(data.children ?? []))
  }
  return out
}

/** 建一个空的图片块，返回它的 block_id。 */
export async function createImageBlock(token: string, docId: string, signal?: AbortSignal): Promise<string> {
  const children = await appendBlocks(token, docId, [{ block_type: 27, image: {} }], signal)
  const image = children.find(c => c.block_type === 27)
  if (!image?.block_id) throw new FeishuError('创建图片块失败：响应里没有 block_id', 0, children)
  return image.block_id
}

/**
 * 上传正文图，返回 file_token。
 *
 * `source` 可以是 http(s) 地址，也可以是本地文件路径。
 */
export async function uploadImage(
  token: string,
  docId: string,
  blockId: string,
  source: string,
  signal?: AbortSignal,
): Promise<string> {
  let content: ArrayBuffer
  let filename: string
  let contentType: string

  if (/^https?:\/\//.test(source)) {
    const response = await fetch(source, { signal })
    if (!response.ok) throw new FeishuError(`下载图片失败（HTTP ${response.status}）：${source}`, response.status)
    content = await response.arrayBuffer()
    filename = new URL(source).pathname.split('/').pop() || 'image'
    contentType = response.headers.get('content-type') ?? guessContentType(filename)
  } else {
    const { readFile } = await import('node:fs/promises')
    const bytes = await readFile(source)
    content = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    filename = source.split('/').pop() || 'image'
    contentType = guessContentType(filename)
  }

  const form = new FormData()
  form.set('file_name', filename)
  form.set('parent_type', 'docx_image')
  form.set('parent_node', blockId)
  form.set('size', String(content.byteLength))
  form.set('extra', JSON.stringify({ drive_route_token: docId }))
  form.set('file', new Blob([content], { type: contentType }), filename)

  const response = await fetch(`${OPEN_BASE}/drive/v1/medias/upload_all`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
    signal,
  })
  const json = (await response.json()) as ApiResponse<{ file_token?: string }>
  if (json.code !== 0) {
    throw new FeishuError(`上传图片失败：${json.msg ?? ''}`, json.code, json)
  }
  const fileToken = json.data?.file_token
  if (!fileToken) throw new FeishuError('上传图片失败：响应里没有 file_token', json.code, json)
  return fileToken
}

/** 把图片块的内容替换成已上传的素材。 */
export async function replaceImage(
  token: string,
  docId: string,
  blockId: string,
  fileToken: string,
  signal?: AbortSignal,
): Promise<void> {
  await call(token, 'PATCH', `/docx/v1/documents/${docId}/blocks/${blockId}`, {
    body: { replace_image: { token: fileToken } },
    signal,
  })
}

function guessContentType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
  }
  return map[ext] ?? 'application/octet-stream'
}

/**
 * 把链接分享设成「互联网获得链接的人可阅读」。
 *
 * 应用建的文档默认是 tenant_readable（组织内可读），外部打开会被弹到登录页。
 * v1 是老接口，v2 是新接口，两边都要设。
 * 坑：`type` 是 query 参数，放 body 里报 99992402 field validation failed。
 */
export async function setPublicReadable(
  token: string,
  docId: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  for (const version of ['v1', 'v2'] as const) {
    const body =
      version === 'v1'
        ? { external_access: true, link_share_entity: 'anyone_readable' }
        : { external_access_entity: 'open', link_share_entity: 'anyone_readable' }
    const data = await call<{ permission_public?: unknown }>(
      token,
      'PATCH',
      `/drive/${version}/permissions/${docId}/public`,
      { body, query: { type: 'docx' }, signal },
    )
    out[version] = data.permission_public
  }
  return out
}

/** 读文档成员列表。 */
export async function listMembers(
  token: string,
  docId: string,
  signal?: AbortSignal,
): Promise<Array<{ member_type?: string; member_id?: string; perm?: string }>> {
  const data = await call<{ items?: Array<{ member_type?: string; member_id?: string; perm?: string }> }>(
    token,
    'GET',
    `/drive/v1/permissions/${docId}/members`,
    { query: { type: 'docx' }, signal },
  )
  return data.items ?? []
}

/** 目标账号是不是 full_access（owner 一定是 full_access）。 */
export async function hasFullAccess(
  token: string,
  docId: string,
  openId: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const members = await listMembers(token, docId, signal)
  return members.some(m => m.member_type === 'openid' && m.member_id === openId && m.perm === 'full_access')
}

/** 读当前文档标题（空串表示读不到）。 */
export async function getDocumentTitle(token: string, docId: string, signal?: AbortSignal): Promise<string> {
  try {
    const data = await call<{ document?: { title?: string } }>(
      token,
      'GET',
      `/docx/v1/documents/${docId}`,
      { signal },
    )
    return data.document?.title ?? ''
  } catch {
    return ''
  }
}

/** 改文档标题的结果。 */
export interface SetTitleResult {
  ok: boolean
  message: string
}

/**
 * 改文档标题。
 *
 * 接口 `PATCH /drive/v1/files/{file_token}?type=docx`。
 * 坑：`type` 是 query 参数；这个接口要**单独**的 `docx:document:write_only` 权限，
 * 光有 `docx:document` 不够（报 99991672）。字段名实测 `new_title` 才对，
 * 这里按实测顺序试 `new_title` → `title` → `name`。
 */
export async function setDocumentTitle(
  token: string,
  docId: string,
  title: string,
  signal?: AbortSignal,
): Promise<SetTitleResult> {
  let last = ''
  for (const field of ['new_title', 'title', 'name'] as const) {
    try {
      await call(token, 'PATCH', `/drive/v1/files/${docId}`, {
        body: { [field]: title },
        query: { type: 'docx' },
        signal,
      })
      return { ok: true, message: `已改标题为《${title}》（字段 ${field}）` }
    } catch (error) {
      const err = error as FeishuError
      last = `${field} → ${err.code} ${(err.message ?? '').slice(0, 120)}`
      if (err.code === 99991672) break
    }
  }
  if (last.includes('99991672')) {
    return {
      ok: false,
      message: `改标题需要单独权限 docx:document:write_only（只有 docx:document 不够）。原文：${last}`,
    }
  }
  return { ok: false, message: `改标题失败：${last}` }
}

/** 所有权转移的结果。 */
export type TransferResult = 'transferred' | 'already_not_app_owner' | `failed:${string}`

/**
 * 把文档所有者转给指定 open_id（转完文档进对方空间）。
 *
 * 幂等重跑已转移的文档会走到 `already_not_app_owner`，那不算失败。
 */
export async function transferOwner(
  token: string,
  docId: string,
  openId: string,
  signal?: AbortSignal,
): Promise<TransferResult> {
  try {
    await call(token, 'POST', `/drive/v1/permissions/${docId}/members/transfer_owner`, {
      body: { member_type: 'openid', member_id: openId },
      query: { type: 'docx' },
      signal,
    })
    return 'transferred'
  } catch (error) {
    const err = error as FeishuError
    const msg = err.message ?? ''
    if (err.code === 1063001 || err.code === 1063002 || msg.includes('Permission denied') || msg.includes('无权限')) {
      return 'already_not_app_owner'
    }
    return `failed:${msg}`
  }
}

/** 给指定群发一条文本消息。 */
export async function notifyChat(
  token: string,
  chatId: string,
  text: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    await call(token, 'POST', '/im/v1/messages', {
      query: { receive_id_type: 'chat_id' },
      body: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) },
      signal,
    })
    return true
  } catch {
    return false
  }
}

/** 回读文档的结果。 */
export interface VerifyResult {
  blocks: number
  imageBlocks: number
  imagesWithToken: number
  first: string
  last: string
}

/** 回读文档：块数、图片块是否都带 token、首尾文字。 */
export async function verifyDocument(token: string, docId: string, signal?: AbortSignal): Promise<VerifyResult> {
  const items = await listBlocks(token, docId, signal)
  const images = items.filter(b => b.block_type === 27)
  const withToken = images.filter(b => Boolean((b.image as { token?: string } | undefined)?.token)).length
  const texts: string[] = []
  for (const block of items) {
    const text = textOf(block)
    if (text) texts.push(text)
  }
  return {
    blocks: items.length,
    imageBlocks: images.length,
    imagesWithToken: withToken,
    first: texts[0] ?? '',
    last: texts[texts.length - 1] ?? '',
  }
}

function textOf(block: unknown): string {
  const record = block as Record<string, unknown>
  for (const key of ['text', 'heading1', 'heading2', 'heading3', 'bullet', 'ordered']) {
    const payload = record[key] as { elements?: Array<{ text_run?: { content?: string } }> } | undefined
    if (!payload) continue
    const s = (payload.elements ?? [])
      .map(e => e.text_run?.content ?? '')
      .join('')
    if (s) return s
  }
  return ''
}

async function requestJson<T>(
  method: string,
  url: string,
  options: { body?: unknown; signal?: AbortSignal },
): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  })
  const text = await response.text()
  try {
    return JSON.parse(text) as T
  } catch {
    throw new FeishuError(`接口返回的不是 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`, response.status, text)
  }
}
