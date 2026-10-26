// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { usePromptTemplatesStore } from '@/stores/hermes/prompt-templates'
import type { PromptTemplate } from '@/api/studio/prompt-templates'

const fetchPromptTemplatesMock = vi.hoisted(() => vi.fn())

vi.mock('@/api/studio/prompt-templates', () => ({
  fetchPromptTemplates: fetchPromptTemplatesMock,
  createPromptTemplate: vi.fn(),
  updatePromptTemplate: vi.fn(),
  setPromptTemplateEnabled: vi.fn(),
  movePromptTemplate: vi.fn(),
  deletePromptTemplate: vi.fn(),
}))

const SELECTION_KEY = 'hermes_prompt_template_selection_v1'

function template(overrides: Partial<PromptTemplate>): PromptTemplate {
  return {
    id: 1,
    name: 'template',
    category: '',
    description: '',
    kind: 'insert',
    content: 'content',
    enabled: true,
    sort: 1,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  }
}

describe('prompt templates store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    fetchPromptTemplatesMock.mockReset()
  })

  it('splits insert from instruction templates and drops disabled ones', async () => {
    fetchPromptTemplatesMock.mockResolvedValue([
      template({ id: 1, name: 'a', kind: 'insert' }),
      template({ id: 2, name: 'b', kind: 'instruction' }),
      template({ id: 3, name: 'c', kind: 'instruction', enabled: false }),
    ])
    const store = usePromptTemplatesStore()
    await store.load()

    expect(store.insertTemplates.map(item => item.id)).toEqual([1])
    expect(store.instructionTemplates.map(item => item.id)).toEqual([2])
  })

  it('keeps the order the API returned and lists each category once', async () => {
    // The API returns rows already ordered by sort, so the store must not re-sort;
    // the pickers fold these rows into category blocks themselves.
    fetchPromptTemplatesMock.mockResolvedValue([
      template({ id: 1, name: 'a', category: 'Office' }),
      template({ id: 2, name: 'b', category: 'Office' }),
      template({ id: 3, name: 'c', category: 'Dev' }),
      template({ id: 4, name: 'd', category: '' }),
    ])
    const store = usePromptTemplatesStore()
    await store.load()

    expect(store.templates.map(item => [item.id, item.category]))
      .toEqual([[1, 'Office'], [2, 'Office'], [3, 'Dev'], [4, '']])
    expect(store.categories).toEqual(['Office', 'Dev', ''])
  })

  it('folds only the switched-on instruction templates into a run', async () => {
    fetchPromptTemplatesMock.mockResolvedValue([
      template({ id: 1, name: 'a', kind: 'insert', content: 'insert me' }),
      template({ id: 2, name: 'b', kind: 'instruction', content: 'be terse' }),
      template({ id: 3, name: 'c', kind: 'instruction', content: 'cite sources' }),
    ])
    const store = usePromptTemplatesStore()
    await store.load()

    expect(store.instructionsFor('s1')).toBe('')

    store.toggleInstruction('s1', 2)
    expect(store.instructionsFor('s1')).toBe('be terse')

    store.toggleInstruction('s1', 3)
    expect(store.instructionsFor('s1')).toBe('be terse\n\ncite sources')

    // Insert-kind templates never reach the system prompt, even if selected.
    store.toggleInstruction('s1', 1)
    expect(store.instructionsFor('s1')).toBe('be terse\n\ncite sources')

    store.toggleInstruction('s1', 2)
    expect(store.instructionsFor('s1')).toBe('cite sources')
  })

  it('is scoped per session and survives a reload', async () => {
    fetchPromptTemplatesMock.mockResolvedValue([template({ id: 7, kind: 'instruction', content: 'x' })])
    const store = usePromptTemplatesStore()
    await store.load()
    store.toggleInstruction('s1', 7)

    expect(store.instructionsFor('s1')).toBe('x')
    expect(store.instructionsFor('s2')).toBe('')
    expect(localStorage.getItem(SELECTION_KEY)).toContain('s1')

    // A fresh store instance (page reload) reads the same selection back.
    setActivePinia(createPinia())
    const reloaded = usePromptTemplatesStore()
    fetchPromptTemplatesMock.mockResolvedValue([template({ id: 7, kind: 'instruction', content: 'x' })])
    await reloaded.load()
    expect(reloaded.instructionsFor('s1')).toBe('x')
  })

  it('forgets the selection of a deleted session only', async () => {
    fetchPromptTemplatesMock.mockResolvedValue([template({ id: 7, kind: 'instruction', content: 'x' })])
    const store = usePromptTemplatesStore()
    await store.load()
    store.toggleInstruction('s1', 7)
    store.toggleInstruction('s2', 7)

    store.clearSession('s1')

    expect(store.instructionsFor('s1')).toBe('')
    expect(store.instructionsFor('s2')).toBe('x')
    expect(localStorage.getItem(SELECTION_KEY)).not.toContain('s1')
  })

  it('drops selections whose template was disabled or deleted', async () => {
    fetchPromptTemplatesMock.mockResolvedValue([template({ id: 7, kind: 'instruction', content: 'x' })])
    const store = usePromptTemplatesStore()
    await store.load()
    store.toggleInstruction('s1', 7)
    expect(store.instructionsFor('s1')).toBe('x')

    fetchPromptTemplatesMock.mockResolvedValue([template({ id: 7, kind: 'instruction', content: 'x', enabled: false })])
    await store.load(true)
    expect(store.instructionsFor('s1')).toBe('')

    fetchPromptTemplatesMock.mockResolvedValue([])
    await store.load(true)
    expect(store.activeInstructionIds('s1')).toEqual([])
    expect(localStorage.getItem(SELECTION_KEY)).toBe('{}')
  })

  it('keeps the failure visible instead of pretending the shelf is empty', async () => {
    fetchPromptTemplatesMock.mockRejectedValue(new Error('Unauthorized'))
    const store = usePromptTemplatesStore()
    await store.ensureLoaded()

    expect(store.loadError).toBe('Unauthorized')
    expect(store.templates).toEqual([])
  })
})
