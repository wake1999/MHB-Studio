import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_PROMPT_TEMPLATES } from '../../packages/server/src/modules/studio/infrastructure/database/prompt-template-defaults'

/**
 * Server half of the prompt template feature: the rows the client shelf renders
 * and the status codes the manager page reacts to. Lives behind a temp database
 * like the other studio store tests, so the order / duplicate-name / validation
 * rules are pinned without touching the dev DB.
 */

const databaseDirectory = mkdtempSync(join(tmpdir(), 'studio-prompt-templates-'))
const originalDatabaseDirectory = process.env.HERMES_WEB_UI_TEST_DB_DIR
process.env.HERMES_WEB_UI_TEST_DB_DIR = databaseDirectory

type PromptTemplateStore = typeof import('../../packages/server/src/modules/studio/repositories/prompt-template-store')
type PromptTemplateController = typeof import('../../packages/server/src/modules/studio/controllers/prompt-templates')

let store: PromptTemplateStore
let controller: PromptTemplateController
/** Snapshot of the fresh database, taken before any test mutates the shelf. */
let starterShelf: ReturnType<PromptTemplateStore['listPromptTemplates']> = []

function input(overrides: Partial<Parameters<PromptTemplateStore['createPromptTemplate']>[0]> = {}) {
  return {
    name: 'template',
    category: '开发',
    description: '',
    kind: 'insert' as const,
    content: '正文',
    enabled: true,
    sort: 0,
    ...overrides,
  }
}

/** A koa context stub: the controllers only read `request.body` and `params`. */
function makeCtx(body: unknown, params: Record<string, string> = {}) {
  return { request: { body }, params } as any
}

describe('Studio prompt template store', () => {
  beforeAll(async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    initAllStores()
    store = await import('../../packages/server/src/modules/studio/repositories/prompt-template-store')
    controller = await import('../../packages/server/src/modules/studio/controllers/prompt-templates')
    starterShelf = store.listPromptTemplates()
  })

  afterAll(async () => {
    const { closeDb } = await import('../../packages/server/src/modules/studio/infrastructure/database')
    closeDb()
    if (originalDatabaseDirectory === undefined) delete process.env.HERMES_WEB_UI_TEST_DB_DIR
    else process.env.HERMES_WEB_UI_TEST_DB_DIR = originalDatabaseDirectory
    rmSync(databaseDirectory, { recursive: true, force: true })
  })

  beforeEach(() => {
    for (const row of store.listPromptTemplates()) store.deletePromptTemplate(row.id)
  })

  it('fills an empty shelf with the starter library on first boot', () => {
    expect(starterShelf.map(row => row.name)).toEqual(DEFAULT_PROMPT_TEMPLATES.map(item => item.name))

    // The composer shows one pill per scene and that scene's prompts underneath it,
    // so every insert scene has to carry more than a single prompt.
    const sceneSizes = new Map<string, number>()
    for (const row of starterShelf.filter(item => item.kind === 'insert')) {
      sceneSizes.set(row.category, (sceneSizes.get(row.category) ?? 0) + 1)
    }
    expect(sceneSizes.size).toBeGreaterThanOrEqual(5)
    expect([...sceneSizes.values()].every(count => count >= 2)).toBe(true)
    expect(starterShelf.filter(row => row.kind === 'instruction').length).toBeGreaterThan(0)
    expect(starterShelf.every(row => row.enabled)).toBe(true)
  })

  it('lands new templates at the end of their category and reads them back in author order', () => {
    const first = store.createPromptTemplate(input({ name: 'A', category: '开发' }))
    const second = store.createPromptTemplate(input({ name: 'B', category: '开发' }))
    store.createPromptTemplate(input({ name: 'C', category: '写作' }))

    expect(second.sort).toBeGreaterThan(first.sort)
    expect(store.listPromptTemplates().map(row => [row.name, row.category]))
      .toEqual([['A', '开发'], ['B', '开发'], ['C', '写作']])
  })

  it('moves a template inside its own category only', () => {
    const a = store.createPromptTemplate(input({ name: 'A', category: '开发' }))
    const b = store.createPromptTemplate(input({ name: 'B', category: '开发' }))
    const c = store.createPromptTemplate(input({ name: 'C', category: '写作' }))

    store.movePromptTemplate(a.id, 'down')

    const development = store.listPromptTemplates().filter(row => row.category === '开发')
    expect(development.map(row => [row.name, row.sort])).toEqual([['B', 0], ['A', 1]])
    // The other shelf keeps its own order.
    expect(store.getPromptTemplate(c.id)?.name).toBe('C')
    expect(store.getPromptTemplate(b.id)?.sort).toBe(0)
  })

  it('keeps every category contiguous after a move in another category', () => {
    store.createPromptTemplate(input({ name: 'A', category: '开发' }))
    store.createPromptTemplate(input({ name: 'B', category: '开发' }))
    store.createPromptTemplate(input({ name: 'C', category: '开发' }))
    const writeD = store.createPromptTemplate(input({ name: 'D', category: '写作' }))
    store.createPromptTemplate(input({ name: 'E', category: '写作' }))

    store.movePromptTemplate(writeD.id, 'down')

    // The pickers group by *adjacent* category, so a reorder inside one shelf must
    // not interleave the shelves in the shared `sort` space.
    expect(store.listPromptTemplates().map(row => row.category))
      .toEqual(['开发', '开发', '开发', '写作', '写作'])
    expect(store.listPromptTemplates().filter(row => row.category === '写作').map(row => row.name))
      .toEqual(['E', 'D'])
  })

  it('keeps the order when the move would leave the category', () => {
    store.createPromptTemplate(input({ name: 'A', category: '开发' }))
    const b = store.createPromptTemplate(input({ name: 'B', category: '开发' }))

    const moved = store.movePromptTemplate(b.id, 'down')

    expect(moved?.name).toBe('B')
    expect(store.listPromptTemplates().map(row => row.name)).toEqual(['A', 'B'])
  })

  it('rejects a duplicate name, case included', () => {
    store.createPromptTemplate(input({ name: 'Review' }))
    const other = store.createPromptTemplate(input({ name: '改写' }))

    expect(() => store.createPromptTemplate(input({ name: 'Review' }))).toThrow(/already exists/)
    // The column and its unique index are COLLATE NOCASE, so case cannot slip past.
    expect(() => store.createPromptTemplate(input({ name: 'review' }))).toThrow(/already exists/)
    expect(() => store.updatePromptTemplate(other.id, input({ name: 'review' }))).toThrow(/already exists/)
  })

  it('validates the shape it is handed', () => {
    expect(() => store.createPromptTemplate(input({ name: '' }))).toThrow(/name is required/)
    expect(() => store.createPromptTemplate(input({ content: '' }))).toThrow(/content is required/)
    expect(() => store.createPromptTemplate(input({ name: 'x'.repeat(61) }))).toThrow(/60 characters or fewer/)
    expect(() => store.createPromptTemplate(input({ category: 'x'.repeat(31) }))).toThrow(/30 characters or fewer/)
    expect(() => store.createPromptTemplate(input({ description: 'x'.repeat(201) }))).toThrow(/200 characters or fewer/)
  })

  it('normalizes kind, description and content the way the API does', () => {
    expect(store.normalizePromptTemplateKind('instruction')).toBe('instruction')
    expect(store.normalizePromptTemplateKind('', 'instruction')).toBe('instruction')
    expect(store.normalizePromptTemplateKind('nope')).toBeNull()
    expect(store.normalizePromptTemplateDescription('多行\n说明  折叠')).toBe('多行 说明 折叠')
    expect(store.normalizePromptTemplateContent('  正文\n第二行  ')).toBe('正文\n第二行')
    expect(store.normalizePromptTemplateSort('-1')).toBeNull()
    expect(store.normalizePromptTemplateSort('')).toBe(0)
  })

  it('filters disabled rows out of the enabled-only read', () => {
    const on = store.createPromptTemplate(input({ name: '开着的' }))
    const off = store.createPromptTemplate(input({ name: '关掉的' }))
    store.setPromptTemplateEnabled(off.id, false)

    expect(store.listPromptTemplates({ enabledOnly: true }).map(row => row.name)).toEqual(['开着的'])
    expect(store.setPromptTemplateEnabled(on.id, false)?.enabled).toBe(false)
  })

  it('round-trips an update and a delete', () => {
    const created = store.createPromptTemplate(input({ name: '旧名' }))
    const updated = store.updatePromptTemplate(created.id, input({ name: '新名', category: '写作', content: '改过的正文' }))

    expect(updated && [updated.name, updated.category, updated.content]).toEqual(['新名', '写作', '改过的正文'])
    expect(store.deletePromptTemplate(created.id)).toBe(true)
    expect(store.deletePromptTemplate(created.id)).toBe(false)
    expect(store.listPromptTemplates()).toEqual([])
  })

  it('trims and flattens the body before writing', async () => {
    const context = makeCtx({
      name: '  代码评审  ',
      category: '  开发  ',
      description: '多行\n说明  折叠',
      content: '  正文  ',
    })
    await controller.create(context)

    expect(context.body.template).toMatchObject({
      name: '代码评审',
      category: '开发',
      description: '多行 说明 折叠',
      content: '正文',
      kind: 'insert',
      enabled: true,
    })
  })

  it('answers 400 for a blank name and for a kind it cannot place', async () => {
    const blank = makeCtx({ name: '   ', content: 'x' })
    await controller.create(blank)
    expect([blank.status, blank.body.error]).toEqual([400, 'Template name is required'])

    const badKind = makeCtx({ name: 'k', content: 'x', kind: 'nope' })
    await controller.create(badKind)
    expect([badKind.status, badKind.body.error])
      .toEqual([400, 'Template kind must be "insert" or "instruction"'])
  })

  it('answers 409 for a duplicate name and 404 for an unknown id', async () => {
    await controller.create(makeCtx({ name: '唯一', content: 'x' }))

    const duplicate = makeCtx({ name: ' 唯一 ', content: 'x' })
    await controller.create(duplicate)
    expect([duplicate.status, duplicate.body.error]).toEqual([409, 'A template with this name already exists'])

    const missing = makeCtx({}, { id: '999999' })
    await controller.update(missing)
    expect([missing.status, missing.body.error]).toEqual([404, 'Template not found'])
  })

  it('patches one field without disturbing the others', async () => {
    const created = store.createPromptTemplate(input({ name: '保留名称', category: '开发', content: '原正文' }))

    const patch = makeCtx({ content: '新正文' }, { id: String(created.id) })
    await controller.update(patch)

    expect(patch.body.template).toMatchObject({ name: '保留名称', category: '开发', content: '新正文' })
  })

  it('guards the enabled switch and the move direction', async () => {
    const created = store.createPromptTemplate(input({ name: '开关' }))

    const badEnabled = makeCtx({ enabled: 'yes' }, { id: String(created.id) })
    await controller.setEnabled(badEnabled)
    expect([badEnabled.status, badEnabled.body.error]).toEqual([400, 'enabled must be a boolean'])

    const badDirection = makeCtx({ direction: 'left' }, { id: String(created.id) })
    await controller.move(badDirection)
    expect([badDirection.status, badDirection.body.error])
      .toEqual([400, 'direction must be "up" or "down"'])
  })

  it('deletes once and then reports 404', async () => {
    const created = store.createPromptTemplate(input({ name: '待删' }))

    const first = makeCtx({}, { id: String(created.id) })
    await controller.remove(first)
    expect(first.body).toEqual({ ok: true })

    const second = makeCtx({}, { id: String(created.id) })
    await controller.remove(second)
    expect(second.status).toBe(404)
  })
})
