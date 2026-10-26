/**
 * Starter prompt templates (提示词模板).
 *
 * First level of the composer shelf is a *scene* (代码评审 / 写周报 / 润色文案…), so
 * every category below holds two or three ready-to-use prompts: picking the scene
 * shows its prompts under the composer, picking one writes it into the draft.
 * A fresh shelf already has these; rename, disable or delete them and the library
 * stays yours. The seed only runs while the table is empty, so a shelf the user has
 * touched is never resurrected.
 */

export type DefaultPromptTemplateKind = 'insert' | 'instruction'

export interface DefaultPromptTemplate {
  name: string
  category: string
  description: string
  kind: DefaultPromptTemplateKind
  content: string
  enabled: number
  sort: number
}

export const DEFAULT_PROMPT_TEMPLATES: DefaultPromptTemplate[] = [
  // 代码评审
  {
    name: '评审这段代码',
    category: '代码评审',
    description: '先列风险，再给改法',
    kind: 'insert',
    content: '评审这段代码：先按严重程度列出风险点，再给出可以直接采纳的改法。',
    enabled: 1,
    sort: 0,
  },
  {
    name: '找边界问题',
    category: '代码评审',
    description: '影响行为的边界情况',
    kind: 'insert',
    content: '逐行看这处改动，指出会影响行为的边界情况。',
    enabled: 1,
    sort: 1,
  },
  {
    name: '讲清这段代码',
    category: '代码评审',
    description: '意图 + 可疑处',
    kind: 'insert',
    content: '这段代码想做什么？用三句话讲清意图，并指出可疑的地方。',
    enabled: 1,
    sort: 2,
  },

  // 报错排查
  {
    name: '解释报错',
    category: '报错排查',
    description: '原因 + 最小修复',
    kind: 'insert',
    content: '解释这个报错的原因，给出最小修复方案和改后的代码。',
    enabled: 1,
    sort: 3,
  },
  {
    name: '先定位再排查',
    category: '报错排查',
    description: '环境还是代码',
    kind: 'insert',
    content: '先判断是环境问题还是代码问题，再给我一份排查步骤。',
    enabled: 1,
    sort: 4,
  },

  // 写测试
  {
    name: '补单元测试',
    category: '写测试',
    description: '三条路径都覆盖',
    kind: 'insert',
    content: '为下面的代码补单元测试：正常路径、边界、失败路径都要覆盖。',
    enabled: 1,
    sort: 5,
  },
  {
    name: '补边界用例',
    category: '写测试',
    description: '补上边界与失败',
    kind: 'insert',
    content: '把这段只测正常路径的测试补上边界和失败用例。',
    enabled: 1,
    sort: 6,
  },

  // 办公写作
  {
    name: '写周报',
    category: '办公写作',
    description: '进展 / 风险 / 下一步',
    kind: 'insert',
    content: '把这些事整理成周报：进展、风险、下一步各不超过三条。',
    enabled: 1,
    sort: 7,
  },
  {
    name: '把记录改成周报',
    category: '办公写作',
    description: '突出结果与影响',
    kind: 'insert',
    content: '把本周的零散记录改写成给上级看的周报，突出结果和影响。',
    enabled: 1,
    sort: 8,
  },
  {
    name: '写邮件',
    category: '办公写作',
    description: '得体、可直接发送',
    kind: 'insert',
    content: '把这几点写成一封得体的邮件，主题一行说清诉求。',
    enabled: 1,
    sort: 9,
  },
  {
    name: '写催进度邮件',
    category: '办公写作',
    description: '不生硬，给截止时间',
    kind: 'insert',
    content: '写一封催进度但不显生硬的邮件，给出明确的截止时间。',
    enabled: 1,
    sort: 10,
  },
  {
    name: '把邮件改短',
    category: '办公写作',
    description: '压缩篇幅，保留诉求',
    kind: 'insert',
    content: '把这封邮件改短，保留诉求和截止时间。',
    enabled: 1,
    sort: 11,
  },

  // 润色文案
  {
    name: '润色文字',
    category: '润色文案',
    description: '保留原意，去冗余',
    kind: 'insert',
    content: '润色这段文字：保留原意，去掉冗余，语气更自然一些。',
    enabled: 1,
    sort: 12,
  },
  {
    name: '改成对外版本',
    category: '润色文案',
    description: '去内部术语',
    kind: 'insert',
    content: '把这段改写成给外部客户看的版本，去掉内部术语。',
    enabled: 1,
    sort: 13,
  },

  // 总结材料
  {
    name: '总结要点',
    category: '总结材料',
    description: '最多五条',
    kind: 'insert',
    content: '把这份材料总结成要点：最多 5 条，每条一行，不要展开。',
    enabled: 1,
    sort: 14,
  },
  {
    name: '压成三句话',
    category: '总结材料',
    description: '保留数字与结论',
    kind: 'insert',
    content: '把这份材料压缩成三句话，保留数字和结论。',
    enabled: 1,
    sort: 15,
  },

  // 方案决策
  {
    name: '列利弊',
    category: '方案决策',
    description: '利弊清单 + 一句建议',
    kind: 'insert',
    content: '针对这件事列一份利弊清单，最后给一句明确的建议。',
    enabled: 1,
    sort: 16,
  },
  {
    name: '对比两个方案',
    category: '方案决策',
    description: '成本收益对比',
    kind: 'insert',
    content: '从成本和收益两栏对比这两个方案，最后给推荐。',
    enabled: 1,
    sort: 17,
  },

  // 指令（会话里开启后每轮生效）
  {
    name: '先结论后依据',
    category: '指令',
    description: '会话里开启后每轮生效',
    kind: 'instruction',
    content: '回答先给结论，再给依据；不确定的地方明确说不确定，不要猜。',
    enabled: 1,
    sort: 18,
  },
  {
    name: '中文作答',
    category: '指令',
    description: '代码与专有名词保留原文',
    kind: 'instruction',
    content: '默认用简体中文回答，代码、命令和专有名词保持原文。',
    enabled: 1,
    sort: 19,
  },
]
