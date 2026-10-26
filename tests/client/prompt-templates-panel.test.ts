// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent } from 'vue'
import PromptTemplatesPanel from '@/components/hermes/chat/PromptTemplatesPanel.vue'
import { INSERT_PROMPT_TEMPLATE_EVENT } from '@/utils/hermes/prompt-templates'
import type { PromptTemplate } from '@/api/studio/prompt-templates'

/**
 * The right-column library is where the composer hands off to the template shelf,
 * so its contract is: enabled rows only, kind → category blocks, an insert click
 * becomes a composer event, an instruction click flips the session selection.
 */

const fetchPromptTemplatesMock = vi.hoisted(() => vi.fn())
const pushMock = vi.hoisted(() => vi.fn())

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: pushMock }),
}))

vi.mock('naive-ui', () => ({
  NButton: defineComponent({
    emits: ['click'],
    template: '<button type="button" @click="$emit(\'click\')"><slot /></button>',
  }),
  NSpin: { template: '<div><slot /></div>' },
}))

vi.mock('@/api/studio/prompt-templates', () => ({
  fetchPromptTemplates: fetchPromptTemplatesMock,
  createPromptTemplate: vi.fn(),
  updatePromptTemplate: vi.fn(),
  setPromptTemplateEnabled: vi.fn(),
  movePromptTemplate: vi.fn(),
  deletePromptTemplate: vi.fn(),
}))

vi.mock('@/stores/hermes/chat', () => ({
  useChatStore: () => ({ activeSessionId: 'session-1' }),
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

const shelf = [
  template({ id: 1, name: '代码评审', category: '开发', kind: 'insert', content: '帮我评审这段代码' }),
  template({ id: 2, name: '写周报', category: '开发', kind: 'insert', content: '把本周的事写成周报' }),
  template({ id: 3, name: '随手记', category: '', kind: 'insert', content: '随手记一条' }),
  template({ id: 4, name: '先列风险', category: '开发', kind: 'instruction', content: '先列风险。' }),
  template({ id: 5, name: '停用中的', category: '开发', kind: 'instruction', content: '不该出现', enabled: false }),
]

async function mountPanel() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const wrapper = mount(PromptTemplatesPanel, { global: { plugins: [pinia] } })
  await flushPromises()
  return wrapper
}

describe('PromptTemplatesPanel', () => {
  beforeEach(() => {
    localStorage.clear()
    fetchPromptTemplatesMock.mockReset()
    fetchPromptTemplatesMock.mockResolvedValue(shelf)
    pushMock.mockReset()
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('renders enabled rows in kind → category blocks and hides disabled ones', async () => {
    const wrapper = await mountPanel()

    const items = wrapper.findAll('.prompt-templates-panel__item')
    expect(items.map(item => item.find('.prompt-templates-panel__name').text()))
      .toEqual(['代码评审', '写周报', '随手记', '先列风险'])
    expect(wrapper.text()).toContain('promptTemplates.kindInsert')
    expect(wrapper.text()).toContain('promptTemplates.kindInstruction')
    // 开发 + the uncategorised bucket in the insert block, then 开发 for the
    // instruction block.
    expect(wrapper.findAll('.prompt-templates-panel__section-title').map(node => node.text()))
      .toEqual(['开发', 'promptTemplates.uncategorized', '开发'])
    expect(wrapper.text()).not.toContain('不该出现')
  })

  it('sends an insert template to the composer as an event, id included', async () => {
    const wrapper = await mountPanel()
    const received: Array<{ id?: number; content: string }> = []
    const listener = (event: Event) => received.push((event as CustomEvent<{ id?: number; content: string }>).detail)
    window.addEventListener(INSERT_PROMPT_TEMPLATE_EVENT, listener)

    await wrapper.findAll('.prompt-templates-panel__item')[0].trigger('click')

    window.removeEventListener(INSERT_PROMPT_TEMPLATE_EVENT, listener)
    // The id is what lets a second click unpick instead of pasting twice.
    expect(received).toEqual([{ id: 1, content: '帮我评审这段代码' }])
  })

  it('switches an instruction template on for the session and remembers it', async () => {
    const wrapper = await mountPanel()
    const instruction = wrapper.findAll('.prompt-templates-panel__item')[3]

    expect(instruction.classes()).not.toContain('active')
    await instruction.trigger('click')

    expect(instruction.classes()).toContain('active')
    expect(instruction.find('.prompt-templates-panel__state').text()).toBe('promptTemplates.instructionOn')
    expect(localStorage.getItem(SELECTION_KEY)).toContain('session-1')

    await instruction.trigger('click')
    expect(instruction.classes()).not.toContain('active')
    expect(localStorage.getItem(SELECTION_KEY)).not.toContain('session-1')
  })

  it('filters by the search box and says so when nothing matches', async () => {
    const wrapper = await mountPanel()

    await wrapper.find('input[type="search"]').setValue('周报')
    expect(wrapper.findAll('.prompt-templates-panel__item').map(item => item.text()))
      .toEqual(['写周报'])

    await wrapper.find('input[type="search"]').setValue('没有这个东西')
    expect(wrapper.findAll('.prompt-templates-panel__item')).toHaveLength(0)
    expect(wrapper.text()).toContain('promptTemplates.noMatch')
  })

  it('keeps a failed load visible and retries from the panel', async () => {
    fetchPromptTemplatesMock.mockRejectedValue(new Error('Unauthorized'))
    const wrapper = await mountPanel()

    expect(wrapper.text()).toContain('promptTemplates.loadFailed')

    fetchPromptTemplatesMock.mockResolvedValue(shelf)
    await wrapper.find('.prompt-templates-panel__error button').trigger('click')
    await flushPromises()

    expect(wrapper.text()).not.toContain('promptTemplates.loadFailed')
    expect(wrapper.findAll('.prompt-templates-panel__item').length).toBeGreaterThan(0)
  })

  it('opens the manager page from the footer', async () => {
    const wrapper = await mountPanel()

    await wrapper.find('.prompt-templates-panel__foot button').trigger('click')

    expect(pushMock).toHaveBeenCalledWith({ name: 'hermes.promptTemplates' })
  })
})
