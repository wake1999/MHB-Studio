import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  createPromptTemplate,
  deletePromptTemplate,
  fetchPromptTemplates,
  movePromptTemplate,
  setPromptTemplateEnabled,
  updatePromptTemplate,
  type PromptTemplate,
  type PromptTemplateInput,
  type PromptTemplateMoveDirection,
} from '@/api/studio/prompt-templates'

/**
 * Prompt templates shared between the composer, the chat tool panel and the
 * manager view.
 *
 * The server returns rows in author order (`sort`, then name), and the pickers
 * render them as a two-level shelf: kind → category → templates. Rows keep that
 * order here; the pickers fold them into category blocks themselves, because the
 * right column also filters the list by its search box first.
 *
 * Which `instruction` templates are switched on is a **per-session** choice that
 * has no server column (sessions have no system-prompt field), so it lives here
 * and is persisted per session id. Every read filters by the templates that
 * still exist and are still enabled, so a deleted/disabled template cannot leak
 * into a run.
 */

const SELECTION_STORAGE_KEY = 'hermes_prompt_template_selection_v1'

type SelectionMap = Record<string, number[]>

function readSelection(): SelectionMap {
  try {
    const raw = localStorage.getItem(SELECTION_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    const result: SelectionMap = {}
    for (const [sessionId, ids] of Object.entries(parsed as Record<string, unknown>)) {
      if (!sessionId || !Array.isArray(ids)) continue
      const clean = ids.map(value => Number(value)).filter(value => Number.isSafeInteger(value) && value > 0)
      if (clean.length > 0) result[sessionId] = Array.from(new Set(clean))
    }
    return result
  } catch {
    return {}
  }
}

export const usePromptTemplatesStore = defineStore('promptTemplates', () => {
  const templates = ref<PromptTemplate[]>([])
  const loading = ref(false)
  const loaded = ref(false)
  const loadError = ref('')
  /** sessionId → ids of the instruction templates switched on for that session. */
  const selection = ref<SelectionMap>(readSelection())

  const enabledTemplates = computed(() => templates.value.filter(template => template.enabled))
  const insertTemplates = computed(() => enabledTemplates.value.filter(template => template.kind === 'insert'))
  const instructionTemplates = computed(() => enabledTemplates.value.filter(template => template.kind === 'instruction'))
  /** Category names in shelf order, for the composer strip and the manager datalist. */
  const categories = computed(() => {
    const seen: string[] = []
    for (const template of templates.value) {
      if (!seen.includes(template.category)) seen.push(template.category)
    }
    return seen
  })
  const templateById = computed(() => new Map(templates.value.map(template => [template.id, template])))

  function persistSelection() {
    try {
      localStorage.setItem(SELECTION_STORAGE_KEY, JSON.stringify(selection.value))
    } catch {
      /* A full quota must not break sending. */
    }
  }

  /** Ids switched on for a session, filtered down to rows that still apply. */
  function activeInstructionIds(sessionId: string | null | undefined): number[] {
    if (!sessionId) return []
    const ids = selection.value[sessionId] || []
    return ids.filter(id => templateById.value.get(id)?.kind === 'instruction' && templateById.value.get(id)?.enabled)
  }

  function activeInstructions(sessionId: string | null | undefined): PromptTemplate[] {
    return activeInstructionIds(sessionId)
      .map(id => templateById.value.get(id))
      .filter((template): template is PromptTemplate => template !== undefined)
  }

  function isInstructionActive(sessionId: string | null | undefined, id: number): boolean {
    return activeInstructionIds(sessionId).includes(id)
  }

  function setInstructions(sessionId: string | null | undefined, ids: number[]) {
    if (!sessionId) return
    const clean = Array.from(new Set(ids.filter(value => Number.isSafeInteger(value) && value > 0)))
    if (clean.length === 0) {
      delete selection.value[sessionId]
    } else {
      selection.value[sessionId] = clean
    }
    persistSelection()
  }

  function toggleInstruction(sessionId: string | null | undefined, id: number) {
    if (!sessionId) return
    const current = activeInstructionIds(sessionId)
    setInstructions(sessionId, current.includes(id) ? current.filter(value => value !== id) : [...current, id])
  }

  function clearSession(sessionId: string | null | undefined) {
    if (!sessionId || !(sessionId in selection.value)) return
    delete selection.value[sessionId]
    persistSelection()
  }

  /** The instruction block for a run: enabled templates in list order, joined. */
  function instructionsFor(sessionId: string | null | undefined): string {
    return activeInstructions(sessionId)
      .map(template => template.content.trim())
      .filter(Boolean)
      .join('\n\n')
  }

  async function load(force = false): Promise<void> {
    if (loaded.value && !force) return
    loading.value = true
    try {
      templates.value = await fetchPromptTemplates()
      loaded.value = true
      loadError.value = ''
      // Drop selections pointing at rows that no longer exist or are disabled.
      for (const sessionId of Object.keys(selection.value)) {
        const kept = activeInstructionIds(sessionId)
        if (kept.length === 0) delete selection.value[sessionId]
        else selection.value[sessionId] = kept
      }
      persistSelection()
    } catch (error) {
      loadError.value = error instanceof Error ? error.message : 'Failed to load templates'
      throw error
    } finally {
      loading.value = false
    }
  }

  async function ensureLoaded(): Promise<void> {
    if (loaded.value || loading.value) return
    try {
      await load()
    } catch {
      /* The composer stays usable; the pickers surface `loadError` with a retry. */
    }
  }

  async function create(input: PromptTemplateInput): Promise<PromptTemplate> {
    const created = await createPromptTemplate(input)
    await load(true)
    return created
  }

  async function update(id: number, input: Partial<PromptTemplateInput>): Promise<PromptTemplate> {
    const updated = await updatePromptTemplate(id, input)
    await load(true)
    return updated
  }

  async function setEnabled(id: number, enabled: boolean): Promise<void> {
    await setPromptTemplateEnabled(id, enabled)
    await load(true)
  }

  async function move(id: number, direction: PromptTemplateMoveDirection): Promise<void> {
    await movePromptTemplate(id, direction)
    await load(true)
  }

  async function remove(id: number): Promise<void> {
    await deletePromptTemplate(id)
    for (const sessionId of Object.keys(selection.value)) {
      if (selection.value[sessionId].includes(id)) {
        selection.value[sessionId] = selection.value[sessionId].filter(value => value !== id)
        if (selection.value[sessionId].length === 0) delete selection.value[sessionId]
      }
    }
    persistSelection()
    await load(true)
  }

  return {
    templates,
    loading,
    loaded,
    loadError,
    categories,
    enabledTemplates,
    insertTemplates,
    instructionTemplates,
    activeInstructionIds,
    activeInstructions,
    isInstructionActive,
    setInstructions,
    toggleInstruction,
    clearSession,
    instructionsFor,
    load,
    ensureLoaded,
    create,
    update,
    setEnabled,
    move,
    remove,
  }
})
