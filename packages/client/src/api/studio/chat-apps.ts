import { request } from '@/api/client'

/**
 * 「发现应用」目录。
 *
 * 文案按语言分片：`text` / `scene.text` 的 key 是语言代码（`zh`、`en`…），`zh` 视为
 * 基准语言，其他语言缺字段时前端回退到它。`quickPrompts` 是提示词正文，单语，不切片。
 *
 * 读接口分两档：给对话框的那份静默降级（失败回空数组，调用方退回内置常量）；
 * 给管理面板的那份照常抛错，好让运营看到「为什么没保存上」。
 */
export interface ChatAppTextDto {
  name: string
  desc: string
  heroTitle: string
  heroSubtitle: string
  placeholder: string
}

export interface ChatAppSceneTextDto {
  label: string
  placeholder: string
}

export interface ChatAppQuickPromptDto {
  label: string
  text: string
}

export interface ChatAppSceneDto {
  id: string
  text: Record<string, ChatAppSceneTextDto>
  quickPrompts?: ChatAppQuickPromptDto[]
}

export interface ChatAppDto {
  id: string
  sort?: number
  enabled?: boolean
  iconPaths?: string[]
  tint?: string
  text: Record<string, ChatAppTextDto>
  scenes?: ChatAppSceneDto[]
}

export interface ChatAppWriteInput {
  payload: unknown
  enabled?: boolean
  sort?: number
}

/** 对话框用：只取启用中的，失败静默回空数组。 */
export async function fetchChatApps(): Promise<ChatAppDto[]> {
  try {
    const res = await request<{ apps?: ChatAppDto[] }>('/api/studio/chat-apps')
    return Array.isArray(res?.apps) ? res.apps : []
  } catch {
    return []
  }
}

/** 管理面板用：含停用的，错误照抛。 */
export async function fetchChatAppsForAdmin(): Promise<ChatAppDto[]> {
  const res = await request<{ apps?: ChatAppDto[] }>('/api/studio/chat-apps?all=1')
  return Array.isArray(res?.apps) ? res.apps : []
}

export async function createChatApp(id: string, input: ChatAppWriteInput): Promise<ChatAppDto> {
  const res = await request<{ app: ChatAppDto }>('/api/studio/chat-apps', {
    method: 'POST',
    body: JSON.stringify({ id, ...input }),
  })
  return res.app
}

export async function saveChatApp(id: string, input: ChatAppWriteInput): Promise<ChatAppDto> {
  const res = await request<{ app: ChatAppDto }>(`/api/studio/chat-apps/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  })
  return res.app
}

export async function removeChatApp(id: string): Promise<void> {
  await request<{ id: string }>(`/api/studio/chat-apps/${encodeURIComponent(id)}`, { method: 'DELETE' })
}
