/**
 * The Feishu publishing plugin: publishes a Markdown file as a Feishu document that the internet can read.
 *
 * It registers one tool, `feishu_publish`, on every agent of the profile, and one runtime skill that
 * tells the model when to use it. The publishing itself is `/opt/ob-vault/37.律档通日更/飞书文档发布.py`
 * and `/opt/ob-vault/14.待办事务/生成飞书发布版.py` ported to TypeScript, under `src/feishu/`.
 *
 * Publishing to the internet cannot be taken back. The plugin's configuration is the fence:
 * `publish` decides whether a document may become publicly readable at all, and `chatIds` decides
 * which groups may be told about it. The tool reads both and can only act within them.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, isAbsolute, join, resolve } from 'node:path'
import s from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { CUT_MARKERS } from './feishu/markdown.ts'
import { publish, resolveCredentials } from './feishu/publish.ts'
import { registerDeskHttp } from './feishu/desk-http.ts'
import { deskRelative, deskRoots, ensureInsideRoot } from './feishu/desk.ts'
import { fileDeskStore } from './feishu/desk-store.ts'
import { rewriteDocument, stripFrontmatter } from './feishu/rewrite.ts'
import { packagePath } from './infra/paths.ts'

/** The name of the tool the plugin registers on every agent. */
export const TOOL_NAME = 'feishu_publish'

/** The name of the runtime skill the plugin registers. */
export const SKILL_NAME = 'dsh-superagent-feishu-publish'

/** The plugin's id, which the bundle's patch inserts. */
export const name = 'dsh-superagent-feishu-publish'

/** The services the plugin needs. */
export const inject = ['agents', 'skills', 'webServer']

/**
 * 一个项目的改写规则，和它管的目录。
 *
 * 类型写在这里，是为了让导出的配置类型能被写出来：schemastery 推断出来的
 * 嵌套对象带一个别处的 `Dict`，声明文件写不出它的名字。
 */
export interface ProjectRules {
  /** 管哪些文档：这些目录底下的 Markdown。 */
  root: string
  /** 改写规则文件，按顺序读，合成一段喂给写稿模型。 */
  rules: string[]
}

const projectRules: s<ProjectRules> = s.object({ root: s.string(), rules: s.array(s.string()) })

/** The plugin's configuration. Every key has a default, so an enabled plugin needs no configuration. */
export const Config = s.object({
  profile: s.string().default('personal')
    .description('The entry of the credentials file to publish with; "personal" publishes to the personal tenant.'),
  profilesFile: s.string().default('')
    .description('Path of the credentials file; empty means ~/.config/feishu-profiles.json.'),
  publish: s.boolean().default(true)
    .description('Whether a published document may become readable by anyone with the link.'),
  transferOwner: s.boolean().default(true)
    .description('Whether the document owner becomes the personal account named by the credentials file.'),
  chatIds: s.array(s.string()).default([])
    .description('The groups a published document may be announced in; empty means no group is told.'),
  timeoutMs: s.number().default(300000)
    .description('Time limit of one publication, in milliseconds.'),
  cutMarkers: s.array(s.string()).default([...CUT_MARKERS])
    .description('Headings from which the tail of the Markdown is dropped before publishing; empty keeps the whole file.'),
  desk: s.boolean().default(true)
    .description('Whether the publishing desk answers the panel: it lists, reads, writes and publishes Markdown files.'),
  rewrite: s.boolean().default(true)
    .description('Whether the panel may turn a document into a plain-language version with a model, next to it as *.飞书版.md.'),
  rewriteModel: s.string().default('group/dsh')
    .description('The model that writes the plain-language version, named as the gateway knows it.'),
  rewriteBaseUrl: s.string().default('http://127.0.0.1:3425/v1')
    .description('The OpenAI-compatible gateway the rewriting model is reached at.'),
  rewriteKeyEnv: s.string().default('MAGPIE_GATEWAY_KEY')
    .description('The name of the key the gateway wants; taken from the process environment, or from the credentials file.'),
  rewriteCredentials: s.string().default('')
    .description('Where the key named by rewriteKeyEnv is looked up when the process has no such variable; empty means ~/.dsh/.credentials.yaml.'),
  rewriteStyle: s.string().default('')
    .description('A document whose style the plain-language version follows; empty means the previous version of the same document.'),
  rewriteRules: s.array(s.string()).default([])
    .description('The rewrite rules that tell the plain-language version what to write and what to leave out; '
      + 'they are read in order and given to the model as one block, before the rules of the project. '
      + 'Empty means only the built-in rules.'),
  rewriteRulesByRoot: s.array(projectRules).default([])
    .description('The rewrite rules of a project, by the directory whose documents they govern: a document under '
      + 'that directory also gets those rules, after the general ones. A document under no listed directory gets '
      + 'only the general rules. Each entry names the directory in `root` and its rule files in `rules`.'),
  rewriteTimeoutMs: s.number().default(180000)
    .description('Time limit of one rewriting, in milliseconds.'),
  roots: s.array(s.string()).default([])
    .description('The directories the desk may open; the working directory of the process is always one of them.'),
  deskStoreFile: s.string().default('')
    .description('Where the desk remembers which document it published for which file; empty means ~/.config/feishu-publish-desk.json.'),
})
export type PublishConfig = ReturnType<typeof Config>

/**
 * 一篇文档受哪几份规则管：先通用的，再它所在项目的那份。
 *
 * 项目规则按目录限定，是有意的：甲项目的口径不该管乙项目的文档。一份写着
 * 「本文件优先」的规则要是没有范围，就会压住发布台碰到的每一篇文档。
 */
export function rewriteRulePaths(file: string, config: PublishConfig): string[] {
  const paths = [...config.rewriteRules]
  let owner: string[] = []
  let ownerPath = ''
  for (const entry of config.rewriteRulesByRoot) {
    const absolute = resolve(entry.root)
    if ((file === absolute || file.startsWith(`${absolute}/`)) && absolute.length > ownerPath.length) {
      owner = entry.rules
      ownerPath = absolute
    }
  }
  return [...paths, ...owner]
}

const Arguments = z.object({
  file: z.string().min(1)
    .describe('The Markdown file to publish; a relative path resolves against the session working directory.'),
  title: z.string().optional()
    .describe('The document title; without it the first heading of the Markdown becomes the title.'),
  doc_id: z.string().optional()
    .describe('An existing document to rebuild; with it the document is cleared and filled again, and its link stays the same.'),
  chat_id: z.string().optional()
    .describe('The group to announce the document in; it must be one of the groups the configuration allows.'),
})

/** The skill's packaged text, with its frontmatter parsed. */
interface SkillText { name: string; description: string; content: string }

/** Read the packaged skill. */
function readSkill(): SkillText {
  const text = readFileSync(packagePath('skills', SKILL_NAME, 'SKILL.md'), 'utf-8')
  const match = /^---\nname: ([^\n]+)\ndescription: ([^\n]+)\n---\n\n([\s\S]*)$/.exec(text)
  if (!match) throw new Error(`packaged skill ${SKILL_NAME} has no frontmatter`)
  return { name: match[1]!, description: match[2]!, content: match[3]! }
}

/**
 * 找模型网关的钥匙。
 *
 * 先看进程的环境变量——那是最直接的。宿主没有这个变量时（DSH 的进程环境
 * 是干净的），就从凭据文件的 `refs` 段里找：那里存着这台机器给各个网关
 * 准备的钥匙，名字与变量名相同。
 */
export async function resolveGatewayKey(envName: string, credentialsFile: string): Promise<string> {
  const fromEnv = process.env[envName]
  if (fromEnv) return fromEnv
  const file = credentialsFile || join(homedir(), '.dsh', '.credentials.yaml')
  const raw = await readFile(file, 'utf-8').catch(() => undefined)
  if (!raw) throw new Error(`没有 ${envName} 这个环境变量，也读不了凭据文件 ${file}`)
  const block = /^refs:\n((?:[ \t]+.*\n?)*)/m.exec(raw)?.[1] ?? ''
  const line = block.split('\n').find(item => item.trim().startsWith(`${envName}:`))
  const value = line ? line.slice(line.indexOf(':') + 1).trim().replace(/^["']|["']$/g, '') : ''
  if (!value) throw new Error(`凭据文件 ${file} 里没有 ${envName}`)
  return value
}

/** Register the plugin: one tool on every agent, one skill for every session. */
export function apply(ctx: Context, config: PublishConfig): void {
  const disposers = new Map<Agent, () => void>()
  /** 这个插件发过的文档。工具重建文档时只认这里记下的 id。 */
  const store = fileDeskStore(config.deskStoreFile || undefined)

  /** 一个能重建的 document_id；不是这个插件发的就说不清是「不许」还是「没这回事」。 */
  const rebuildable = (docId: string): string => {
    if (!store.published(docId)) {
      throw new Error(`the document ${docId} was not published by this plugin, so it is not rebuilt; `
        + 'publish without doc_id to create a new one, or rebuild a document this plugin published before')
    }
    return docId
  }

  ctx.on('agent/disposed', ({ agent }) => {
    disposers.get(agent)?.()
    disposers.delete(agent)
  })

  ctx.on('agent/created', ({ agent }) => {
    const disposer = agent.ctx.tools.register({
      name: TOOL_NAME,
      description: 'Publishes a Markdown file as a Feishu document that anyone with the link can read, '
        + 'and returns its link. The document is public on the internet and cannot be un-published silently: '
        + 'publish only what the person asked for, and never a file that holds a credential, an account or an internal address. '
        + 'Give doc_id to rebuild a document that already exists, so its link stays the same.',
      parameters: z.toJSONSchema(Arguments),
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      timeoutMs: config.timeoutMs,
      execute: async (args, execution) => {
        const parsed = Arguments.parse(args)
        const credentials = await resolveCredentials({
          profile: config.profile,
          profilesFile: config.profilesFile || undefined,
        })
        const chatIds = config.chatIds.length ? config.chatIds : []
        if (parsed.chat_id && !chatIds.includes(parsed.chat_id)) {
          throw new Error(`the group ${parsed.chat_id} is not one this profile may announce a document in`)
        }
        // 和发布台同一道栅栏：只发根目录里的 Markdown。工具的参数来自模型，而模型的
        // 输入里有别人写的 issue 正文——不加这道，一句被注入的话就能让它把口令文件发出去。
        const roots = deskRoots(config.roots, process.cwd())
        const cwd = String(agent.session.header.cwd ?? process.cwd())
        const file = isAbsolute(parsed.file) ? parsed.file : resolve(cwd, parsed.file)
        let real: string | undefined
        for (const root of roots) {
          real ??= await ensureInsideRoot(root.path, file).catch(() => undefined)
        }
        if (real === undefined) {
          throw new Error(`the file ${parsed.file} is not inside a directory this plugin may publish from: ${roots.map(root => root.path).join(', ')}`)
        }
        if (extname(real).toLowerCase() !== '.md') {
          throw new Error(`only a Markdown file can be published; ${parsed.file} is not one`)
        }
        // 只有这个插件自己发的文档可以重建：不给这个模块之外的 document_id 开重建的口子。
        const docId = parsed.doc_id === undefined ? undefined : rebuildable(parsed.doc_id)
        const result = await publish({
          file: real,
          title: parsed.title,
          docId,
          publish: config.publish,
          transferOwner: config.transferOwner,
          chatIds: parsed.chat_id ? [parsed.chat_id] : [],
          cut: config.cutMarkers,
          cwd,
          signal: execution.signal,
        }, credentials)
        if (!result.rebuilt) store.remember({ docId: result.doc_id, at: new Date().toISOString() })
        return { ...result, credential_source: credentials.source }
      },
    })
    disposers.set(agent, disposer)
  })

  // The skill goes to the global layer, so every agent of the profile sees it: a worker publishes a
  // document as well as the main Session does.
  ctx.inject(['skills'], scope => {
    const skill = readSkill()
    scope.effect(() => scope.skills.register({
      name: skill.name,
      description: skill.description,
      content: skill.content,
      source: 'runtime',
    }), 'feishu-publish: skill')
  })

  // The desk answers the panel: the files a document is made of, their preview, and the publication
  // itself. It hangs off the host's own Web server, on the loopback, behind the panel's marker header.
  if (config.desk) {
    ctx.inject(['webServer'], scope => {
      const roots = () => deskRoots(config.roots, process.cwd())
      // The desk injects its own document ids, and each was published by this plugin; the member check
      // in publish() covers a record that outlived the document.
      scope.effect(() => registerDeskHttp(scope, {
        roots,
        port: () => scope.webServer.port,
        // The configuration is the fence: the panel cannot make a document more public than it is, and no group is told.
        cut: () => config.cutMarkers,
        store: () => store,
        // 把一份文档改写成通俗版：事实由代码抽，文案由模型写，写完还有一道检查。
        rewrite: async input => {
          if (!config.rewrite) throw new Error('这个插件没有开启改写（配置里的 rewrite）')
          const key = await resolveGatewayKey(config.rewriteKeyEnv, config.rewriteCredentials)
          const style = config.rewriteStyle
            ? stripFrontmatter(await readFile(config.rewriteStyle, 'utf-8').catch(() => undefined) ?? '')
            : undefined
          // 改写规则文件读不到是配置错了，要说清楚；悄悄跳过等于让模型按旧口径写。
          const ruleTexts: string[] = []
          for (const path of rewriteRulePaths(input.file, config)) {
            const text = await readFile(path, 'utf-8').catch(() => undefined)
            if (text === undefined) throw new Error(`读不了改写规则文件 ${path}`)
            const body = stripFrontmatter(text).trim()
            if (body) ruleTexts.push(body)
          }
          return rewriteDocument({
            file: input.file,
            style,
            rules: ruleTexts.join('\n\n'),
            force: input.force,
            model: {
              baseUrl: config.rewriteBaseUrl,
              apiKey: key,
              model: config.rewriteModel,
              timeoutMs: config.rewriteTimeoutMs,
            },
          })
        },
        publish: async input => {
          const result = await publish({
            file: input.file,
            title: input.title,
            docId: input.docId,
            publish: config.publish,
            transferOwner: config.transferOwner,
            chatIds: [],
            cut: config.cutMarkers,
            cwd: process.cwd(),
            signal: AbortSignal.timeout(config.timeoutMs),
          }, await resolveCredentials({
            profile: config.profile,
            profilesFile: config.profilesFile || undefined,
          }))
          if (!result.rebuilt) {
            const root = roots().find(candidate => input.file.startsWith(`${candidate.path}/`))
            if (root) store.remember({ docId: result.doc_id, root: root.path, path: deskRelative(root.path, input.file), at: new Date().toISOString() })
          }
          return result
        },
      }), 'feishu-publish: desk')
    })
  }
}
