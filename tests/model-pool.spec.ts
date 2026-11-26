import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 009 Model pool describes the pool this deployment runs on: the models the
 * two pools serve, and the routing groups the agents pick from. It is a
 * property of the machine, not of the bundle, so these checks read the
 * machine's own magpie configuration and are skipped where there is none.
 */
const ROOT = join(homedir(), '.config', 'magpie')
const PROVIDERS = join(ROOT, 'providers.json')
const SETTINGS = join(ROOT, 'settings.json')
const CLAUDE = join(homedir(), '.claude', 'settings.json')
const present = existsSync(PROVIDERS)
const read = (path: string): string => readFileSync(path, 'utf8')
const doc = read(join(process.cwd(), 'docs', '009-model-pool.md'))

interface Provider { id: string; models?: string[] }
interface Group { id?: string; name?: string; members?: string[]; unlists?: boolean }
interface Catalog { providers?: Provider[]; groups?: Group[] }
interface MagpieSettings { visible?: Record<string, string[]> }
interface ClaudeSettings { modelPicker?: { options?: { model: string; label?: string }[] } }

/** The rows of the group table in 009: the group id and its members. */
function table(): { id: string; members: string[] }[] {
  const lines = doc.split('\n')
  const start = lines.findIndex(line => line.startsWith('## Routing groups'))
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '))
  const rows = lines.slice(start, end < 0 ? undefined : end).filter(line => line.startsWith('| `group/'))
  return rows.map(row => {
    const cells = row.split('|').slice(1, -1).map(cell => cell.trim())
    const members = [...(cells[1] ?? '').matchAll(/`([^`]+)`/g)].map(match => match[1]!)
    return { id: (cells[0] ?? '').replace(/`/g, ''), members }
  })
}

/** The models magpie's catalog lists, by the pool that serves them. */
function models(): string[] {
  const catalog = JSON.parse(read(PROVIDERS)) as Catalog
  return (catalog.providers ?? []).flatMap(provider => (provider.models ?? []).map(model => `${provider.id}/${model}`))
}

/** The models a group keeps out of the agents' lists (listed=no). */
function unlisted(): string[] {
  const catalog = JSON.parse(read(PROVIDERS)) as Catalog
  return (catalog.groups ?? [])
    .filter(group => group.unlists)
    .flatMap(group => group.members ?? [])
}

describe('009 Model pool', () => {
  it('names every routing group the machine has, and no group it does not', () => {
    if (!present) return
    const catalog = JSON.parse(read(PROVIDERS)) as Catalog
    const live = (catalog.groups ?? [])
      .filter(group => group.members?.length)
      .map(group => `group/${group.id ?? group.name}`)
      .sort()
    expect(table().map(row => row.id).sort()).toEqual(live)
  })
  it('names each group the way the machine has it', () => {
    if (!present) return
    const catalog = JSON.parse(read(PROVIDERS)) as Catalog
    const live = new Map((catalog.groups ?? [])
      .filter(group => group.members?.length)
      .map(group => [`group/${group.id ?? group.name}`, group.members!]))
    for (const row of table()) {
      expect(live.get(row.id)).toEqual(row.members)
    }
  })
  it('counts the models the machine serves, and counts them right', () => {
    if (!present) return
    const listed = models()
    const said = doc.match(/magpie's catalog lists (\d+) models/)
    expect(said?.[1]).toBe(String(listed.length))
  })
  it('mentions every model of the pool it names', () => {
    if (!present) return
    // a group table that names a model the pool no longer serves is a lie
    const known = new Set(models())
    const groups = new Set((JSON.parse(read(PROVIDERS)) as Catalog).groups
      ?.filter(group => group.members?.length)
      .map(group => `group/${group.id ?? group.name}`) ?? [])
    for (const row of table()) {
      for (const member of row.members) {
        // a member may be another group, which is offered in its place
        expect(known.has(member) || groups.has(member) || member.endsWith('-Preview')).toBe(true)
      }
    }
  })
  it('keeps the free channel on the pool that serves it', () => {
    if (!present) return
    const listed = models()
    expect(listed).toContain('aikey4k/qiniu/conatus-free')
    expect(doc).toContain('magpie provider models aikey4k +qiniu/conatus-free')
  })
  it('shows every agent only what the doc says', () => {
    if (!present || !existsSync(SETTINGS)) return
    const settings = JSON.parse(read(SETTINGS)) as MagpieSettings
    for (const agent of ['claude', 'dsh']) {
      const said = doc.match(new RegExp(`magpie visible ${agent} ([a-z0-9,-]+)`))
      expect([...(settings.visible?.[agent] ?? [])].sort()).toEqual(said?.[1]?.split(',').sort() ?? [])
    }
  })
  it('says how the narrowing is made and undone', () => {
    expect(doc).toContain('magpie visible claude aikey4k,claude,dsh,cheap,alt,dsh-free')
    expect(doc).toContain('magpie visible dsh aikey4k,claude,dsh,cheap,alt,dsh-free')
    expect(doc).toContain('magpie visible claude all')
  })
  it('keeps the picker on the models the agent is shown', () => {
    if (!present || !existsSync(CLAUDE)) return
    const catalog = JSON.parse(read(PROVIDERS)) as Catalog
    const settings = JSON.parse(read(SETTINGS)) as MagpieSettings
    // a group is offered through the group alone (listed=no): its own models
    // leave the lists, and the group itself is offered only if it is visible
    const groupIds = new Set((catalog.groups ?? []).map(group => group.id ?? group.name))
    const hidden = new Set(unlisted())
    const visible = settings.visible?.claude ?? []
    const groups = visible.filter(name => groupIds.has(name)).map(name => `group/${name}`)
    const pools = visible.filter(name => !groupIds.has(name))
    const models = pools.flatMap(pool => (catalog.providers ?? [])
      .filter(provider => provider.id === pool)
      .flatMap(provider => (provider.models ?? []).map(model => `${pool}/${model}`)))
      .filter(model => !hidden.has(model))
    const options = (JSON.parse(read(CLAUDE)) as ClaudeSettings).modelPicker?.options ?? []
    expect(options.map(option => option.model.replace(/\[1m\]$/, '')).sort())
      .toEqual([...groups, ...models].sort())
  })
  it('lists every model once, however many pools serve it', () => {
    if (!present || !existsSync(CLAUDE)) return
    const options = (JSON.parse(read(CLAUDE)) as ClaudeSettings).modelPicker?.options ?? []
    const named = options
      .filter(option => !option.model.startsWith('group/'))
      .map(option => option.model.replace(/\[1m\]$/, '').split('/').slice(1).join('/'))
    expect(named.length).toBeGreaterThan(0)
    expect(new Set(named).size).toBe(named.length)
  })
  it('shows the name of the group, so the model behind it is visible', () => {
    if (!present || !existsSync(CLAUDE)) return
    const catalog = JSON.parse(read(PROVIDERS)) as Catalog
    const names = new Map((catalog.groups ?? [])
      .filter(group => group.members?.length)
      .map(group => [`group/${group.id ?? group.name}`, group.name ?? '']))
    const options = (JSON.parse(read(CLAUDE)) as ClaudeSettings).modelPicker?.options ?? []
    for (const option of options) {
      const id = option.model.replace(/\[1m\]$/, '')
      if (!id.startsWith('group/')) continue
      expect((option.label ?? '').startsWith(names.get(id) ?? ' ')).toBe(true)
    }
  })
  it('offers the community compute through its group alone', () => {
    if (!present || !existsSync(CLAUDE)) return
    const catalog = JSON.parse(read(PROVIDERS)) as Catalog
    const settings = JSON.parse(read(SETTINGS)) as MagpieSettings
    const options = (JSON.parse(read(CLAUDE)) as ClaudeSettings).modelPicker?.options ?? []
    const shown = options.map(option => option.model.replace(/\[1m\]$/, ''))
    const known = new Set(models())
    const hidden = (catalog.groups ?? []).filter(group => group.unlists)
    expect(hidden.length).toBeGreaterThan(0)
    for (const group of hidden) {
      for (const member of group.members ?? []) {
        if (!known.has(member)) continue
        // a model a group keeps to itself is not offered on its own
        expect(shown).not.toContain(member)
      }
    }
    // and the group itself is offered to both agents
    for (const agent of ['claude', 'dsh']) {
      expect(settings.visible?.[agent] ?? []).toContain('ms')
    }
    expect(doc).toContain('listed=no')
  })
  it('says who keeps the refusal readable', () => {
    // a refusal is only recoverable if both gateways can read it: one must
    // not take the field name away, the other must read it either way
    expect(doc).toContain('***.type')
    expect(doc).toMatch(/\*\*new-api\*\* keeps the field name/)
    expect(doc).toMatch(/\*\*magpie\*\* reads a masked name/)
  })
})
