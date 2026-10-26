import Router from '@koa/router'
import { requireSuperAdmin } from '../../studio/public/auth'
import * as ctrl from '../controllers/skills'

export const ekkoSkillRoutes = new Router()

// Read-only list: chat composers need it for /skill in single-user deployments,
// where the users table is empty and no super-admin role exists.
ekkoSkillRoutes.get('/api/ekko/skills', ctrl.list)
ekkoSkillRoutes.get('/api/ekko/skills/external-directories', requireSuperAdmin, ctrl.externalDirectories)
ekkoSkillRoutes.put('/api/ekko/skills/external-directories', requireSuperAdmin, ctrl.saveExternalDirectories)
ekkoSkillRoutes.post('/api/ekko/skills/import', requireSuperAdmin, ctrl.importSkill)
ekkoSkillRoutes.get('/api/ekko/skills/:name/files', requireSuperAdmin, ctrl.files)
ekkoSkillRoutes.get('/api/ekko/skills/:name/file', requireSuperAdmin, ctrl.file)
ekkoSkillRoutes.put('/api/ekko/skills/:name/toggle', requireSuperAdmin, ctrl.toggle)
ekkoSkillRoutes.get('/api/ekko/skills/:name', requireSuperAdmin, ctrl.detail)
ekkoSkillRoutes.post('/api/ekko/skills', requireSuperAdmin, ctrl.create)
ekkoSkillRoutes.put('/api/ekko/skills/:name', requireSuperAdmin, ctrl.update)
ekkoSkillRoutes.delete('/api/ekko/skills/:name', requireSuperAdmin, ctrl.remove)
