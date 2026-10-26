/**
 * 「发现应用」的出厂目录。
 *
 * 只在 `chat_apps` 表还是空的时候灌一次：运营改过（改文案、删应用、改顺序）之后
 * 这个文件不再生效，和在不在代码里无关。文案按语言分片存，`zh` 必备，其余语言
 * 缺字段时前端回退到 `zh`。
 */

export interface ChatAppSeedText {
  name: string
  desc: string
  heroTitle: string
  heroSubtitle: string
  placeholder: string
}

export interface ChatAppSeedSceneText {
  label: string
  placeholder: string
}

export interface ChatAppSeedQuickPrompt {
  label: string
  text: string
}

export interface ChatAppSeedScene {
  id: string
  text: Record<string, ChatAppSeedSceneText>
  quickPrompts: ChatAppSeedQuickPrompt[]
}

export interface ChatAppSeedPayload {
  iconPaths: string[]
  tint: string
  text: Record<string, ChatAppSeedText>
  scenes: ChatAppSeedScene[]
}

export interface ChatAppSeed {
  id: string
  sort: number
  payload: ChatAppSeedPayload
}

/** BTIT：临床试验场景，三个场景对应采集、方案、受试者三条主线。 */
export const DEFAULT_CHAT_APPS: readonly ChatAppSeed[] = [
  {
    id: 'btit',
    sort: 0,
    payload: {
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
  },
]
