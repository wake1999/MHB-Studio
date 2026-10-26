import { getDb, isSqliteAvailable } from '../infrastructure/database'
import { CHAT_APPS_TABLE } from '../infrastructure/database/schemas'

/**
 * 「发现应用」的应用目录（chat_apps）。
 *
 * 一行 = 一个应用；`payload` 是整棵应用树的 JSON（图标、按语言分片的文案、场景与
 * 胶囊）。这样运营侧加字段只改 JSON，不用动表结构；代价是查询只能整行取出，但目录
 * 体量只有个位数，不值得拆关系表。
 *
 * 读取一律走 `parseChatAppPayload`：库里被手改成非法 JSON 时，坏行跳过而不是让整个
 * 接口 500 —— 首页拿不到应用只是少个入口，不该拖垮对话框。
 */

export interface ChatAppText {
  name: string
  desc: string
  heroTitle: string
  heroSubtitle: string
  placeholder: string
}

export interface ChatAppQuickPrompt {
  label: string
  text: string
}

export interface ChatAppScenePayload {
  id: string
  text: Record<string, { label: string; placeholder: string }>
  quickPrompts: ChatAppQuickPrompt[]
}

export interface ChatAppPayload {
  iconPaths: string[]
  tint: string
  text: Record<string, ChatAppText>
  scenes: ChatAppScenePayload[]
}

export interface ChatAppRow {
  id: string
  sort: number
  enabled: boolean
  payload: ChatAppPayload
  updated_at: number
}

export interface ChatAppWriteInput {
  id?: string
  sort?: number
  enabled?: boolean
  payload: unknown
}

export const CHAT_APP_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,31}$/
export const CHAT_APP_PROMPT_MAX_LENGTH = 4000

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function parseText(value: unknown): Record<string, ChatAppText> {
  const out: Record<string, ChatAppText> = {}
  for (const [locale, entry] of Object.entries(asRecord(value))) {
    const record = asRecord(entry)
    out[locale] = {
      name: asString(record.name).trim(),
      desc: asString(record.desc).trim(),
      heroTitle: asString(record.heroTitle).trim(),
      heroSubtitle: asString(record.heroSubtitle).trim(),
      placeholder: asString(record.placeholder).trim(),
    }
  }
  return out
}

function parseQuickPrompts(value: unknown): ChatAppQuickPrompt[] {
  if (!Array.isArray(value)) return []
  return value
    .map(item => asRecord(item))
    .map(item => ({
      label: asString(item.label).trim(),
      text: asString(item.text).trim().slice(0, CHAT_APP_PROMPT_MAX_LENGTH),
    }))
    .filter(item => item.label !== '' && item.text !== '')
}

function parseScenes(value: unknown): ChatAppScenePayload[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const scenes: ChatAppScenePayload[] = []
  for (const item of value) {
    const record = asRecord(item)
    const text: Record<string, { label: string; placeholder: string }> = {}
    for (const [locale, entry] of Object.entries(asRecord(record.text))) {
      const entryRecord = asRecord(entry)
      text[locale] = {
        label: asString(entryRecord.label).trim(),
        placeholder: asString(entryRecord.placeholder).trim(),
      }
    }
    const id = asString(record.id).trim()
    if (!id || seen.has(id)) continue
    if (!Object.values(text).some(entry => entry.label !== '')) continue
    seen.add(id)
    scenes.push({ id, text, quickPrompts: parseQuickPrompts(record.quickPrompts) })
  }
  return scenes
}

/** 把库里的一行 JSON 解析成应用；没有可显示的文案就算坏行（返回 null）。 */
export function parseChatAppPayload(raw: unknown): ChatAppPayload | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch {
    return null
  }
  const record = asRecord(decoded)
  const text = parseText(record.text)
  if (Object.values(text).every(entry => entry.name === '' && entry.heroTitle === '')) return null
  return {
    iconPaths: asStringList(record.iconPaths),
    tint: asString(record.tint).trim(),
    text,
    scenes: parseScenes(record.scenes),
  }
}

/**
 * 校验并归一化一份写入请求。管理面板和服务端种子走同一条路：
 * 文案至少要有 `zh.name`（否则侧栏/首页无从显示），场景至少要有一个。
 */
export function normalizeChatAppPayload(
  raw: unknown,
): { ok: true; payload: ChatAppPayload } | { ok: false; error: string } {
  const record = asRecord(raw)
  const text = parseText(record.text)
  if (!text.zh || text.zh.name === '') {
    return { ok: false, error: '名称（中文）不能为空' }
  }
  const scenes = parseScenes(record.scenes)
  return {
    ok: true,
    payload: {
      iconPaths: asStringList(record.iconPaths),
      tint: asString(record.tint).trim() || 'linear-gradient(135deg, #4aa3f0, #2f6fe0)',
      text,
      scenes,
    },
  }
}

export function listChatApps(options: { enabledOnly?: boolean } = {}): ChatAppRow[] {
  if (!isSqliteAvailable()) return []
  const db = getDb()!
  const where = options.enabledOnly ? ' WHERE enabled <> 0' : ''
  const rows = db.prepare(
    `SELECT id, sort, enabled, payload, updated_at FROM ${CHAT_APPS_TABLE}${where} ORDER BY sort ASC, id ASC`,
  ).all() as Record<string, unknown>[]

  const apps: ChatAppRow[] = []
  for (const row of rows) {
    const payload = parseChatAppPayload(row.payload)
    if (!payload) continue
    apps.push({
      id: asString(row.id),
      sort: Number(row.sort ?? 0),
      enabled: Number(row.enabled ?? 0) !== 0,
      payload,
      updated_at: Number(row.updated_at ?? 0),
    })
  }
  return apps
}

export function findChatAppRow(id: string): ChatAppRow | null {
  return listChatApps().find(app => app.id === id) ?? null
}

function nextChatAppSort(): number {
  const db = getDb()!
  const row = db.prepare(
    `SELECT COALESCE(MAX(sort), -1) AS max_sort FROM ${CHAT_APPS_TABLE}`,
  ).get() as { max_sort?: number } | undefined
  return Number(row?.max_sort ?? -1) + 1
}

export function createChatApp(
  rawId: string,
  input: ChatAppWriteInput,
): { ok: true; app: ChatAppRow } | { ok: false; error: string } {
  const id = rawId.trim()
  if (!CHAT_APP_ID_PATTERN.test(id)) {
    return { ok: false, error: '应用标识只能是小写字母、数字和连字符（2–32 位）' }
  }
  const normalized = normalizeChatAppPayload(input.payload)
  if (!normalized.ok) return normalized
  if (findChatAppRow(id)) return { ok: false, error: '这个应用标识已经存在' }

  if (!isSqliteAvailable()) return { ok: false, error: '数据库不可用' }
  const db = getDb()!
  const now = Math.floor(Date.now() / 1000)
  const sort = Number.isFinite(input.sort) ? Number(input.sort) : nextChatAppSort()
  db.prepare(
    `INSERT INTO ${CHAT_APPS_TABLE} (id, payload, enabled, sort, updated_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, JSON.stringify(normalized.payload), input.enabled === false ? 0 : 1, sort, now)

  return { ok: true, app: findChatAppRow(id)! }
}

export function updateChatApp(
  id: string,
  input: ChatAppWriteInput,
): { ok: true; app: ChatAppRow } | { ok: false; error: string } {
  const existing = findChatAppRow(id)
  if (!existing) return { ok: false, error: '应用不存在' }

  const normalized = normalizeChatAppPayload(input.payload)
  if (!normalized.ok) return normalized

  if (!isSqliteAvailable()) return { ok: false, error: '数据库不可用' }
  const db = getDb()!
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    `UPDATE ${CHAT_APPS_TABLE} SET payload = ?, enabled = ?, sort = ?, updated_at = ? WHERE id = ?`,
  ).run(
    JSON.stringify(normalized.payload),
    input.enabled === undefined ? (existing.enabled ? 1 : 0) : input.enabled ? 1 : 0,
    Number.isFinite(input.sort) ? Number(input.sort) : existing.sort,
    now,
    id,
  )

  return { ok: true, app: findChatAppRow(id)! }
}

export function deleteChatApp(id: string): boolean {
  if (!isSqliteAvailable()) return false
  const db = getDb()!
  const result = db.prepare(`DELETE FROM ${CHAT_APPS_TABLE} WHERE id = ?`).run(id)
  return Number(result.changes ?? 0) > 0
}
