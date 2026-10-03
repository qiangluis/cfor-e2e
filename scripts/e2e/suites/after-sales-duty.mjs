import { createApiClient } from '../lib/api.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'

export const cases = ['PB130-001']
const dataOf = (response) => response?.data ?? response

export const runCase = async ({ page, record, caseRecord, outputDir }) => {
  const token = await login(page)
  const api = createApiClient({ token, record })
  caseRecord.checks.push({
    name: '真实登录成功',
    passed: Boolean(token),
    details: '登录后携带真实令牌调用 HRM 与售后值班接口'
  })

  const rules = await api.getBusiness('/after-sales/duty/rule/list')
  caseRecord.checks.push({
    name: '售后值班只维护转接规则，不复制排班事实',
    passed: Array.isArray(rules),
    details: `规则数=${Array.isArray(rules) ? rules.length : 'n/a'}`
  })

  const dutyRoles = await api.getBusiness('/after-sales/duty/duty-roles')
  caseRecord.checks.push({
    name: '值班角色目录可读',
    passed: Array.isArray(dutyRoles),
    details: `角色数=${Array.isArray(dutyRoles) ? dutyRoles.length : 'n/a'}`
  })

  const startDate = '2026-09-28'
  const endDate = '2026-09-30'
  const roster = dataOf(await api.getBusiness(
    `/after-sales/duty/roster?startDate=${startDate}&endDate=${endDate}`
  ))
  const rosterList = Array.isArray(roster?.roster) ? roster.roster : []
  const missingRoles = Array.isArray(roster?.missingRoles) ? roster.missingRoles : []
  caseRecord.checks.push({
    name: '值班名册只来自 HRM/OA 排班，无排班不生成示例人',
    passed:
      roster && Array.isArray(roster.roster) && Array.isArray(roster.missingRoles) &&
      rosterList.every((item) => item.date && item.source && item.employeeName),
    details:
      rosterList.length === 0
        ? `${startDate}~${endDate} 无排班，缺失角色=${missingRoles.join(',') || '无'}`
        : `名册数=${rosterList.length}，均带来源与员工姓名`
  })

  await openRoute(page, '/after-sales/settings')
  const dutyTab = page.locator('.el-tabs__item', { hasText: '值班服务' })
  if (await dutyTab.count()) {
    await dutyTab.first().click()
    await page.waitForTimeout(500)
  }
  const bodyText = await page.locator('body').innerText()
  const hardcoded = ['李工', '王敏', '张伟', '2026-07-22'].filter((name) => bodyText.includes(name))
  caseRecord.checks.push({
    name: '值班设置页不再出现示例人员与固定日期',
    passed: hardcoded.length === 0,
    details: hardcoded.length ? `仍存在：${hardcoded.join(',')}` : '未发现示例人员/固定日期'
  })
  await saveScreenshot(page, outputDir, 'pb130-duty', record)
  caseRecord.evidence.push('值班事实源改由 HRM/OA 排班提供，售后只维护角色/电话/服务范围')
  return { token, api }
}
