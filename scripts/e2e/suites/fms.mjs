// fms：FMS-001/002 为真实实现（从 v1 移植并修复 caseId 透传）；FMS-003/004 尚未实现。
import { config } from '../config/index.mjs'
import { createApiClient } from '../lib/api.mjs'
import { login, openRoute, saveScreenshot, tableRows } from '../lib/browser.mjs'
import { checklist, nonEmpty } from '../lib/assert.mjs'

export const implemented = true
const IMPLEMENTED_CASES = new Set(['FMS-001', 'FMS-002'])

async function ensureAuth (ctx, check) {
  if (ctx.token) return ctx
  const { token, failures } = await login(ctx.page, { check })
  check.step('page', '登录过程无 4xx/5xx 接口失败', failures.length === 0, failures.slice(0, 3).join(' | '))
  ctx.token = token
  ctx.api = createApiClient({ token, check })
  return ctx
}

export async function runCase ({ caseId, page, check, shotDir, ctx }) {
  if (!IMPLEMENTED_CASES.has(caseId)) return { notImplemented: true }
  ctx.page = page
  const c = check ?? checklist()
  await ensureAuth(ctx, c)
  const api = ctx.api

  // 固定账套存在（只读）
  const accountSets = await api.get('/fms/config/account-set/list')
  const rows = Array.isArray(accountSets?.data) ? accountSets.data : []
  c.step('api', 'FMS 账套列表可读', rows.length > 0, `rows=${rows.length}`)

  // 事件受理：API 来源字段 + 页面真实行
  const eventResult = await api.get('/fms/event-inbox/page?pageNo=1&pageSize=20')
  const eventRows = eventResult?.data?.list || []
  c.step('api', '事件受理 API 返回来源字段',
    eventRows.length > 0 && eventRows.every((r) => nonEmpty(r.sourceSystem) && nonEmpty(r.eventType) && nonEmpty(r.sourceBillType) && nonEmpty(r.sourceBillId) && nonEmpty(r.direction)),
    `rows=${eventRows.length}`)
  const er = await openRoute(page, '/fms/event-inbox', { check: c })
  c.step('page', '事件受理页面显示真实行', (await tableRows(page)) > 0, '真实 Chrome 列表行')
  c.step('page', '事件页无 4xx/5xx 接口失败', er.failures.length === 0, er.failures.slice(0, 3).join(' | '))
  await saveScreenshot(page, shotDir, `FMS-001-event-inbox`)

  if (caseId === 'FMS-002') {
    const voucherResult = await api.get('/fms/voucher-draft/page?pageNo=1&pageSize=20')
    const voucherRows = voucherResult?.data?.list || []
    c.step('api', '凭证草稿 API 返回来源字段',
      voucherRows.length > 0 && voucherRows.every((r) => nonEmpty(r.draftNo) && nonEmpty(r.sourceSystem) && nonEmpty(r.eventType)),
      `rows=${voucherRows.length}`)
    const vr = await openRoute(page, '/fms/voucher-draft', { check: c })
    c.step('page', '凭证草稿页面显示真实行', (await tableRows(page)) > 0, '真实 Chrome 列表行')
    c.step('page', '草稿页无 4xx/5xx 接口失败', vr.failures.length === 0, vr.failures.slice(0, 3).join(' | '))
    await saveScreenshot(page, shotDir, 'FMS-002-voucher-draft')
  }
  return { steps: c.steps }
}
