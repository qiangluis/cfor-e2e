// smoke：第一步。SMOKE-001/002 均为真实实现（非桩）。
// 注意：登录后页面右上角显示的租户名可能是「乐之木电子科技」而非注册名「福奇科技」
// ——租户上下文断言走 API 的 tenantId，不走页面显示名，避免误判。
import { config } from '../config/index.mjs'
import { apiHealth, createApiClient } from '../lib/api.mjs'
import { login, openRoute, saveScreenshot, bodyContainsAny } from '../lib/browser.mjs'
import { checklist } from '../lib/assert.mjs'

export const implemented = true

async function ensureAuth (ctx, check) {
  if (!ctx.token) {
    const { token, failures } = await login(ctx.page, { check })
    check.step('page', '登录过程无 4xx/5xx 接口失败', failures.length === 0, failures.slice(0, 3).join(' | '))
    ctx.token = token
  }
  if (!ctx.tenantId) {
    const api = createApiClient({ token: ctx.token, check })
    ctx.tenantId = await api.tenantIdByName(config.tenant)
    check.step('api', '租户名解析出 tenantId', !!ctx.tenantId, `tenant=${config.tenant} id=${ctx.tenantId}`)
  }
  if (!ctx.api) ctx.api = createApiClient({ token: ctx.token, tenantId: ctx.tenantId, check })
  return ctx
}

async function smoke001 (ctx, check, shotDir) {
  // 1. 后端健康（api 层）
  await apiHealth({ check })
  // 2. 真实登录 + 租户上下文（page 层）
  await ensureAuth(ctx, check)
  // 3. 租户上下文二次确认：当前登录身份确属该租户
  const info = await ctx.api.getPermissionInfo()
  const flat = JSON.stringify(info)
  check.step('api', '租户上下文与登录租户一致', flat.includes(config.tenant) || flat.includes(ctx.tenantId), `tenantId=${ctx.tenantId}`)
  await saveScreenshot(ctx.page, shotDir, 'SMOKE-001-logged-in')
}

async function smoke002 (ctx, check, shotDir) {
  await ensureAuth(ctx, check)

  // 工作台
  let r = await openRoute(ctx.page, '/index', { check })
  const wbHits = await bodyContainsAny(ctx.page, ['工作台', 'AI 员工'])
  check.step('page', '工作台可进入且内容可见', wbHits.length > 0, `命中：${wbHits.join('/')}`)
  check.step('page', '进入工作台无 4xx/5xx 接口失败', r.failures.length === 0, r.failures.slice(0, 3).join(' | '))
  await saveScreenshot(ctx.page, shotDir, 'SMOKE-002-workbench')

  // 引导中心
  r = await openRoute(ctx.page, '/systemInit/index', { check })
  const guideHits = await bodyContainsAny(ctx.page, ['引导中心', '初始化'])
  check.step('page', '引导中心存在', guideHits.length > 0, `命中：${guideHits.join('/')}`)
  check.step('page', '进入引导中心无 4xx/5xx 接口失败', r.failures.length === 0, r.failures.slice(0, 3).join(' | '))
  await saveScreenshot(ctx.page, shotDir, 'SMOKE-002-guide')

  // 已授权业务域菜单（api 层交叉验证：菜单非空）
  const info = await ctx.api.getPermissionInfo()
  const menus = info?.data?.menus || info?.menus || []
  check.step('api', '已授权菜单非空', Array.isArray(menus) ? menus.length > 0 : JSON.stringify(info).length > 100, Array.isArray(menus) ? `menus=${menus.length}` : '见 permission-info')
}

const CASES = { 'SMOKE-001': smoke001, 'SMOKE-002': smoke002 }

export async function runCase ({ caseId, page, check, shotDir, ctx }) {
  const fn = CASES[caseId]
  if (!fn) throw new Error(`smoke 未实现用例：${caseId}`)
  ctx.page = page
  const c = check ?? checklist()
  await fn(ctx, c, shotDir)
  return { steps: c.steps }
}
