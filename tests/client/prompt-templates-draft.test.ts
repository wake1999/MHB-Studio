import { describe, expect, it } from 'vitest'
import {
  appliedInsertTemplates,
  insertTemplateBlock,
  insertTemplateCategories,
  removeTemplateBlock,
} from '@/utils/hermes/prompt-templates'
import type { PromptTemplate } from '@/api/studio/prompt-templates'

/**
 * The insert pills are a multi-pick toggle: pick several and each one lands in the
 * draft as its own block; pick one again and only that block goes away. These
 * helpers are the whole behaviour, so they get tested on their own.
 */

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

const review = template({ id: 1, name: '代码评审', content: '请评审下面这段代码。' })
const weekly = template({ id: 2, name: '写周报', content: '把这些事整理成周报。' })

describe('prompt template draft helpers', () => {
  it('collapses the shelf into the category pills the composer draws', () => {
    const shelf = [
      template({ id: 1, category: '开发' }),
      template({ id: 2, category: '开发' }),
      template({ id: 3, category: '写作' }),
      template({ id: 4, category: '' }),
      template({ id: 5, category: '写作' }),
    ]

    expect(insertTemplateCategories(shelf)).toEqual(['开发', '写作', ''])
    expect(insertTemplateCategories([])).toEqual([])
  })

  it('reports every picked template, not just the one matching the whole draft', () => {
    const draft = `请评审下面这段代码。\n\n把这些事整理成周报。\n\n顺便看下这段日志`

    expect(appliedInsertTemplates(draft, [review, weekly]).map(item => item.id)).toEqual([1, 2])
    expect(appliedInsertTemplates('只写了一点', [review, weekly])).toEqual([])
    // An empty content must never count as "picked".
    expect(appliedInsertTemplates('abc', [template({ id: 9, content: '   ' })])).toEqual([])
  })

  it('drops a template into an empty draft as a plain block', () => {
    expect(insertTemplateBlock('', review.content, 0)).toEqual({
      text: '请评审下面这段代码。',
      caret: '请评审下面这段代码。'.length,
    })
  })

  it('keeps the caret inside the inserted block and pads it with blank lines', () => {
    const draft = '先看这段日志，再给我结论'

    const fromStart = insertTemplateBlock(draft, review.content, 0)
    expect(fromStart.text).toBe(`请评审下面这段代码。\n\n先看这段日志，再给我结论`)
    expect(fromStart.caret).toBe('请评审下面这段代码。'.length)

    const fromEnd = insertTemplateBlock(draft, weekly.content, draft.length)
    expect(fromEnd.text).toBe(`先看这段日志，再给我结论\n\n把这些事整理成周报。`)
    expect(fromEnd.caret).toBe(fromEnd.text.length)

    const inMiddle = insertTemplateBlock(`${draft}\n\n收尾`, review.content, draft.length)
    expect(inMiddle.text).toBe(`先看这段日志，再给我结论\n\n请评审下面这段代码。\n\n收尾`)
  })

  it('takes one block back out without touching the other picks', () => {
    const draft = `请评审下面这段代码。\n\n把这些事整理成周报。\n\n我自己补一句`

    expect(removeTemplateBlock(draft, review.content)).toBe(`把这些事整理成周报。\n\n我自己补一句`)
    expect(removeTemplateBlock(draft, weekly.content)).toBe(`请评审下面这段代码。\n\n我自己补一句`)
  })

  it('is a no-op when the block is not in the draft', () => {
    expect(removeTemplateBlock('只有我自己的话', review.content)).toBe('只有我自己的话')
    expect(removeTemplateBlock('', review.content)).toBe('')
  })

  it('round-trips: picking all of them then unpicking all of them restores the draft', () => {
    const draft = '我自己开头的一句'
    const first = insertTemplateBlock(draft, review.content, draft.length)
    const second = insertTemplateBlock(first.text, weekly.content, first.text.length)

    const backToFirst = removeTemplateBlock(second.text, weekly.content)
    expect(backToFirst).toBe(first.text)
    expect(removeTemplateBlock(backToFirst, review.content)).toBe(draft)
  })
})
