import { getDb, isSqliteAvailable } from '../infrastructure/database'
import { PROMPT_TEMPLATES_TABLE } from '../infrastructure/database/schemas'

/**
 * Prompt templates (提示词模板).
 *
 * A template is a reusable piece of user text. `kind` decides where it lands:
 *
 * - `insert`      — picked from the composer and pasted into the draft. It leaves
 *                   as an ordinary user message, so it never touches the system
 *                   prompt and the server never needs to know about it.
 * - `instruction` — appended to the system prompt of every turn while it is
 *                   switched on. The client folds the active templates into the
 *                   run payload's `instructions`, which the chat-run socket
 *                   appends after the Studio base prompt.
 *
 * `category` groups the pickers (`''` means uncategorised) and `sort` keeps the
 * order the author arranged — the pill rows read like a hand-ordered shelf, not
 * like an alphabet, so `sort` is what the client renders and what `move` edits.
 *
 * `domain` says which composer surface the shelf belongs to (`chat` = 对话,
 * `create` = 创造). An empty value keeps the old behaviour: the client infers
 * the surface from the category name, so existing rows need no backfill.
 *
 * The store is deliberately global (no user_id / profile column), matching
 * `session_categories`: the row shape is the API shape, and the composer may
 * read it from any surface.
 */

export const PROMPT_TEMPLATE_NAME_MAX_LENGTH = 60
export const PROMPT_TEMPLATE_CATEGORY_MAX_LENGTH = 30
export const PROMPT_TEMPLATE_DESCRIPTION_MAX_LENGTH = 200
export const PROMPT_TEMPLATE_CONTENT_MAX_LENGTH = 20000

export type PromptTemplateKind = 'insert' | 'instruction'

/** Which composer surface a template belongs to; `''` = infer from the category. */
export type PromptTemplateDomain = '' | 'chat' | 'create'

export interface PromptTemplateRow {
  id: number
  name: string
  category: string
  description: string
  kind: PromptTemplateKind
  domain: PromptTemplateDomain
  content: string
  enabled: boolean
  sort: number
  created_at: number
  updated_at: number
}

export interface PromptTemplateInput {
  name: string
  category: string
  description: string
  kind: PromptTemplateKind
  domain: PromptTemplateDomain
  content: string
  enabled: boolean
  sort: number
}

const SELECT_COLUMNS = 'id, name, category, description, kind, domain, content, enabled, sort, created_at, updated_at'
/** Author order first, then name as a stable tie-breaker for equal sorts. */
const ORDER_BY = 'sort, name COLLATE NOCASE, id'

function mapPromptTemplateRow(row: Record<string, unknown>): PromptTemplateRow {
  return {
    id: Number(row.id),
    name: String(row.name || ''),
    category: String(row.category || ''),
    description: String(row.description || ''),
    // A row read back from SQLite can only hold a kind this app wrote; the
    // `?? 'insert'` keeps the type narrow for rows seeded by hand.
    kind: normalizePromptTemplateKind(row.kind, 'insert') ?? 'insert',
    domain: normalizePromptTemplateDomain(row.domain),
    content: String(row.content || ''),
    enabled: Number(row.enabled ?? 1) !== 0,
    sort: Number(row.sort || 0),
    created_at: Number(row.created_at || 0),
    updated_at: Number(row.updated_at || 0),
  }
}

export function normalizePromptTemplateName(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.trim().replace(/\s+/g, ' ')
}

export function normalizePromptTemplateCategory(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.trim().replace(/\s+/g, ' ')
}

/** Flattened to one line: the description is shown next to the name in pickers. */
export function normalizePromptTemplateDescription(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim()
}

/** Unknown/absent kinds fall back to `fallback`; `null` means the caller sent garbage. */
export function normalizePromptTemplateKind(
  value: unknown,
  fallback: PromptTemplateKind | null = 'insert',
): PromptTemplateKind | null {
  if (value === undefined || value === null || value === '') return fallback
  if (value === 'insert' || value === 'instruction') return value
  return null
}

/** Anything but the two surfaces collapses to `''` (infer from the category). */
export function normalizePromptTemplateDomain(value: unknown): PromptTemplateDomain {
  if (value === 'chat' || value === 'create') return value
  return ''
}

/** Content is stored verbatim (newlines and markdown included) — only trimmed. */
export function normalizePromptTemplateContent(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.trim()
}

export function normalizePromptTemplateSort(value: unknown, fallback = 0): number | null {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 100000) return null
  return parsed
}

export function validatePromptTemplateInput(
  input: PromptTemplateInput,
): { ok: true } | { ok: false; error: string } {
  if (!input.name) return { ok: false, error: 'Template name is required' }
  if (input.name.length > PROMPT_TEMPLATE_NAME_MAX_LENGTH) {
    return { ok: false, error: `Template name must be ${PROMPT_TEMPLATE_NAME_MAX_LENGTH} characters or fewer` }
  }
  if (input.category.length > PROMPT_TEMPLATE_CATEGORY_MAX_LENGTH) {
    return { ok: false, error: `Template category must be ${PROMPT_TEMPLATE_CATEGORY_MAX_LENGTH} characters or fewer` }
  }
  if (input.description.length > PROMPT_TEMPLATE_DESCRIPTION_MAX_LENGTH) {
    return { ok: false, error: `Template description must be ${PROMPT_TEMPLATE_DESCRIPTION_MAX_LENGTH} characters or fewer` }
  }
  if (!input.content) return { ok: false, error: 'Template content is required' }
  if (input.content.length > PROMPT_TEMPLATE_CONTENT_MAX_LENGTH) {
    return { ok: false, error: `Template content must be ${PROMPT_TEMPLATE_CONTENT_MAX_LENGTH} characters or fewer` }
  }
  return { ok: true }
}

export function listPromptTemplates(options: { enabledOnly?: boolean } = {}): PromptTemplateRow[] {
  if (!isSqliteAvailable()) return []
  const db = getDb()!
  const where = options.enabledOnly ? ' WHERE enabled <> 0' : ''
  const rows = db.prepare(
    `SELECT ${SELECT_COLUMNS} FROM ${PROMPT_TEMPLATES_TABLE}${where} ORDER BY ${ORDER_BY}`,
  ).all() as Record<string, unknown>[]
  return rows.map(mapPromptTemplateRow)
}

export function getPromptTemplate(id: number): PromptTemplateRow | null {
  if (!isSqliteAvailable()) return null
  const db = getDb()!
  const row = db.prepare(
    `SELECT ${SELECT_COLUMNS} FROM ${PROMPT_TEMPLATES_TABLE} WHERE id = ?`,
  ).get(id) as Record<string, unknown> | undefined
  return row ? mapPromptTemplateRow(row) : null
}

export function findPromptTemplateByName(name: string): PromptTemplateRow | null {
  if (!isSqliteAvailable()) return null
  const db = getDb()!
  const row = db.prepare(
    `SELECT ${SELECT_COLUMNS} FROM ${PROMPT_TEMPLATES_TABLE} WHERE name = ? COLLATE NOCASE`,
  ).get(name) as Record<string, unknown> | undefined
  return row ? mapPromptTemplateRow(row) : null
}

/** New templates land at the end of the shelf. */
function nextPromptTemplateSort(): number {
  const db = getDb()!
  const row = db.prepare(
    `SELECT COALESCE(MAX(sort), -1) AS max_sort FROM ${PROMPT_TEMPLATES_TABLE}`,
  ).get() as { max_sort?: number } | undefined
  return Number(row?.max_sort ?? -1) + 1
}

export function createPromptTemplate(input: PromptTemplateInput): PromptTemplateRow {
  const validation = validatePromptTemplateInput(input)
  if (validation.ok === false) throw new Error(validation.error)
  if (!isSqliteAvailable()) {
    const now = Math.floor(Date.now() / 1000)
    return { id: 0, ...input, created_at: now, updated_at: now }
  }
  const existing = findPromptTemplateByName(input.name)
  if (existing) throw new Error('A template with this name already exists')

  const db = getDb()!
  const now = Math.floor(Date.now() / 1000)
  const sort = input.sort > 0 ? input.sort : nextPromptTemplateSort()
  const result = db.prepare(
    `INSERT INTO ${PROMPT_TEMPLATES_TABLE}
       (name, category, description, kind, domain, content, enabled, sort, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.name,
    input.category,
    input.description,
    input.kind,
    input.domain,
    input.content,
    input.enabled ? 1 : 0,
    sort,
    now,
    now,
  )
  const created = getPromptTemplate(Number(result.lastInsertRowid))
  if (!created) throw new Error('Failed to create template')
  return created
}

export function updatePromptTemplate(id: number, input: PromptTemplateInput): PromptTemplateRow | null {
  const validation = validatePromptTemplateInput(input)
  if (validation.ok === false) throw new Error(validation.error)
  if (!isSqliteAvailable()) return null
  const duplicate = findPromptTemplateByName(input.name)
  if (duplicate && duplicate.id !== id) throw new Error('A template with this name already exists')

  const db = getDb()!
  const now = Math.floor(Date.now() / 1000)
  const result = db.prepare(
    `UPDATE ${PROMPT_TEMPLATES_TABLE}
     SET name = ?, category = ?, description = ?, kind = ?, domain = ?, content = ?, enabled = ?, sort = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    input.name,
    input.category,
    input.description,
    input.kind,
    input.domain,
    input.content,
    input.enabled ? 1 : 0,
    input.sort,
    now,
    id,
  )
  return result.changes > 0 ? getPromptTemplate(id) : null
}

export function setPromptTemplateEnabled(id: number, enabled: boolean): PromptTemplateRow | null {
  if (!isSqliteAvailable()) return null
  const db = getDb()!
  const now = Math.floor(Date.now() / 1000)
  const result = db.prepare(
    `UPDATE ${PROMPT_TEMPLATES_TABLE} SET enabled = ?, updated_at = ? WHERE id = ?`,
  ).run(enabled ? 1 : 0, now, id)
  return result.changes > 0 ? getPromptTemplate(id) : null
}

/**
 * Move a template one slot up/down inside its own category.
 *
 * `sort` is shared by every category, and the pickers group rows by *adjacent*
 * category, so the whole shelf is renumbered 0..n-1 in one transaction: the
 * categories keep the block order they already had, the moved row only swaps with
 * its neighbour inside its own block. Renumbering everything also converges a
 * shelf that predates `sort` (all zeroes) the first time the user reorders it.
 */
export function movePromptTemplate(id: number, direction: 'up' | 'down'): PromptTemplateRow | null {
  if (!isSqliteAvailable()) return null
  const target = getPromptTemplate(id)
  if (!target) return null

  const ordered = listPromptTemplates()
  const categories = Array.from(new Set(ordered.map(template => template.category)))
  const shelves = new Map(
    categories.map(category => [
      category,
      ordered.filter(template => template.category === category),
    ]),
  )
  const shelf = shelves.get(target.category)!
  const index = shelf.findIndex(template => template.id === target.id)
  if (index === -1) return null
  const swapIndex = direction === 'up' ? index - 1 : index + 1
  if (swapIndex < 0 || swapIndex >= shelf.length) return target

  const moved = shelf[index]
  shelf[index] = shelf[swapIndex]
  shelf[swapIndex] = moved

  const db = getDb()!
  const now = Math.floor(Date.now() / 1000)
  const update = db.prepare(
    `UPDATE ${PROMPT_TEMPLATES_TABLE} SET sort = ?, updated_at = ? WHERE id = ?`,
  )
  db.exec('BEGIN')
  try {
    let position = 0
    for (const category of categories) {
      for (const row of shelves.get(category)!) update.run(position++, now, row.id)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }

  return getPromptTemplate(target.id)
}

export function deletePromptTemplate(id: number): boolean {
  if (!isSqliteAvailable()) return false
  const db = getDb()!
  const result = db.prepare(`DELETE FROM ${PROMPT_TEMPLATES_TABLE} WHERE id = ?`).run(id)
  return result.changes > 0
}
