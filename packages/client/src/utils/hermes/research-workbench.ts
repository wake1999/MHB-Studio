/**
 * Research workbench catalogue.
 *
 * Each capability is a *task brief*: it collects a couple of parameters and
 * turns them into a structured prompt that the agent runs in a normal chat
 * session. The workbench itself owns no storage and no pipeline state — the
 * conversation is the record, and artefacts land in the workspace.
 *
 * Boundaries (deliberate):
 *   - literature: retrieval / reading / review drafting. No local library.
 *   - analysis:   clean, statistics, figures. Runs in the session's workspace.
 *   - polish:     language and consistency only, never changes claims/numbers.
 *   - reformat:   journal template migration; compiles to prove it still builds.
 *   - seminar:    bilingual talk material from a paper.
 *   - compliance: ledger, citation verification, audit checklist.
 */

export interface ResearchParam {
  key: string
  labelKey: string
  placeholderKey: string
  /** Multi-line input for text bodies (abstract, notes). */
  textarea?: boolean
}

export interface ResearchCapability {
  id: string
  labelKey: string
  descKey: string
  params: ResearchParam[]
  /** Optional Ekko skill to attach to the run. */
  skill?: string
  build: (values: Record<string, string>) => string
}

export interface ResearchModule {
  id: string
  labelKey: string
  descKey: string
  /** Single SVG path, 24x24 stroke icon. */
  icon: string
  capabilities: ResearchCapability[]
}

const param = (key: string, textarea = false): ResearchParam => ({
  key,
  labelKey: `research.param.${key}`,
  placeholderKey: `research.param.${key}Placeholder`,
  textarea,
})

function pick(values: Record<string, string>, key: string): string {
  return (values[key] || '').trim()
}

/** Shared closing rules so every brief ends with verifiable output. */
const OUTPUT_RULES = [
  '输出要求：',
  '1. 先给 1-3 行结论，再展开细节；不要复述我的需求。',
  '2. 所有事实性断言标注来源（DOI / URL / 文件路径 + 页码或行号）；查不到就写「未找到」，禁止编造。',
  '3. 需要执行代码的步骤，给出可直接运行的命令与脚本，并贴出真实输出。',
  '4. 产物写到工作区文件并在回复里给出路径；不要只贴片段。',
].join('\n')

export const RESEARCH_MODULES: ResearchModule[] = [
  {
    id: 'literature',
    labelKey: 'research.module.literature',
    descKey: 'research.module.literatureDesc',
    icon: 'M4 5.5A1.5 1.5 0 0 1 5.5 4H10v16H5.5A1.5 1.5 0 0 1 4 18.5v-13M20 5.5A1.5 1.5 0 0 0 18.5 4H14v16h4.5a1.5 1.5 0 0 0 1.5-1.5v-13',
    capabilities: [
      {
        id: 'search',
        labelKey: 'research.cap.search',
        descKey: 'research.cap.searchDesc',
        params: [param('topic'), param('scope')],
        build: v => [
          '任务：科研文献检索。',
          `主题/关键词：${pick(v, 'topic')}`,
          pick(v, 'scope') ? `限定范围：${pick(v, 'scope')}` : '',
          '',
          '做法：用 OpenAlex / Crossref / arXiv / Semantic Scholar 的公开接口或网页检索，至少覆盖近 5 年，并按与主题的相关度排序。',
          '为每篇给出：标题、第一作者、年份、 venue、DOI、被引数、一句话结论（它解决了什么）、与我的主题的关系（支撑/反驳/方法可借用）、可信度提示（预印本/综述/撤稿风险）。',
          '最后给出 3 个可继续追的方向，并指出当前检索的盲区（数据库未覆盖、语言限制等）。',
          '',
          OUTPUT_RULES,
        ].filter(Boolean).join('\n'),
      },
      {
        id: 'deepread',
        labelKey: 'research.cap.deepread',
        descKey: 'research.cap.deepreadDesc',
        params: [param('source'), param('question', true)],
        build: v => [
          '任务：单篇文献精读。',
          `文献：${pick(v, 'source')}（PDF 路径 / DOI / URL）`,
          pick(v, 'question') ? `我关心的问题：${pick(v, 'question')}` : '',
          '',
          '先拿到全文（下载 PDF 或读本地文件），再输出固定结构的精读卡：',
          '① 研究问题与动机 ② 方法（含关键公式/算法，逐符号解释） ③ 数据与实验设置 ④ 主要结果（引用原表格/图的具体数值） ⑤ 结论与作者声称的贡献 ⑥ 局限与未解决问题 ⑦ 我可复用的点（数据/代码/评测协议/写作结构） ⑧ 3 个可追问的实验。',
          '所有引用标注页码或章节号。若 PDF 无法获取或只有摘要，明确说明并降低结论强度。',
          '',
          OUTPUT_RULES,
        ].filter(Boolean).join('\n'),
      },
      {
        id: 'review',
        labelKey: 'research.cap.review',
        descKey: 'research.cap.reviewDesc',
        params: [param('topic'), param('angle', true)],
        build: v => [
          '任务：文献综述撰写。',
          `题目：${pick(v, 'topic')}`,
          pick(v, 'angle') ? `切入角度/我的观点：${pick(v, 'angle')}` : '',
          '',
          '流程：先检索并列出候选文献（不少于 15 篇，附 DOI），再划分类别，最后成文。',
          '成文结构：摘要 → 研究脉络（时间线或技术路线）→ 按主题分节的比较（方法/数据/结论差异）→ 争议与空白 → 可执行的研究机会 → 参考文献。',
          '每一处事实都带引用占位 `[@key]`，并在文末给一份 BibTeX 草稿；无法核实的引用必须删除而不是保留。',
          '写作要求：批判性比较而非罗列；同类工作给出对比表。',
          '',
          OUTPUT_RULES,
        ].filter(Boolean).join('\n'),
      },
      {
        id: 'latex',
        labelKey: 'research.cap.latexContent',
        descKey: 'research.cap.latexContentDesc',
        params: [param('section'), param('notes', true)],
        build: v => [
          '任务：LaTeX 内容生成。',
          `章节：${pick(v, 'section')}`,
          pick(v, 'notes') ? `素材/要点：${pick(v, 'notes')}` : '',
          '',
          '输出可直接编译的 LaTeX 片段：使用 article/booktabs/graphicx/amsmath 等标准宏包，避免依赖未提供的模板命令。',
          '包含：小节结构、公式（编号并解释符号）、表格（booktabs 三线表）、图占位（\\includegraphics + \\caption + \\label）。',
          '同时给出引用写法与需要我补的图/数据清单。若我提供目标期刊，按该期刊常用版式调整。',
          '',
          OUTPUT_RULES,
        ].filter(Boolean).join('\n'),
      },
    ],
  },
  {
    id: 'analysis',
    labelKey: 'research.module.analysis',
    descKey: 'research.module.analysisDesc',
    icon: 'M4 19V5M4 19h16M8 15l3-4 3 2 4-6',
    capabilities: [
      {
        id: 'clean',
        labelKey: 'research.cap.clean',
        descKey: 'research.cap.cleanDesc',
        params: [param('data'), param('rules', true)],
        build: v => [
          '任务：实验数据清洗。',
          `数据文件：${pick(v, 'data')}`,
          pick(v, 'rules') ? `已知约束：${pick(v, 'rules')}` : '',
          '',
          '步骤：① 先描述数据结构（行数、列名、类型、缺失率、重复行）② 给出清洗方案并说明每一步的理由 ③ 用 pandas 实现，脚本存到工作区 ④ 输出清洗前后对照（样本量、分布变化）⑤ 标记被剔除的样本及原因。',
          '不要静默丢弃数据：所有删除、插补、截断都要可追溯。',
          '',
          OUTPUT_RULES,
        ].filter(Boolean).join('\n'),
      },
      {
        id: 'stats',
        labelKey: 'research.cap.stats',
        descKey: 'research.cap.statsDesc',
        params: [param('data'), param('hypothesis', true)],
        build: v => [
          '任务：统计计算与检验。',
          `数据文件：${pick(v, 'data')}`,
          pick(v, 'hypothesis') ? `假设：${pick(v, 'hypothesis')}` : '',
          '',
          '先判断数据结构与分布假设（独立性、正态性、方差齐性），再选择检验方法并说明为什么不用其它方法。',
          '输出：描述统计表、检验统计量与 p 值、效应量（Cohen d / η² / OR 等）、95% 置信区间、样本量与检验力说明。',
          '用 scipy/statsmodels 实现并贴真实输出；多重比较需校正并说明方法。最后给一段可直接进论文的 Results 表述。',
          '',
          OUTPUT_RULES,
        ].filter(Boolean).join('\n'),
      },
      {
        id: 'plot',
        labelKey: 'research.cap.plot',
        descKey: 'research.cap.plotDesc',
        params: [param('data'), param('spec')],
        build: v => [
          '任务：出版级图表生成。',
          `数据文件：${pick(v, 'data')}`,
          pick(v, 'spec') ? `期望图形：${pick(v, 'spec')}` : '',
          '',
          '用 matplotlib/seaborn 生成，要求：单栏/双栏尺寸明确、300dpi、字体与线宽符合期刊习惯、色盲友好配色、误差棒与显著性标注齐全。',
          '同时输出：图注（caption，含 n、统计方法、误差含义）、生成脚本路径、PDF+PNG 两种格式。',
          '若数据不适合该图形，直接说明并给替代方案。',
          '',
          OUTPUT_RULES,
        ].filter(Boolean).join('\n'),
      },
    ],
  },
  {
    id: 'polish',
    labelKey: 'research.module.polish',
    descKey: 'research.module.polishDesc',
    icon: 'M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4z',
    capabilities: [
      {
        id: 'text',
        labelKey: 'research.cap.polishText',
        descKey: 'research.cap.polishTextDesc',
        params: [param('source'), param('level')],
        build: v => [
          '任务：学术文本润色。',
          `文本（路径或直接粘贴）：${pick(v, 'source')}`,
          pick(v, 'level') ? `强度：${pick(v, 'level')}` : '强度：中等（保持原句式，只改表达与逻辑连接）',
          '',
          '硬性约束：不得改变任何论断、数值、单位、实验条件与因果方向；不得新增未提供的引用或数据。',
          '输出：① 润色后全文 ② 改动清单表（原句 / 改句 / 理由 / 类型：语法·搭配·逻辑·冗余·时态）③ 仍存疑之处（需要我确认的事实）。',
          '语言为英文时按目标期刊的学术惯例（主动/被动、时态、冠词）；中文时按核心期刊表达习惯。',
          '',
          OUTPUT_RULES,
        ].filter(Boolean).join('\n'),
      },
      {
        id: 'format',
        labelKey: 'research.cap.formatCheck',
        descKey: 'research.cap.formatCheckDesc',
        params: [param('source')],
        build: v => [
          '任务：格式与一致性校对。',
          `稿件：${pick(v, 'source')}`,
          '',
          '逐项检查并给出问题清单（位置 + 现状 + 建议）：术语与缩写首次出现定义、量与单位（SI）、数字与有效位、图表编号与正文引用对应、公式编号、参考文献格式与正文引用一致性、标题层级、时态与语态统一。',
          '不要笼统说「建议检查」，必须定位到具体行/小节。最后按严重程度排序，并给出可自动化的部分（脚本或正则）以便批量修。',
          '',
          OUTPUT_RULES,
        ].filter(Boolean).join('\n'),
      },
    ],
  },
  {
    id: 'reformat',
    labelKey: 'research.module.reformat',
    descKey: 'research.module.reformatDesc',
    icon: 'M4 7V5h16v2M9 5v14M15 5v14M4 19h16',
    capabilities: [
      {
        id: 'convert',
        labelKey: 'research.cap.convert',
        descKey: 'research.cap.convertDesc',
        params: [param('source'), param('journal')],
        build: v => [
          '任务：论文版本转换（按目标期刊模板重排）。',
          `源稿件：${pick(v, 'source')}（.tex 工程目录或 zip）`,
          `目标期刊/模板：${pick(v, 'journal')}`,
          '',
          '步骤：① 解析源工程结构（主文件、章节、宏包、自定义命令、bib）② 取得目标模板（官方 author kit；拿不到就明确说明并给下载指引）③ 建立映射：documentclass、章节命令、图表环境、参考文献样式、作者与单位格式 ④ 生成新工程到独立目录，保留原工程不动 ⑤ 编译验证（pdflatex/xelatex + bibtex，至少两轮）⑥ 输出改动清单表（原写法 / 新写法 / 位置 / 是否人工确认）。',
          '禁止：删改正文内容、私自替换图表、静默丢弃无法映射的宏包。编译不通过时贴出完整报错并逐个修。',
          '',
          OUTPUT_RULES,
        ].filter(Boolean).join('\n'),
      },
      {
        id: 'check',
        labelKey: 'research.cap.submitCheck',
        descKey: 'research.cap.submitCheckDesc',
        params: [param('journal'), param('source')],
        build: v => [
          '任务：投稿要求逐条核对。',
          `目标期刊：${pick(v, 'journal')}`,
          pick(v, 'source') ? `稿件：${pick(v, 'source')}` : '',
          '',
          '先抓取该刊最新 author guidelines（给出来源 URL 与版本日期），整理成检查表：篇幅/字数、摘要与关键词、图表数量与格式/分辨率、参考文献样式与数量、伦理与数据可得性声明、利益冲突、作者贡献、匿名化要求、补充材料、文件命名。',
          '逐条给出：要求 / 当前状态（通过·不通过·无法判定）/ 证据（页码或命令输出）/ 修改动作。无法判定的必须说明缺什么。',
          '',
          OUTPUT_RULES,
        ].filter(Boolean).join('\n'),
      },
    ],
  },
  {
    id: 'seminar',
    labelKey: 'research.module.seminar',
    descKey: 'research.module.seminarDesc',
    icon: 'M12 3v18M7 8l5-5 5 5M4 21h16',
    capabilities: [
      {
        id: 'deck',
        labelKey: 'research.cap.seminarDeck',
        descKey: 'research.cap.seminarDeckDesc',
        params: [param('paper'), param('audience')],
        build: v => [
          '任务：组会文献讲解材料（中英双语）。',
          `论文：${pick(v, 'paper')}（DOI / PDF / arXiv）`,
          pick(v, 'audience') ? `听众：${pick(v, 'audience')}` : '听众：同组研究生与导师，熟悉领域但不熟悉这篇',
          '',
          '输出：① 10-12 页幻灯片大纲（每页：标题 / 3-4 条要点 / 建议配图或原图位置 / 讲解时长）② 每页中文讲稿（口语化，60-90 秒）与英文要点 ③ 关键术语中英对照表 ④ 5 个最可能被问到的问题及答案要点（含数据支撑）⑤ 一页「一分钟速览」用于开场。',
          '要求：不堆砌公式，重点讲清动机、方法直觉、结论强度与局限；所有数值取自原文并标页码。',
          '如果系统装了 python-pptx / office 技能，可直接生成 .pptx 并把论文原图放进去；否则给 Markdown 结构与配图清单。',
          '',
          OUTPUT_RULES,
        ].filter(Boolean).join('\n'),
      },
    ],
  },
  {
    id: 'compliance',
    labelKey: 'research.module.compliance',
    descKey: 'research.module.complianceDesc',
    icon: 'M12 3l8 4v6c0 5-3.5 7.5-8 8-4.5-.5-8-3-8-8V7zM9 12l2 2 4-4',
    capabilities: [
      {
        id: 'ledger',
        labelKey: 'research.cap.ledger',
        descKey: 'research.cap.ledgerDesc',
        params: [param('scope', true)],
        build: v => [
          '任务：科研成果台账整理。',
          `范围：${pick(v, 'scope') || '当前工作区与我的 ORCID/主页上能查到的成果'}`,
          '',
          '产出一张可审计的表（Markdown + CSV 双份）：类型（期刊/会议/预印本/专利/软著/数据集）、题目、作者顺序与通讯、单位署名、发表 venue、年份、卷期页、DOI、状态（在投/在审/接收/见刊/撤稿）、佐证材料路径、对应项目与经费编号。',
          '缺失字段写「待补」，不要用推测值填充。最后给一份「本年度统计」小结与需要补证的材料清单。',
          '',
          OUTPUT_RULES,
        ].filter(Boolean).join('\n'),
      },
      {
        id: 'citation',
        labelKey: 'research.cap.citationCheck',
        descKey: 'research.cap.citationCheckDesc',
        params: [param('source')],
        build: v => [
          '任务：引用自查（防编造与撤稿）。',
          `参考文献/稿件：${pick(v, 'source')}（.bib / .tex / 参考文献列表）`,
          '',
          '逐条核验：① 在 Crossref / OpenAlex / DBLP / PubMed 中按 DOI 或题名检索 ② 判定匹配度（完全一致 / 字段有误 / 疑似不存在）③ 检查是否已被撤稿或标注 expression of concern ④ 核对正文引用位置与文献内容是否相符。',
          '输出问题表（条目 / 问题类型 / 证据链接 / 建议修正的 BibTeX），并统计：总条数、完全通过、需修正、无法核实。',
          '如果环境里能用 citegate（pip install citegate），直接跑 `citegate <file>.bib` 并把它的输出并入报告。',
          '',
          OUTPUT_RULES,
        ].filter(Boolean).join('\n'),
      },
      {
        id: 'audit',
        labelKey: 'research.cap.audit',
        descKey: 'research.cap.auditDesc',
        params: [param('project', true)],
        build: v => [
          '任务：学术合规审计。',
          `项目/材料：${pick(v, 'project')}`,
          '',
          '按清单逐项检查并给结论（通过 / 有风险 / 缺失，附证据）：',
          '① 数据：来源合法性、知情同意/伦理审批编号、数据可得性声明、敏感信息脱敏',
          '② 图像：是否存在重复使用、拼接、过度调整（给出可比对的图清单与检查方法）',
          '③ 引用：抄袭与自我抄袭、引用与论断匹配度、撤稿文献',
          '④ 署名：作者贡献、单位、通讯作者、致谢与基金编号',
          '⑤ 利益冲突与 AI 使用声明（是否按要求披露）',
          '⑥ 一稿多投/重复发表风险。',
          '最后给风险分级表与整改顺序；不确定的项明确写「需人工/机构确认」，不要代替机构判断。',
          '',
          OUTPUT_RULES,
        ].filter(Boolean).join('\n'),
      },
    ],
  },
]

export const RESEARCH_WORKBENCH_DRAFT_KEY = 'ekko.workbench.draft'

export function findResearchCapability(capabilityId: string): ResearchCapability | undefined {
  for (const module of RESEARCH_MODULES) {
    const found = module.capabilities.find(cap => cap.id === capabilityId)
    if (found) return found
  }
  return undefined
}
