import { request } from '@/api/client'

/**
 * 内嵌地址：FastGPT 本体对页面发 `X-Frame-Options: DENY`，宿主机上跑了一个只去掉
 * 该响应头的小反代（3010，同域不同端口，登录态自动共享），Studio 的 iframe 走它。
 */
export const FASTGPT_EMBED_BASE = 'http://146.56.201.241:3010'

/**
 * 首页场景下的 FastGPT 智能体卡片。
 *
 * 数据源 `/api/studio/fastgpt-agents`（服务端内置目录，配了 FASTGPT_API_KEY 时实时
 * 刷新名称/简介）。拿不到就回空数组 —— 卡片是增量入口，缺了不影响对话。
 */
export interface FastGptAgent {
  readonly appId: string
  /** 挂在哪个场景（chat app 的 scene.id）。 */
  readonly sceneId: string
  /** 场景显示名，面板按它分组。 */
  readonly sceneLabel: string
  readonly name: string
  /** 卡片封面上的短名。 */
  readonly short: string
  readonly desc: string
  /** 封面渐变。 */
  readonly tint: string
  /** FastGPT 对话页。 */
  readonly chatUrl: string
  /** FastGPT 编排页。 */
  readonly manageUrl: string
}

export interface FastGptAgentList {
  readonly baseUrl: string
  readonly source: string
  readonly agents: readonly FastGptAgent[]
}

export async function fetchFastGptAgents(appId = 'btit'): Promise<FastGptAgent[]> {
  try {
    const res = await request<{ agents?: FastGptAgent[] }>(
      `/api/studio/fastgpt-agents?app=${encodeURIComponent(appId)}`,
    )
    return Array.isArray(res?.agents) ? res.agents : []
  } catch {
    return []
  }
}
