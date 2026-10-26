/**
 * FastGPT 智能体目录。
 *
 * 首页每个「场景」（BTIT 的数据采集 / 个性化方案生成 / 潜在受试者挖掘）下面挂的
 * 卡片就来自这里。FastGPT 侧的应用本身没有场景字段，所以场景靠应用名映射；
 * 没有 API Key 时用内置清单兜底，配了 `FASTGPT_API_KEY` 就实时拉取应用列表，
 * 名称/简介以 FastGPT 为准，映射不到场景的应用不会出现在卡片里。
 */

export interface FastGptAgentSeed {
  appId: string
  sceneId: string
  name: string
  /** 卡片封面上的一行短名，去掉「数据采集-」这类公共前缀。 */
  short: string
  desc: string
}

/** 卡片挂在哪个 chat app 上。目前只有 BTIT 接了 FastGPT。 */
export const FASTGPT_CHAT_APP_ID = 'btit'

const FALLBACK_TINT = 'linear-gradient(135deg, #6f7f95, #47566b)'

/** 场景显示名，客户端的应用面板按它分组。 */
export const FASTGPT_SCENE_LABELS: Record<string, string> = {
  collect: '数据采集',
  plan: '个性化方案生成',
  recruit: '潜在受试者挖掘',
}

const DEFAULT_BASE_URL = 'http://146.56.201.241:3000'

/**
 * BTIT 三个场景对应的 FastGPT 应用（与 146.56.201.241 上现有应用一致）。
 * 顺序即卡片顺序：先编排/入口，再采集链路，最后两个独立场景。
 */
export const FASTGPT_AGENT_SEEDS: readonly FastGptAgentSeed[] = [
  {
    appId: '6a9fbda643ba3da4fa8de666',
    sceneId: 'collect',
    name: '数据采集-编排调度智能体',
    short: '编排调度',
    desc: '调度采集链路里各子智能体的执行顺序、重试与失败回退。',
  },
  {
    appId: '6a9f890d4462925b788de666',
    sceneId: 'collect',
    name: '数据采集-认证智能体',
    short: '认证',
    desc: '校验调用方身份与云端凭证，签发采集链路的访问令牌。',
  },
  {
    appId: '6a9f890d4462925b788de667',
    sceneId: 'collect',
    name: '数据采集-采集记录智能体',
    short: '采集记录',
    desc: '按记录粒度登记采集数据，做记录级对账与状态流转。',
  },
  {
    appId: '6a9f890d4462925b788de668',
    sceneId: 'collect',
    name: '数据采集-采集文件智能体',
    short: '采集文件',
    desc: '清点设备侧文件（算法 JSON、报告、音视频、波形），登记并与记录对账。',
  },
  {
    appId: '6a9fbda643ba3da4fa8de667',
    sceneId: 'collect',
    name: '数据采集-文件算法关联智能体',
    short: '文件算法关联',
    desc: '把采集文件与算法产出关联，形成文件级可追溯的算法链路。',
  },
  {
    appId: '6a9fcb10346bb4e43a8de666',
    sceneId: 'collect',
    name: '数据采集-文件下载智能体',
    short: '文件下载',
    desc: '按清单把设备侧文件拉到云端，支持断点续传与完整性核对。',
  },
  {
    appId: '6a9fcb10346bb4e43a8de667',
    sceneId: 'collect',
    name: '数据采集-信号解析智能体',
    short: '信号解析',
    desc: '解析设备信号（波形、生理信号）并结构化落库。',
  },
  {
    appId: '6aa0c9714949d182eb8de666',
    sceneId: 'collect',
    name: '数据采集-元数据组合智能体',
    short: '元数据组合',
    desc: '组合元数据定义，生成可执行的采集口径与字段映射。',
  },
  {
    appId: '6aa0c9714949d182eb8de667',
    sceneId: 'collect',
    name: '数据采集-本体组合智能体',
    short: '本体组合',
    desc: '按本体（概念、属性、关系）组合采集结构，供下游查询使用。',
  },
  {
    appId: '6a9fcb10346bb4e43a8de668',
    sceneId: 'collect',
    name: '数据采集-质量校验智能体',
    short: '质量校验',
    desc: '校验采集数据的完整性、一致性与取值范围，输出问题清单。',
  },
  {
    appId: '6aa0dc9b91b8c1cf048de667',
    sceneId: 'collect',
    name: '数据采集-指标报告智能体',
    short: '指标报告',
    desc: '汇总采集指标并生成结构化报告，带异常项与趋势。',
  },
  {
    appId: '6aa3a50056f8e51cf88de666',
    sceneId: 'collect',
    name: '数据采集-LLM助手',
    short: 'LLM 助手',
    desc: '采集链路的自然语言助手，解答字段口径、流程与异常处理。',
  },
  {
    appId: '6aa103342afe5c514b8de666',
    sceneId: 'collect',
    name: '数据采集-LLM助手纯FG版',
    short: 'LLM 助手 · 纯 FG',
    desc: '不依赖外部状态服务的纯 FastGPT 版助手，适合独立演示。',
  },
  {
    appId: '69a987978b217b5660504fee',
    sceneId: 'plan',
    name: '个性化方案生成智能体',
    short: '个性化方案',
    desc: '基于受试者基线特征与既往用药，生成个体化给药方案。',
  },
  {
    appId: '69b7587d330e92f004b3f7b5',
    sceneId: 'recruit',
    name: '潜在受试者挖掘智能体v2.0',
    short: '受试者挖掘',
    desc: '从病历中筛查符合入排标准的候选受试者，并按入组可能性排序。',
  },
]

/** FastGPT 站点地址，可用 `FASTGPT_BASE_URL` 覆盖（不要带结尾斜杠）。 */
export function fastGptBaseUrl(): string {
  const raw = (process.env.FASTGPT_BASE_URL || process.env.FASTGPT_URL || DEFAULT_BASE_URL).trim()
  return raw.replace(/\/+$/, '')
}

/** FastGPT 开放接口密钥；没有就只回内置清单。 */
export function fastGptApiKey(): string {
  return (process.env.FASTGPT_API_KEY || '').trim()
}

/** 应用名 → 场景。改名称前缀就等于改归属，不需要动表。 */
export function fastGptSceneForName(name: string): string | null {
  const value = name.trim()
  if (!value) return null
  if (value.startsWith('数据采集')) return 'collect'
  if (value.includes('受试者')) return 'recruit'
  if (value.includes('方案')) return 'plan'
  return null
}

/** 去掉「数据采集-」这类公共前缀，做卡片封面上的短名。 */
export function fastGptShortName(name: string): string {
  const value = name.trim()
  const cut = value.indexOf('-')
  const short = cut > 0 ? value.slice(cut + 1) : value
  return short.trim() || value
}

/** 同场景内按 appId 哈希取色，避免一屏卡片全是同一块蓝。 */
const SCENE_PALETTES: Record<string, readonly string[]> = {
  collect: [
    'linear-gradient(135deg, #4aa3f0, #2f6fe0)',
    'linear-gradient(135deg, #5f8ff5, #3c5fd8)',
    'linear-gradient(135deg, #3fb6e8, #2566b8)',
    'linear-gradient(135deg, #6fa8e8, #35509c)',
  ],
  plan: [
    'linear-gradient(135deg, #a78bfa, #6d5ce0)',
    'linear-gradient(135deg, #8f7bf0, #5b46c8)',
    'linear-gradient(135deg, #b99cf7, #7a5ee6)',
  ],
  recruit: [
    'linear-gradient(135deg, #34d3c0, #1e9e8f)',
    'linear-gradient(135deg, #2fc3b4, #177f76)',
    'linear-gradient(135deg, #48ddc4, #22a894)',
  ],
}

function hashString(value: string): number {
  let hash = 0
  for (let i = 0; i < value.length; i += 1) hash = (hash * 31 + value.charCodeAt(i)) >>> 0
  return hash
}

export function fastGptTint(sceneId: string, appId = ''): string {
  const palette = SCENE_PALETTES[sceneId]
  if (!palette || palette.length === 0) return FALLBACK_TINT
  return palette[hashString(appId) % palette.length]
}

export interface FastGptAgentView {
  appId: string
  sceneId: string
  /** 场景显示名（数据采集…），应用面板的分组标题。 */
  sceneLabel: string
  name: string
  short: string
  desc: string
  tint: string
  chatUrl: string
  manageUrl: string
}

export function fastGptAgentView(seed: FastGptAgentSeed, baseUrl: string): FastGptAgentView {
  return {
    appId: seed.appId,
    sceneId: seed.sceneId,
    sceneLabel: FASTGPT_SCENE_LABELS[seed.sceneId] ?? seed.sceneId,
    name: seed.name,
    short: seed.short,
    desc: seed.desc,
    tint: fastGptTint(seed.sceneId, seed.appId),
    chatUrl: `${baseUrl}/chat?appId=${encodeURIComponent(seed.appId)}`,
    manageUrl: `${baseUrl}/dashboard/agent?appId=${encodeURIComponent(seed.appId)}`,
  }
}

export interface FastGptRemoteApp {
  appId: string
  name: string
  intro: string
}

/**
 * 拉 FastGPT 的应用列表（`POST /api/core/app/list`）。
 *
 * 只用来刷新名称/简介；超时或版本对不上就回空数组，调用方继续用内置清单。
 */
export async function fetchFastGptAppList(baseUrl: string, apiKey: string): Promise<FastGptRemoteApp[]> {
  if (!apiKey || typeof fetch !== 'function') return []
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 4000)
  try {
    const res = await fetch(`${baseUrl}/api/core/app/list`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ parentId: null }),
      signal: controller.signal,
    })
    if (!res.ok) return []
    const payload = await res.json() as { data?: unknown }
    const list = Array.isArray(payload?.data) ? payload.data : []
    return list.flatMap((item) => {
      const record = item && typeof item === 'object' ? item as Record<string, unknown> : {}
      const id = typeof record._id === 'string' ? record._id : (typeof record.id === 'string' ? record.id : '')
      if (!id) return []
      return [{
        appId: id,
        name: typeof record.name === 'string' ? record.name : '',
        intro: typeof record.intro === 'string' ? record.intro : '',
      }]
    })
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}
