import type { Context } from 'koa'
import { DshPluginError } from '../services/dsh/errors'
import { changeDshWebPlugins, dshPluginUi, getDshPluginMarket, getNativeDshPluginInventory } from '../services'

function errorResponse(ctx: Context, error: unknown) {
  ctx.status = error instanceof DshPluginError ? error.status : 500
  ctx.body = { code: error instanceof DshPluginError ? error.code : 'DSH_PLUGIN_OPERATION_FAILED',
    error: error instanceof DshPluginError ? error.message : 'Unable to access DSH plugin state' }
}
export async function inventory(ctx: Context) {
  try { ctx.body = await getNativeDshPluginInventory() } catch (error) { errorResponse(ctx, error) }
}
/** One page of the community index; installing stays on `change` below. */
export async function market(ctx: Context) {
  try {
    const query = ctx.query
    const page = (value: unknown, fallback: number) => typeof value === 'string' && /^\d{1,6}$/.test(value) ? Number(value) : fallback
    ctx.body = await getDshPluginMarket({
      q: typeof query.q === 'string' ? query.q : '',
      category: typeof query.category === 'string' ? query.category : '',
      sort: typeof query.sort === 'string' ? query.sort : '',
      limit: page(query.limit, 60),
      offset: page(query.offset, 0),
      refresh: query.refresh === '1',
    })
  } catch (error) { errorResponse(ctx, error) }
}
export async function change(ctx: Context) {
  try {
    const revision = ctx.get('If-Match')
    if (!/^"[a-f0-9]{64}"$/.test(revision)) throw new DshPluginError(400, 'DSH_SELECTION_INVALID', 'Expected the Web profile revision in If-Match')
    ctx.body = await changeDshWebPlugins(ctx.request.body, revision.slice(1, -1))
  } catch (error) { errorResponse(ctx, error) }
}
export async function openUi(ctx: Context) {
  try { ctx.body = await dshPluginUi.create(ctx.get('Authorization').replace(/^Bearer /, '')) } catch (error) { errorResponse(ctx, error) }
}
export async function closeUi(ctx: Context) {
  dshPluginUi.remove(ctx.params.id, ctx.get('Authorization').replace(/^Bearer /, ''))
  ctx.status = 204
}
