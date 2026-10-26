/**
 * 静态 CCF-A 期刊目录（CCF 2022 目录）。
 *
 * ccfddl 只跟踪会议；上游 Mimir 把这份固定清单内联在服务端
 * `packages/mimir/src/venue-deadlines.ts` 的 `CCF_A_JOURNALS` 里，随
 * listVenueDeadlines 一并返回。ekko 后端没有对应路由（`packages/server`
 * 里没有 journals），所以这里镜像一份，由 `remote-adapter` 的
 * `listVenueDeadlines` 一起返回，保证「期刊」页签与上游同源同数据。
 *
 * `sub` 用官方目录的中文字段名，与上游一致（切到 EN 也不翻译）。
 * @module dsh-client-ui-mimir/client/venue-journals
 */

/** One entry of the static CCF-A journal directory. */
export interface VenueJournalEntry {
  readonly title: string
  readonly fullName: string
  /** CCF field label (Chinese, matching the official catalog). */
  readonly sub: string
  readonly publisher: string
}

/** The static CCF-A journal directory, ordered by field. */
export const CCF_A_JOURNALS: readonly VenueJournalEntry[] = Object.freeze([
  { title: 'TOCS', fullName: 'ACM Transactions on Computer Systems', sub: '体系结构/并行与分布计算/存储系统', publisher: 'ACM' },
  { title: 'TOS', fullName: 'ACM Transactions on Storage', sub: '体系结构/并行与分布计算/存储系统', publisher: 'ACM' },
  { title: 'TCAD', fullName: 'IEEE Transactions on Computer-Aided Design of Integrated Circuits and System', sub: '体系结构/并行与分布计算/存储系统', publisher: 'IEEE' },
  { title: 'TC', fullName: 'IEEE Transactions on Computers', sub: '体系结构/并行与分布计算/存储系统', publisher: 'IEEE' },
  { title: 'TPDS', fullName: 'IEEE Transactions on Parallel and Distributed Systems', sub: '体系结构/并行与分布计算/存储系统', publisher: 'IEEE' },
  { title: 'TACO', fullName: 'ACM Transactions on Architecture and Code Optimization', sub: '体系结构/并行与分布计算/存储系统', publisher: 'ACM' },
  { title: 'JSAC', fullName: 'IEEE Journal on Selected Areas in Communications', sub: '计算机网络', publisher: 'IEEE' },
  { title: 'TMC', fullName: 'IEEE Transactions on Mobile Computing', sub: '计算机网络', publisher: 'IEEE' },
  { title: 'TON', fullName: 'IEEE/ACM Transactions on Networking', sub: '计算机网络', publisher: 'IEEE/ACM' },
  { title: 'TDSC', fullName: 'IEEE Transactions on Dependable and Secure Computing', sub: '网络与信息安全', publisher: 'IEEE' },
  { title: 'TIFS', fullName: 'IEEE Transactions on Information Forensics and Security', sub: '网络与信息安全', publisher: 'IEEE' },
  { title: 'JOC', fullName: 'Journal of Cryptology', sub: '网络与信息安全', publisher: 'Springer' },
  { title: 'TOPLAS', fullName: 'ACM Transactions on Programming Languages and Systems', sub: '软件工程/系统软件/程序设计语言', publisher: 'ACM' },
  { title: 'TOSEM', fullName: 'ACM Transactions on Software Engineering and Methodology', sub: '软件工程/系统软件/程序设计语言', publisher: 'ACM' },
  { title: 'TSE', fullName: 'IEEE Transactions on Software Engineering', sub: '软件工程/系统软件/程序设计语言', publisher: 'IEEE' },
  { title: 'TODS', fullName: 'ACM Transactions on Database Systems', sub: '数据库/数据挖掘/内容检索', publisher: 'ACM' },
  { title: 'TOIS', fullName: 'ACM Transactions on Information Systems', sub: '数据库/数据挖掘/内容检索', publisher: 'ACM' },
  { title: 'TKDE', fullName: 'IEEE Transactions on Knowledge and Data Engineering', sub: '数据库/数据挖掘/内容检索', publisher: 'IEEE' },
  { title: 'VLDBJ', fullName: 'The VLDB Journal', sub: '数据库/数据挖掘/内容检索', publisher: 'Springer' },
  { title: 'TOG', fullName: 'ACM Transactions on Graphics', sub: '计算机图形学与多媒体', publisher: 'ACM' },
  { title: 'TIP', fullName: 'IEEE Transactions on Image Processing', sub: '计算机图形学与多媒体', publisher: 'IEEE' },
  { title: 'TVCG', fullName: 'IEEE Transactions on Visualization and Computer Graphics', sub: '计算机图形学与多媒体', publisher: 'IEEE' },
  { title: 'AI', fullName: 'Artificial Intelligence', sub: '人工智能', publisher: 'Elsevier' },
  { title: 'TPAMI', fullName: 'IEEE Transactions on Pattern Analysis and Machine Intelligence', sub: '人工智能', publisher: 'IEEE' },
  { title: 'IJCV', fullName: 'International Journal of Computer Vision', sub: '人工智能', publisher: 'Springer' },
  { title: 'JMLR', fullName: 'Journal of Machine Learning Research', sub: '人工智能', publisher: 'JMLR.org' },
  { title: 'TIT', fullName: 'IEEE Transactions on Information Theory', sub: '计算机科学理论', publisher: 'IEEE' },
  { title: 'TOCHI', fullName: 'ACM Transactions on Computer-Human Interaction', sub: '人机交互与普适计算', publisher: 'ACM' },
  { title: 'IJHCS', fullName: 'International Journal of Human-Computer Studies', sub: '人机交互与普适计算', publisher: 'Elsevier' },
])
