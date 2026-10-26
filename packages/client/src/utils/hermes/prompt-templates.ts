/**
 * Cross-component events and draft helpers for prompt templates (提示词模板).
 *
 * The library lives in the chat tool panel (the right column) while the composer
 * owns the draft text, so the two talk over `window` events — the same pattern
 * the workspace-file preview and the desktop browser panel already use.
 */

import type { PromptTemplate } from '@/api/studio/prompt-templates'

/** Panel → composer: paste this template into the draft at the caret. */
export const INSERT_PROMPT_TEMPLATE_EVENT = 'hermes:insert-prompt-template'

/** Composer → shell: open the right column on the template tab. */
export const OPEN_PROMPT_TEMPLATES_PANEL_EVENT = 'hermes:open-prompt-templates-panel'

export interface InsertPromptTemplateDetail {
  id?: number
  content: string
}

/**
 * The insert pills are toggles: several can be picked at once, each one lands in
 * the draft as its own block, and picking it again takes it back out. Everything
 * below works on plain strings so the composer stays the only owner of the draft.
 */

const BLOCK_SEPARATOR = '\n\n'

function normalizeDraft(draft: string): string {
  return draft.replace(/\r\n/g, '\n')
}

/**
 * The category keys behind the composer pills, in shelf order. The composer draws
 * one pill per category and lists that shelf's templates underneath it, so the
 * duplicated categories have to collapse here ('' is the uncategorised bucket).
 */
export function insertTemplateCategories(templates: PromptTemplate[]): string[] {
  const seen = new Set<string>()
  const categories: string[] = []
  for (const template of templates) {
    const category = template.category ?? ''
    if (seen.has(category)) continue
    seen.add(category)
    categories.push(category)
  }
  return categories
}

/** Insert templates whose content already sits in the draft. */
export function appliedInsertTemplates(draft: string, templates: PromptTemplate[]): PromptTemplate[] {
  const text = normalizeDraft(draft)
  return templates.filter(template => {
    const content = template.content.trim()
    return content.length > 0 && text.includes(content)
  })
}

/** Paste a template into the draft as its own block, leaving the caret after it. */
export function insertTemplateBlock(draft: string, content: string, caret: number): { text: string; caret: number } {
  const block = content.trim()
  if (!block) return { text: draft, caret }

  const text = normalizeDraft(draft)
  const at = Math.max(0, Math.min(caret, text.length))
  const before = text.slice(0, at)
  const after = text.slice(at)
  const leading = before.trim().length > 0 && !before.endsWith('\n') ? BLOCK_SEPARATOR : ''
  const trailing = after.trim().length > 0 && !after.startsWith('\n') ? BLOCK_SEPARATOR : ''
  const inserted = `${leading}${block}${trailing}`

  // The caret sits at the end of the pasted block, ahead of the separator we added.
  return { text: `${before}${inserted}${after}`, caret: before.length + leading.length + block.length }
}

/** Take the template back out, dropping the block break that joined it to the draft. */
export function removeTemplateBlock(draft: string, content: string): string {
  const block = content.trim()
  if (!block) return draft

  const text = normalizeDraft(draft)
  const index = text.indexOf(block)
  if (index === -1) return draft

  const before = text.slice(0, index)
  const after = text.slice(index + block.length)
  if (before.endsWith(BLOCK_SEPARATOR)) return `${before.slice(0, -BLOCK_SEPARATOR.length)}${after}`
  if (after.startsWith(BLOCK_SEPARATOR)) return `${before}${after.slice(BLOCK_SEPARATOR.length)}`
  if (before.endsWith('\n')) return `${before.slice(0, -1)}${after}`
  if (after.startsWith('\n')) return `${before}${after.slice(1)}`
  return `${before}${after}`
}

/**
 * The three domains above the category pills (办公 / 开发 / 设计). A category
 * joins one by the words in its name; `null` means it joins none, and such a
 * category stays visible under every domain so the composer never hides a shelf
 * the author created.
 */
export const PROMPT_TEMPLATE_DOMAINS = [
  { id: 'chat', labelKey: 'promptTemplates.domainChat', words: ['办公', '周报', '邮件', '总结', '材料', '方案', '决策', '汇报', '报告', '会议', '文案', '润色', '视觉', '配色', '配图', '排版'] },
  { id: 'create', labelKey: 'promptTemplates.domainCreate', words: ['代码', '报错', '排查', '测试', '重构', '接口', '数据库', '部署', '性能', '设计', '界面'] },
] as const

export type PromptTemplateDomainId = (typeof PROMPT_TEMPLATE_DOMAINS)[number]['id']

export function promptTemplateDomainFor(category: string): PromptTemplateDomainId | null {
  const label = category.trim()
  if (!label) return null
  for (const domain of PROMPT_TEMPLATE_DOMAINS) {
    if (domain.words.some(word => label.includes(word))) return domain.id
  }
  return null
}

/** The categories the composer lists under one domain (null keeps every category). */
export function categoriesForDomain(
  categories: string[],
  domain: PromptTemplateDomainId | null,
): string[] {
  if (domain === null) return categories
  return categories.filter((category) => {
    const owner = promptTemplateDomainFor(category)
    return owner === null || owner === domain
  })
}

/**
 * The surface a template is filed under: the choice made in the template manager
 * wins, and only rows left on `''` (自动) fall back to the category-name words.
 */
export function promptTemplateDomainOf(template: PromptTemplate): PromptTemplateDomainId | null {
  if (template.domain === 'chat' || template.domain === 'create') return template.domain
  return promptTemplateDomainFor(template.category)
}

/** Templates visible on one surface; `null` keeps every row, like `categoriesForDomain`. */
export function templatesForDomain(
  templates: PromptTemplate[],
  domain: PromptTemplateDomainId | null,
): PromptTemplate[] {
  if (domain === null) return templates
  return templates.filter((template) => {
    const owner = promptTemplateDomainOf(template)
    return owner === null || owner === domain
  })
}
