/**
 * 上游 ui-mimir 的源码里有一批只用于类型标注的 dsh 客户端包引用。ekko 是 Vue 应用，
 * 不装 dsh 的客户端运行时，所以这里用 TS 的 shorthand ambient 声明把它们统一收成
 * any：运行期这些 import 都是 `import type`，编译后不会留下模块依赖。
 */

declare module '@deepseek-ai/dsh-typert-protocol'
declare module '@deepseek-ai/dsh-client-store'
declare module '@deepseek-ai/dsh-client-ui-slots'
declare module '@deepseek-ai/dsh-api-session-controller/client'
declare module '@deepseek-ai/dsh-api-remotes/client'
declare module '@deepseek-ai/dsh-client-locale/client'
declare module '@deepseek-ai/dsh-client-ui-layout/client'
declare module '@deepseek-ai/dsh-client-ui-renderer/client'
declare module '@deepseek-ai/dsh-client-ui-sidebar/client'
declare module '@deepseek-ai/dsh-client-ui-theme/client'
declare module '@deepseek-ai/dsh-client-ui-workspace/client'
declare module '@deepseek-ai/cordis'
declare module 'dsh-mimir/types'
declare module 'dsh-mimir/remote'
