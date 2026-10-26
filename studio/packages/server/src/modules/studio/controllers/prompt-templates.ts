import {
  createPromptTemplate,
  deletePromptTemplate,
  findPromptTemplateByName,
  getPromptTemplate,
  listPromptTemplates,
  movePromptTemplate,
  normalizePromptTemplateCategory,
  normalizePromptTemplateContent,
  normalizePromptTemplateDescription,
  normalizePromptTemplateDomain,
  normalizePromptTemplateKind,
  normalizePromptTemplateName,
  normalizePromptTemplateSort,
  setPromptTemplateEnabled,
  updatePromptTemplate,
  validatePromptTemplateInput,
  type PromptTemplateInput,
  type PromptTemplateRow,
} from '../public/prompt-templates'

/**
 * Prompt template CRUD. Every handler sets its own status/body — there is no
 * global error middleware in this app, so an unset status means "200 with
 * whatever shape we wrote".
 */

function readTemplateId(ctx: any): number | null {
  const id = Number(ctx.params.id)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

/** Build the row input from a body; `base` supplies values for a partial PATCH. */
function buildInput(
  body: Record<string, unknown>,
  base?: PromptTemplateRow,
): { ok: true; input: PromptTemplateInput } | { ok: false; error: string } {
  const rawKind = body.kind === undefined && base ? base.kind : body.kind
  const kind = normalizePromptTemplateKind(rawKind, base ? base.kind : 'insert')
  if (kind === null) return { ok: false, error: 'Template kind must be "insert" or "instruction"' }

  const rawEnabled = body.enabled === undefined && base ? base.enabled : body.enabled
  if (rawEnabled !== undefined && typeof rawEnabled !== 'boolean') {
    return { ok: false, error: 'enabled must be a boolean' }
  }

  const rawSort = body.sort === undefined && base ? base.sort : body.sort
  const sort = normalizePromptTemplateSort(rawSort, base ? base.sort : 0)
  if (sort === null) return { ok: false, error: 'sort must be a non-negative integer' }

  const input: PromptTemplateInput = {
    name: body.name === undefined && base
      ? base.name
      : normalizePromptTemplateName(body.name),
    category: normalizePromptTemplateCategory(
      body.category === undefined && base ? base.category : body.category,
    ),
    description: body.description === undefined && base
      ? base.description
      : normalizePromptTemplateDescription(body.description),
    kind,
    domain: normalizePromptTemplateDomain(
      body.domain === undefined && base ? base.domain : body.domain,
    ),
    content: body.content === undefined && base
      ? base.content
      : normalizePromptTemplateContent(body.content),
    enabled: rawEnabled === undefined ? true : rawEnabled === true,
    sort,
  }

  const validation = validatePromptTemplateInput(input)
  return validation.ok ? { ok: true, input } : { ok: false, error: validation.error }
}

export async function list(ctx: any) {
  ctx.body = { templates: listPromptTemplates() }
}

export async function create(ctx: any) {
  const body = (ctx.request.body || {}) as Record<string, unknown>
  const built = buildInput(body)
  if (built.ok === false) {
    ctx.status = 400
    ctx.body = { error: built.error }
    return
  }
  if (findPromptTemplateByName(built.input.name)) {
    ctx.status = 409
    ctx.body = { error: 'A template with this name already exists' }
    return
  }
  try {
    ctx.body = { template: createPromptTemplate(built.input) }
  } catch (error) {
    ctx.status = 500
    ctx.body = { error: error instanceof Error ? error.message : 'Failed to create template' }
  }
}

export async function update(ctx: any) {
  const id = readTemplateId(ctx)
  const current = id === null ? null : getPromptTemplate(id)
  if (!current) {
    ctx.status = 404
    ctx.body = { error: 'Template not found' }
    return
  }
  const body = (ctx.request.body || {}) as Record<string, unknown>
  const built = buildInput(body, current)
  if (built.ok === false) {
    ctx.status = 400
    ctx.body = { error: built.error }
    return
  }
  const duplicate = findPromptTemplateByName(built.input.name)
  if (duplicate && duplicate.id !== current.id) {
    ctx.status = 409
    ctx.body = { error: 'A template with this name already exists' }
    return
  }
  try {
    const template = updatePromptTemplate(current.id, built.input)
    if (!template) {
      ctx.status = 404
      ctx.body = { error: 'Template not found' }
      return
    }
    ctx.body = { template }
  } catch (error) {
    ctx.status = 500
    ctx.body = { error: error instanceof Error ? error.message : 'Failed to update template' }
  }
}

export async function setEnabled(ctx: any) {
  const id = readTemplateId(ctx)
  const current = id === null ? null : getPromptTemplate(id)
  if (!current) {
    ctx.status = 404
    ctx.body = { error: 'Template not found' }
    return
  }
  const body = (ctx.request.body || {}) as { enabled?: unknown }
  if (typeof body.enabled !== 'boolean') {
    ctx.status = 400
    ctx.body = { error: 'enabled must be a boolean' }
    return
  }
  const template = setPromptTemplateEnabled(current.id, body.enabled)
  if (!template) {
    ctx.status = 404
    ctx.body = { error: 'Template not found' }
    return
  }
  ctx.body = { template }
}

/** Reorder inside the template's own category (the pill rows read top to bottom). */
export async function move(ctx: any) {
  const id = readTemplateId(ctx)
  const current = id === null ? null : getPromptTemplate(id)
  if (!current) {
    ctx.status = 404
    ctx.body = { error: 'Template not found' }
    return
  }
  const body = (ctx.request.body || {}) as { direction?: unknown }
  if (body.direction !== 'up' && body.direction !== 'down') {
    ctx.status = 400
    ctx.body = { error: 'direction must be "up" or "down"' }
    return
  }
  const template = movePromptTemplate(current.id, body.direction)
  if (!template) {
    ctx.status = 404
    ctx.body = { error: 'Template not found' }
    return
  }
  ctx.body = { template }
}

export async function remove(ctx: any) {
  const id = readTemplateId(ctx)
  const current = id === null ? null : getPromptTemplate(id)
  if (!current) {
    ctx.status = 404
    ctx.body = { error: 'Template not found' }
    return
  }
  if (!deletePromptTemplate(current.id)) {
    ctx.status = 404
    ctx.body = { error: 'Template not found' }
    return
  }
  ctx.body = { ok: true }
}
