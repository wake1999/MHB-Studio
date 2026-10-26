import Router from '@koa/router'
import * as ctrl from '../controllers/fastgpt-agents'

/**
 * 首页场景下的 FastGPT 智能体卡片（只读）。
 */
export const fastGptAgentRoutes = new Router()

fastGptAgentRoutes.get('/api/studio/fastgpt-agents', ctrl.list)
