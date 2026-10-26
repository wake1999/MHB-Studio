import type { ChatAppDto, ChatAppSceneDto } from '@/api/studio/chat-apps'

/**
 * 「发现应用」的视图模型 + 内置兜底目录。
 *
 * 数据源是 `/api/studio/chat-apps`（服务端 `chat_apps` 表，文案按语言分片），运营侧
 * 改库即可换文案、换场景、加应用。`FALLBACK_CHAT_APPS` 只在接口拿不到时顶上，形状与
 * 接口完全一致，所以解析/渲染只有一条路径。
 *
 * 选中应用只换首页外观：大标题 / 副标题、场景 chips、输入框占位符、快捷提示词。
 */

export interface ChatAppQuickPrompt {
  /** 胶囊上的短标签。提示词正文本身是中文，标签不单独走 i18n。 */
  readonly label: string
  /** 点一下整段填进输入框的要求正文。 */
  readonly text: string
}

export interface ChatAppScene {
  readonly id: string
  /** 已按当前语言解析好的场景名。 */
  readonly label: string
  readonly placeholder: string
  readonly quickPrompts: readonly ChatAppQuickPrompt[]
}

export interface ChatApp {
  readonly id: string
  readonly name: string
  readonly desc: string
  readonly heroTitle: string
  readonly heroSubtitle: string
  /** 没选场景时的占位符。 */
  readonly placeholder: string
  readonly iconPaths: readonly string[]
  readonly tint: string
  readonly scenes: readonly ChatAppScene[]
}

/** 基准语言：其他语言缺字段时回退到它。 */
const BASE_LOCALE = 'zh'
/** 回退顺序：精确语言 → 基础语言（zh-TW → zh）→ 基准 → 任意一个。 */
function pickLocalized<T>(map: Record<string, T> | undefined, locale: string): T | undefined {
  if (!map) return undefined
  const exact = map[locale]
  if (exact) return exact
  const base = locale.split('-')[0]
  if (base && map[base]) return map[base]
  if (map[BASE_LOCALE]) return map[BASE_LOCALE]
  return Object.values(map)[0]
}

function resolveScene(scene: ChatAppSceneDto, locale: string): ChatAppScene {
  const text = pickLocalized(scene.text, locale)
  return {
    id: scene.id,
    label: text?.label ?? scene.id,
    placeholder: text?.placeholder ?? '',
    quickPrompts: (scene.quickPrompts ?? [])
      .filter(prompt => prompt.label !== '' && prompt.text !== '')
      .map(prompt => ({ label: prompt.label, text: prompt.text })),
  }
}

export function resolveChatApp(dto: ChatAppDto, locale: string): ChatApp {
  const text = pickLocalized(dto.text, locale)
  const scenes = (dto.scenes ?? []).map(scene => resolveScene(scene, locale))
  return {
    id: dto.id,
    name: text?.name ?? dto.id,
    desc: text?.desc ?? '',
    heroTitle: text?.heroTitle ?? text?.name ?? dto.id,
    heroSubtitle: text?.heroSubtitle ?? '',
    placeholder: text?.placeholder ?? '',
    iconPaths: dto.iconPaths ?? [],
    tint: dto.tint ?? 'linear-gradient(135deg, #4aa3f0, #2f6fe0)',
    scenes,
  }
}

export function resolveChatApps(dtos: readonly ChatAppDto[], locale: string): ChatApp[] {
  return dtos.map(dto => resolveChatApp(dto, locale))
}

/**
 * 接口不可用时的内置目录：内容与服务端种子（`chat-app-seeds.ts`）一致。
 * 改文案请改服务端那份；这里只在断网/未登录时保底显示。
 */
export const FALLBACK_CHAT_APPS: readonly ChatAppDto[] = [
  {
    id: 'btit',
    sort: 0,
    iconPaths: [
      'M9.5 3h5',
      'M10.5 3v13.2a2.6 2.6 0 0 0 5.2 0V3',
      'M10.5 10.4h5.2',
    ],
    tint: 'linear-gradient(135deg, #4aa3f0, #2f6fe0)',
    text: {
      zh: {
        name: 'BTIT 临床试验助手',
        desc: '数据采集 · 方案生成 · 受试者挖掘',
        heroTitle: 'BTIT · 临床试验智能伙伴',
        heroSubtitle: '数据采集、个性化方案生成与潜在受试者挖掘，一个对话搞定。',
        placeholder: '描述你的 BTIT 任务，我按场景帮你拆步骤',
      },
      en: {
        name: 'BTIT trial assistant',
        desc: 'Data capture · Protocol design · Cohort mining',
        heroTitle: 'BTIT · Your clinical trial copilot',
        heroSubtitle: 'Data capture, personalised protocol design and candidate-subject mining in one conversation.',
        placeholder: 'Describe your BTIT task and I will scope it by scenario',
      },
    },
    scenes: [
      {
        id: 'collect',
        text: {
          zh: { label: '数据采集', placeholder: '贴入要采集的字段、表单或数据源，BTIT 帮你搭采集表' },
          en: { label: 'Data capture', placeholder: 'Paste fields, forms or data sources; BTIT drafts the capture sheet' },
        },
        quickPrompts: [
          {
            label: '设计采集表',
            text: '帮我为 BTIT 项目设计一份数据采集表（CRF），覆盖入排标准、基线特征、给药记录、随访节点与不良事件五个模块，字段注明类型、必填与取值范围。',
          },
          {
            label: '核对入排标准',
            text: '按 BTIT 方案核对这批受试者的入排标准，逐条列出符合项、不符合项，以及需要回溯的原始数据。',
          },
          {
            label: '整理字段模板',
            text: '把随访计划整理成可导入的采集模板：字段名、数据类型、是否必填、取值范围、采集时点。',
          },
        ],
      },
      {
        id: 'plan',
        text: {
          zh: { label: '个性化方案生成', placeholder: '说明受试者特征与目标，BTIT 帮你出个体化方案' },
          en: { label: 'Protocol design', placeholder: 'Describe the subject and the goal; BTIT drafts a personalised plan' },
        },
        quickPrompts: [
          {
            label: '生成个体化方案',
            text: '基于这位受试者的基线特征与既往用药，生成一份 BTIT 个体化给药方案，标明剂量调整依据与需要监测的指标。',
          },
          {
            label: '起草方案摘要',
            text: '为 BTIT 项目起草一版个体化方案摘要，包含适用人群、干预措施、疗程、随访安排与评价终点。',
          },
          {
            label: '风险与禁忌筛查',
            text: '列出该方案的主要风险与禁忌情况，给出对应的监测指标、复查频率和停药标准。',
          },
        ],
      },
      {
        id: 'recruit',
        text: {
          zh: { label: '潜在受试者挖掘', placeholder: '给出人群范围或病历来源，BTIT 帮你筛候选受试者' },
          en: { label: 'Candidate mining', placeholder: 'Give a population or record source; BTIT screens candidate subjects' },
        },
        quickPrompts: [
          {
            label: '筛查候选受试者',
            text: '从这批病历中筛查符合 BTIT 入排标准的候选受试者，输出受试者标识、关键指标、命中原因与被排除原因。',
          },
          {
            label: '候选优先级排序',
            text: '把候选受试者按入组可能性排序，给出排序依据，以及每位还需要补充的检查项。',
          },
          {
            label: '撰写招募说明',
            text: '为 BTIT 项目写一段面向患者的招募说明，通俗解释研究目的、参与流程、可能的风险与获益。',
          },
        ],
      },
    ],
  },
]
