import {
  FASTGPT_AGENT_SEEDS,
  FASTGPT_CHAT_APP_ID,
  fastGptAgentView,
  fastGptApiKey,
  fastGptBaseUrl,
  fastGptSceneForName,
  fastGptShortName,
  fetchFastGptAppList,
  type FastGptAgentSeed,
  type FastGptRemoteApp,
} from '../infrastructure/fastgpt/agent-catalog'

/**
 * 首页场景下的 FastGPT 智能体卡片。
 *
 * GET `/api/studio/fastgpt-agents?app=btit` → `{ baseUrl, source, agents[] }`。
 * 读接口不做鉴权、失败也不抛 500：卡片是增量入口，拿不到就少个入口，不该拖垮对话框。
 */

/** 实时列表命中的场景，与内置清单合并成同一形状。 */
function mergeRemote(remote: readonly FastGptRemoteApp[]): FastGptAgentSeed[] {
  const seeds = new Map(FASTGPT_AGENT_SEEDS.map(seed => [seed.appId, seed]))
  const out: FastGptAgentSeed[] = []
  for (const app of remote) {
    const sceneId = fastGptSceneForName(app.name)
    if (!sceneId) continue
    const seed = seeds.get(app.appId)
    const name = app.name.trim() || seed?.name || app.appId
    out.push({
      appId: app.appId,
      sceneId,
      name,
      short: seed?.short ?? fastGptShortName(name),
      desc: app.intro.trim() || seed?.desc || '',
    })
  }
  return out
}

export async function list(ctx: any) {
  try {
    const appId = String(ctx.query?.app ?? FASTGPT_CHAT_APP_ID).trim() || FASTGPT_CHAT_APP_ID
    const baseUrl = fastGptBaseUrl()

    let seeds: FastGptAgentSeed[] = [...FASTGPT_AGENT_SEEDS]
    let source = 'builtin'

    if (appId === FASTGPT_CHAT_APP_ID) {
      const remote = await fetchFastGptAppList(baseUrl, fastGptApiKey())
      if (remote.length > 0) {
        const merged = mergeRemote(remote)
        if (merged.length > 0) {
          seeds = merged
          source = 'fastgpt'
        }
      }
    }

    ctx.status = 200
    ctx.body = {
      baseUrl,
      source,
      agents: seeds.map(seed => fastGptAgentView(seed, baseUrl)),
    }
  } catch (error: any) {
    ctx.status = 200
    ctx.body = { baseUrl: fastGptBaseUrl(), source: 'error', agents: [], error: error?.message || 'fastgpt agents unavailable' }
  }
}
