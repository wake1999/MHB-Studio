import {
  createChatApp,
  deleteChatApp,
  listChatApps,
  updateChatApp,
  type ChatAppRow,
} from '../repositories/chat-app-store'

/**
 * 「发现应用」目录。
 *
 * GET 是给对话框用的（只回启用中的），`?all=1` 给管理面板用（含停用的）。
 * 消费方拿不到就退回内置常量，所以 GET 出问题也只回空列表，不抛 500。
 * 写接口按输入校验回 400、找不到回 404，错误信息直接给人看。
 */

function appView(row: ChatAppRow) {
  return { id: row.id, sort: row.sort, enabled: row.enabled, ...row.payload }
}

function readBody(ctx: any): Record<string, unknown> {
  const body = ctx.request?.body
  return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {}
}

export async function list(ctx: any) {
  try {
    const includeDisabled = String(ctx.query?.all ?? '') === '1'
    const apps = listChatApps({ enabledOnly: !includeDisabled }).map(appView)
    ctx.status = 200
    ctx.body = { apps }
  } catch (error: any) {
    ctx.status = 200
    ctx.body = { apps: [], error: error?.message || 'chat apps unavailable' }
  }
}

export async function create(ctx: any) {
  const body = readBody(ctx)
  const id = typeof body.id === 'string' ? body.id : ''
  const result = createChatApp(id, {
    payload: body.payload,
    enabled: body.enabled !== false,
    sort: Number.isFinite(Number(body.sort)) ? Number(body.sort) : undefined,
  })
  if (!result.ok) {
    ctx.status = 400
    ctx.body = { error: result.error }
    return
  }
  ctx.status = 200
  ctx.body = { app: appView(result.app) }
}

export async function update(ctx: any) {
  const id = String(ctx.params?.id ?? '').trim()
  if (!id) {
    ctx.status = 400
    ctx.body = { error: '缺少应用标识' }
    return
  }
  const body = readBody(ctx)
  const result = updateChatApp(id, {
    payload: body.payload,
    enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
    sort: Number.isFinite(Number(body.sort)) ? Number(body.sort) : undefined,
  })
  if (!result.ok) {
    ctx.status = result.error === '应用不存在' ? 404 : 400
    ctx.body = { error: result.error }
    return
  }
  ctx.status = 200
  ctx.body = { app: appView(result.app) }
}

export async function remove(ctx: any) {
  const id = String(ctx.params?.id ?? '').trim()
  const removed = deleteChatApp(id)
  if (!removed) {
    ctx.status = 404
    ctx.body = { error: '应用不存在' }
    return
  }
  ctx.status = 200
  ctx.body = { id }
}
