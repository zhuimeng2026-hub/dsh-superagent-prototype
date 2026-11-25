/**
 * 「把一篇 Markdown 发成飞书文档」的编排层。
 *
 * 流程与 `/opt/ob-vault/37.律档通日更/飞书文档发布.py` 的 `main` 一致：
 * 取凭据 → 建文档或清空重建 → 同步标题 → 分批入块（图片单独建块上传）
 * → 公开可读 → 转所有者 → 可选发群 → 回读核对。
 */

import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { homedir } from 'node:os'
import {
  appendBlocks,
  createDocument,
  createImageBlock,
  clearDocument,
  fetchTenantToken,
  getDocumentTitle,
  hasFullAccess,
  listMembers,
  notifyChat,
  replaceImage,
  setDocumentTitle,
  setPublicReadable,
  transferOwner,
  uploadImage,
  verifyDocument,
  type Credentials,
  FeishuError,
} from './client.js'
import { parseMarkdown, prepareMarkdown, resolveDocTitle, toBlocks } from './markdown.js'

/** 一套租户凭据。open_id 与 token 都是「应用 × 租户」维度的。 */
export interface Profile {
  app_id?: string
  app_secret?: string
  owner_open_id?: string
}

/** 凭据文件（`~/.config/feishu-profiles.json`）的内容。 */
export type ProfileFile = Record<string, Profile>

export interface PublishOptions {
  /**
   * Markdown 文件路径。相对路径按 `cwd` 解析。
   *
   * 必须是**根目录里**的文件：插件会把工具给出的路径也按同一套规则检查，
   * 免得被指使着把口令文件发出去。
   */
  file: string
  /** 文档标题。不传就取 Markdown 的第一个 H1。 */
  title?: string
  /**
   * 已有文档的 document_id。给了就**清空重建**（链接不变）。
   *
   * 只能重建**这个应用自己建过**的文档：`publish` 会先核对成员列表，应用不在
   * 其中就拒绝，免得一条被指使着发的指令清空并公开别人的文档。
   */
  docId?: string
  /** 是否设成「互联网获得链接的人可阅读」。默认 true。 */
  publish?: boolean
  /** 要通知的群。空数组表示不通知。 */
  chatIds?: string[]
  /** 是否把所有者转给个人账号。默认 true。 */
  transferOwner?: boolean
  /** 绝对路径或相对路径（相对 `cwd`）。 */
  cwd?: string
  /** 命中任一标记时，从那一行起删到文末。空数组保留全文。 */
  cut?: string[]
  signal?: AbortSignal
}

export interface PublishResult {
  doc_url: string
  doc_id: string
  title: string
  blocks: number
  /** 正文块的数量。飞书的回读把文档自己的根块也算进去，面板显示的是**内容**块。 */
  contentBlocks: number
  imageBlocks: number
  images: number
  owner: string
  chatNotified: string[]
  rebuilt: boolean
  /** 这次真的把公开设置过一遍。没设（`publish: false`）时是 `null`，别把它当失败。 */
  madePublic: boolean | null
}

/** 读取凭据文件。读不到就当空。 */
export async function loadProfiles(profilesFile?: string): Promise<ProfileFile> {
  const path = profilesFile ?? resolve(homedir(), '.config', 'feishu-profiles.json')
  try {
    const text = await readFile(path, 'utf-8')
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    return parsed as ProfileFile
  } catch {
    return {}
  }
}

/**
 * 解析凭据。
 *
 * 优先级：凭据文件里指定的 profile > 环境变量 `FEISHU_APP_ID` + `FEISHU_APP_SECRET`。
 * 配置文件优先，是因为 profile 决定**哪个租户**：飞书的 open_id / token 都是
 * 「应用 × 租户」维度的，公司租户的自建应用**无法**在个人租户里建文档；
 * 而这台机器的环境变量里常留着公司的应用，凭它发就会发错租户。
 *
 * 要换租户就换 profile（`company` / `personal`），不要改环境变量。
 */
export async function resolveCredentials(options: {
  profile?: string
  profilesFile?: string
  env?: Record<string, string | undefined>
}): Promise<{ source: string; credentials: Credentials; ownerOpenId: string }> {
  const env = options.env ?? process.env
  const name = options.profile ?? 'personal'
  const profiles = await loadProfiles(options.profilesFile)
  const profile = profiles[name]

  if (profile?.app_id && profile.app_secret) {
    return {
      source: `profile:${name}`,
      credentials: { appId: profile.app_id, appSecret: profile.app_secret },
      ownerOpenId: (profile.owner_open_id ?? env.FEISHU_OPEN_ID ?? '').trim(),
    }
  }

  const envId = (env.FEISHU_APP_ID ?? '').trim()
  const envSecret = (env.FEISHU_APP_SECRET ?? '').trim()
  if (envId && envSecret) {
    return {
      source: 'env',
      credentials: { appId: envId, appSecret: envSecret },
      ownerOpenId: (env.FEISHU_OPEN_ID ?? '').trim(),
    }
  }

  if (!profile) {
    const available = Object.keys(profiles)
    throw new Error(
      `profile ${JSON.stringify(name)} 不在凭据文件里，现有的：${available.join(', ') || '(空)'}。` +
        '也可以设 FEISHU_APP_ID / FEISHU_APP_SECRET 环境变量。',
    )
  }
  const missing = (['app_id', 'app_secret'] as const).filter(k => !profile[k])
  throw new Error(`profile ${JSON.stringify(name)} 缺字段：${missing.join(', ')}`)
}

/** 租户无关的文档链接。 */
export function docUrl(docId: string): string {
  return `https://my.feishu.cn/docx/${docId}`
}

/**
 * 发布一篇 Markdown 到飞书。
 *
 * 返回文档链接、块数、图片数与所有者状态。
 */
export async function publish(
  options: PublishOptions,
  resolved: { source: string; credentials: Credentials; ownerOpenId: string },
): Promise<PublishResult> {
  const cwd = options.cwd ?? process.cwd()
  const path = isAbsolute(options.file) ? options.file : resolve(cwd, options.file)
  const markdown = await readFile(path, 'utf-8')
  const base = path.slice(0, path.lastIndexOf('/')) || cwd

  const prepared = options.cut ? prepareMarkdown(markdown, { cut: options.cut }) : prepareMarkdown(markdown)
  const title = options.title?.trim() || resolveDocTitle(prepared)
  const signal = options.signal

  const token = await fetchTenantToken(resolved.credentials, signal)

  // 文档是谁的，先于一切：重建一篇不是这个应用建的文档，等于让指使发指令的人
  // 清空并公开别人的一篇文档。
  let owned = false
  if (options.docId) {
    owned = await canRebuild(token, options.docId, signal)
    if (!owned) {
      throw new FeishuError(
        `文档 ${options.docId} 不是这个应用建的，不能重建。应用不在它的协作者里。`, 1063004, undefined,
      )
    }
  }

  const rebuilt = Boolean(options.docId)
  let docId = options.docId ?? (await createDocument(token, title, signal))
  if (options.docId) {
    await clearDocument(token, docId, signal)
    const current = await getDocumentTitle(token, docId, signal)
    if (current && current !== title) {
      const result = await setDocumentTitle(token, docId, title, signal)
      if (!result.ok) {
        throw new Error(result.message)
      }
    }
  }

  const items = parseMarkdown(prepared)
  let pending: unknown[] = []
  let images = 0

  const flush = async (): Promise<void> => {
    if (!pending.length) return
    await appendBlocks(token, docId, pending, signal)
    pending = []
  }

  for (const item of items) {
    if (item.kind === 'image') {
      await flush()
      const blockId = await createImageBlock(token, docId, signal)
      const source = /^https?:\/\//.test(item.value) ? item.value : resolve(base, item.value)
      try {
        const fileToken = await uploadImage(token, docId, blockId, source, signal)
        await replaceImage(token, docId, blockId, fileToken, signal)
        images++
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await appendBlocks(token, docId, [
          { block_type: 2, text: { elements: [{ text_run: { content: `［图片：${source.split('/').pop()}］` } }] } },
        ], signal)
        throw new Error(`图片上传失败：${message}`)
      }
      continue
    }
    pending.push(...toBlocks([item]))
  }
  await flush()

  let madePublic: boolean | null = null
  if (options.publish !== false) {
    await setPublicReadable(token, docId, signal)
    madePublic = true
  }

  let owner = 'skipped'
  const ownerOpenId = resolved.ownerOpenId
  if (options.transferOwner !== false && ownerOpenId) {
    const result = await transferOwner(token, docId, ownerOpenId, signal)
    if (result === 'transferred') {
      owner = '本人所有'
    } else if (result === 'already_not_app_owner') {
      owner = (await hasFullAccess(token, docId, ownerOpenId, signal))
        ? '本人所有（已是 owner，应用无权再转）'
        : '⚠️ owner 已是别的用户，应用转不了'
    } else {
      throw new Error(`转移所有者失败：${result}`)
    }
  }

  const chatNotified: string[] = []
  const url = docUrl(docId)
  for (const chatId of options.chatIds ?? []) {
    const ok = await notifyChat(token, chatId, `${title}\n${url}`, signal)
    if (ok) chatNotified.push(chatId)
  }

  const verified = await verifyDocument(token, docId, signal)

  return {
    doc_url: url,
    doc_id: docId,
    title,
    blocks: verified.blocks,
    // 回读里包括文档自己的根块，那是容器不是内容。
    contentBlocks: Math.max(0, verified.blocks - 1),
    imageBlocks: verified.imageBlocks,
    images,
    owner,
    chatNotified,
    rebuilt,
    madePublic,
  }
}

/**
 * 这个应用能不能重建这篇文档：它得是文档的协作者。
 *
 * 应用建过的文档，成员列表里一定有这个应用的 appid；不是它建的（或者根本不是
 * 一篇文档）会报 1063004「User has no share permission」或别的 code，一律当作不行。
 */
async function canRebuild(token: string, docId: string, signal?: AbortSignal): Promise<boolean> {
  let members: Array<{ member_type?: string; member_id?: string }>
  try {
    members = await listMembers(token, docId, signal)
  } catch {
    return false
  }
  return members.some(member => member.member_type === 'appid')
}
