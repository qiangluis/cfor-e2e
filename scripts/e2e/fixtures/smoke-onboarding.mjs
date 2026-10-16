import { createHash } from 'node:crypto'

import {
  buildEnterpriseIsolationPackage,
  runEnterpriseIsolationEvidence
} from './enterprise-isolation.mjs'
import { loginWithCredentials, saveScreenshot } from '../lib/browser.mjs'
import { decryptResponse, ENCRYPT_HEADER } from '../lib/crypto.mjs'
import { runReadOnlySql } from '../lib/db.mjs'

const need = (value, message) => {
  if (!value) throw new Error(`SMOKE-001 onboarding: ${message}`)
}
const exactId = (value) => {
  need(!(typeof value === 'number' && !Number.isSafeInteger(value)) &&
    /^[1-9]\d*$/.test(String(value ?? '')), 'ID 必须无损')
  return String(value)
}
const flat = (menus) => (Array.isArray(menus) ? menus : []).flatMap((menu) =>
  [menu, ...flat(menu.children)])
const digest = (rows) => createHash('sha256').update(JSON.stringify(rows)).digest('hex')

export function buildSmokeOnboardingPackage (input) {
  const plan = buildEnterpriseIsolationPackage(input)
  const rows = flat(input.menus)
  const byId = new Map(rows.map((row) => [exactId(row.id), row]))
  const pages = rows.filter((menu) => menu.component === 'system/systemInit/index')
  need(pages.length === 1, '正式引导中心组件菜单不唯一')
  const page = pages[0]
  const targets = page.permission === 'system:system-init:query'
    ? [page]
    : rows.filter((menu) => menu.permission === 'system:system-init:query' &&
      String(menu.parentId) === String(page.id))
  need(targets.length === 1, '引导组件下的状态查询权限不唯一')
  const allowed = new Set(input.standardPackage.menuIds.map(exactId))
  const assignable = new Set(flat(input.assignableMenus).map((row) => exactId(row.id)))
  const menuIds = new Set(plan.menuIds)
  const seen = new Set()
  let menu = targets[0]
  while (menu) {
    const key = exactId(menu.id)
    need(!seen.has(key) && allowed.has(key) && assignable.has(key) &&
      Number(menu.status) === 0 && Number(menu.deleted ?? 0) === 0,
    '引导权限及父目录必须是标准套餐已授权且可分配的有效菜单')
    seen.add(key)
    menuIds.add(key)
    if (String(menu.parentId) === '0') break
    menu = byId.get(exactId(menu.parentId))
    need(menu, '引导权限父链不完整')
  }
  return { ...plan, menuIds: [...menuIds] }
}

export function smokeFreshLoginFact ({ logins, auth, tenantId, state, info, route, visible }) {
  const item = Array.isArray(logins) && logins.length === 1 ? logins[0] : null
  return item?.code === 0 && item.status >= 200 && item.status < 300 &&
    item.tokenMatches === true && String(item.tenantId) === tenantId &&
    String(auth?.tenantId) === tenantId && tenantId !== '1' &&
    state?.code === 0 && state.data?.currentStep === 1 &&
    !state.data.industryTemplate && info?.onboardingRequired === true &&
    route === '/systemInit/index' && visible === true
}

async function initSnapshot (readSql, tenantId) {
  const columns = await readSql(`SELECT COLUMN_NAME,DATA_TYPE FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='system_init_state' ORDER BY ORDINAL_POSITION`)
  need(columns?.available === true && columns.rows.length > 0 &&
    columns.rows.every((row) => /^[a-z][a-z0-9_]*$/.test(row[0])),
  '初始化完整字段元数据不可用')
  const fields = columns.rows.map(([key, type]) =>
    `'${key}',CAST(${type === 'bit' ? `CAST(\`${key}\` AS UNSIGNED)` : `\`${key}\``} AS CHAR)`)
  const result = await readSql(`SELECT JSON_OBJECT(${fields.join(',')})
    FROM system_init_state WHERE tenant_id=${exactId(tenantId)} ORDER BY id`)
  need(result?.available === true && Array.isArray(result.rows), '初始化完整 SQL 快照不可用')
  const rows = result.rows.map(([json]) => {
    const row = JSON.parse(json)
    need(row.tenant_id === String(tenantId) &&
      Object.keys(row).length === columns.rows.length, '初始化全字段或租户不一致')
    return Object.fromEntries(Object.keys(row).sort().map((key) => [key, row[key]]))
  })
  return { rows, hash: digest(rows) }
}

export async function runSmokeOnboardingEvidence ({
  context, primaryApi, outputDir, dependencies = {}
}) {
  const readSql = dependencies.readSql || runReadOnlySql
  const isolate = dependencies.isolate || runEnterpriseIsolationEvidence
  const { caseRecord } = context
  if ((dependencies.writeEnabled ?? process.env.CFOR_E2E_WRITE_FIXTURES === 'true') !== true) {
    caseRecord.notes.push('GAP: 未启用专属写侧夹具，未确认初始化的真实登录分支未执行')
    return { executed: false }
  }
  const baseline = await initSnapshot(readSql, '1')
  need(baseline.rows.length > 0, '标准平台初始化基线为空')
  let fresh
  let owner
  const errors = []
  const logins = []
  const observerLogin = async (page, options) => {
    const tasks = []
    const observe = (response) => {
      if (!response.url().includes('/system/auth/login-encrypted') ||
        response.request().method() !== 'POST') return
      tasks.push((async () => {
        const text = await response.text()
        const body = response.headers()[ENCRYPT_HEADER.toLowerCase()] === 'true'
          ? decryptResponse(text) : JSON.parse(text)
        logins.push({
          status: response.status(), code: body?.code, tenantId: body?.data?.tenantId,
          matches: (token) => Boolean(token) && body?.data?.accessToken === token
        })
      })())
    }
    page.on('response', observe)
    let auth
    try {
      auth = await loginWithCredentials(page, options.credentials, { returnContext: true })
      await Promise.all(tasks)
      for (const item of logins) {
        item.tokenMatches = item.matches(auth.token)
        delete item.matches
      }
      return auth
    } finally {
      page.off('response', observe)
      await Promise.all(tasks)
    }
  }
  try {
    const result = await isolate({
      context, primaryApi, packagePlan: buildSmokeOnboardingPackage,
      dependencies: { ...dependencies.isolation, login: dependencies.login || observerLogin },
      verifyEnterprisePage: async ({ page, api, auth, info, tenantId, userId }) => {
        owner = { tenantId: exactId(tenantId), userId: exactId(userId) }
        const before = await initSnapshot(readSql, tenantId)
        const state = await api.getBusiness('/system/system-init/state')
        await page.locator('.system-init .init-wizard').first().waitFor({ state: 'visible' })
        const after = await initSnapshot(readSql, tenantId)
        const observed = dependencies.logins || logins
        need(smokeFreshLoginFact({
          logins: observed, auth, tenantId, state, info,
          route: new URL(page.url()).pathname,
          visible: await page.locator('.system-init .init-wizard').first().isVisible()
        }), '真实首次登录、令牌、未确认状态和引导落点不一致')
        need(before.rows.length === 1 && before.hash === after.hash,
          '只读验证改变了专属租户初始化事实')
        fresh = { tenantId, userId, route: new URL(page.url()).pathname,
          stateHash: after.hash, currentStep: state.data.currentStep, loginCount: observed.length }
        await (dependencies.screenshot || saveScreenshot)(
          page, outputDir, 'smoke-unconfirmed-login', context.record
        )
      }
    })
    need(result?.executed === true && fresh && owner, '专属未确认分支未完整执行')
  } catch (error) {
    errors.push(error)
  } finally {
    try {
      const current = await initSnapshot(readSql, '1')
      caseRecord.checks.push({
        name: '专属引导验证前后标准平台完整初始化事实不变',
        passed: baseline.hash === current.hash,
        details: `before=${baseline.hash}; after=${current.hash}; rows=${current.rows.length}`
      })
      need(baseline.hash === current.hash, '标准平台初始化事实被修改')
    } catch (error) {
      errors.push(error)
    }
    if (owner) {
      try {
        const tokens = await readSql(`SELECT 'access',COUNT(*) FROM system_oauth2_access_token
          WHERE tenant_id=${owner.tenantId} AND user_id=${owner.userId} AND deleted=0
          UNION ALL SELECT 'refresh',COUNT(*) FROM system_oauth2_refresh_token
          WHERE tenant_id=${owner.tenantId} AND user_id=${owner.userId} AND deleted=0`)
        const revoked = tokens?.available === true && tokens.rows.length === 2 &&
          ['access', 'refresh'].every((key) => tokens.rows.filter((row) =>
            row[0] === key && row[1] === '0').length === 1)
        caseRecord.checks.push({
          name: '专属未确认登录管理员访问与刷新令牌清零',
          passed: revoked, details: `tenantId=${owner.tenantId}; userId=${owner.userId}`
        })
        need(revoked, '专属登录令牌未全部清零')
      } catch (error) {
        errors.push(error)
      }
    }
  }
  if (errors.length) throw new AggregateError(errors, errors.map((error) => error.message).join('; '))
  caseRecord.checks.push({
    name: '未确认初始化真实登录进入引导中心',
    passed: true,
    details: `${JSON.stringify(fresh)}; private tenant/package/admin retired; tokens=0`
  })
  return { executed: true, ...fresh }
}
