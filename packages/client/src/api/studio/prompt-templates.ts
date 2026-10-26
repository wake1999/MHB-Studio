import { request } from '@/api/client'

/**
 * Prompt templates (提示词模板).
 *
 * `kind` decides the landing spot:
 * - `insert`      — pasted into the composer draft, sent as an ordinary user message.
 * - `instruction` — appended to the system prompt of every turn while enabled.
 *
 * `category` groups the picker rows (`''` = uncategorised) and `sort` carries the
 * order the author arranged, which is the order the pill rows render in.
 */
export type PromptTemplateKind = 'insert' | 'instruction'
export type PromptTemplateMoveDirection = 'up' | 'down'
/** Which composer surface the shelf shows on; `''` = infer from the category name. */
export type PromptTemplateDomain = '' | 'chat' | 'create'

export interface PromptTemplate {
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
  description?: string
  kind?: PromptTemplateKind
  domain?: PromptTemplateDomain
  content: string
  enabled?: boolean
  category?: string
  sort?: number
}

export async function fetchPromptTemplates(): Promise<PromptTemplate[]> {
  const res = await request<{ templates: PromptTemplate[] }>('/api/studio/prompt-templates')
  return Array.isArray(res.templates) ? res.templates : []
}

export async function createPromptTemplate(input: PromptTemplateInput): Promise<PromptTemplate> {
  const res = await request<{ template: PromptTemplate }>('/api/studio/prompt-templates', {
    method: 'POST',
    body: JSON.stringify(input),
  })
  return res.template
}

export async function updatePromptTemplate(id: number, input: Partial<PromptTemplateInput>): Promise<PromptTemplate> {
  const res = await request<{ template: PromptTemplate }>(
    `/api/studio/prompt-templates/${encodeURIComponent(String(id))}`,
    {
      method: 'PATCH',
      body: JSON.stringify(input),
    },
  )
  return res.template
}

export async function setPromptTemplateEnabled(id: number, enabled: boolean): Promise<PromptTemplate> {
  const res = await request<{ template: PromptTemplate }>(
    `/api/studio/prompt-templates/${encodeURIComponent(String(id))}/enabled`,
    {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    },
  )
  return res.template
}

export async function movePromptTemplate(
  id: number,
  direction: PromptTemplateMoveDirection,
): Promise<PromptTemplate> {
  const res = await request<{ template: PromptTemplate }>(
    `/api/studio/prompt-templates/${encodeURIComponent(String(id))}/move`,
    {
      method: 'POST',
      body: JSON.stringify({ direction }),
    },
  )
  return res.template
}

export async function deletePromptTemplate(id: number): Promise<void> {
  await request(`/api/studio/prompt-templates/${encodeURIComponent(String(id))}`, {
    method: 'DELETE',
  })
}
