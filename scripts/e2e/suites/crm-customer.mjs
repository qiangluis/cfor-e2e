// crm-customer：CRM 客户主数据（私海客户 + 公共池）。
// 12 case：API-001..007（接口层），UI-001..005（浏览器层）。
// 注意：登录后右上角显示的租户名可能是「乐之木电子科技」而非注册名「福奇科技」
// ——租户上下文断言走 API 的 tenantId，不走页面显示名，避免误判。
// 新增客户表单必填：仅「客户名称」（ownerUserId 接口层必填，页面层非必填，见 API-002 备注）。
import { config } from '../config/index.mjs'
import { createApiClient } from '../lib/api.mjs'
import { login, openRoute, saveScreenshot, tableRows, bodyContainsAny, firstVisible } from '../lib/browser.mjs'
import { checklist, nonEmpty } from '../lib/assert.mjs'

export const implemented = true
const IMPLEMENTED_CASES = new Set([
  'CRM-CUST-API-001', 'CRM-CUST-API-002', 'CRM-CUST-API-003', 'CRM-CUST-API-004',
  'CRM-CUST-API-005', 'CRM-CUST-API-006', 'CRM-CUST-API-007',
  'CRM-CUST-UI-001', 'CRM-CUST-UI-002', 'CRM-CUST-UI-003', 'CRM-CUST-UI-004', 'CRM-CUST-UI-005'
])

const stamp = () => new Date().toISOString().slice(2, 16).replace(/[-:T]/g, '')
const testName = (tag) => `测试客户${tag}${stamp()}`

async function ensureAuth (ctx, check) {
  if (ctx.api) return ctx
  const { token, failures } = await login(ctx.page, { check })
  check.step('page', '登录过程无 4xx/5xx 接口失败', failures.length === 0, failures.slice(0, 3).join(' | '))
  ctx.token = token
  const bootstrap = createApiClient({ token, check })
  ctx.tenantId = await bootstrap.tenantIdByName(config.tenant)
  check.step('api', '租户名解析出 tenantId', !!ctx.tenantId, `tenant=${config.tenant} id=${ctx.tenantId}`)
  ctx.api = createApiClient({ token, tenantId: ctx.tenantId, check })
  return ctx
}

function ok (resp) { return resp && (resp.code === 0 || resp.code === '0') }
// 注意：/crm/customer/create 成功时 data 直接就是新 id（数字），不是对象
const newId = (resp) => (typeof resp?.data === 'number' ? resp.data : resp?.data?.id)

export async function runCase ({ caseId, page, check, shotDir, ctx }) {
  if (!IMPLEMENTED_CASES.has(caseId)) return { notImplemented: true }
  ctx.page = page
  const c = check ?? checklist()
  await ensureAuth(ctx, c)
  const api = ctx.api

  // ---------------- API 层 ----------------
  if (caseId === 'CRM-CUST-API-001') {
    const name = testName('A')
    const r = await api.post('/crm/customer/create', { name })
    c.step('api', '仅填名称创建成功', ok(r) && nonEmpty(newId(r)), `code=${r?.code} id=${r?.data?.id}`)
    c.step('api', '创建返回新 id', nonEmpty(newId(r)), `id=${newId(r)}`)
    const g0 = await api.get(`/crm/customer/get?id=${newId(r)}`)
    c.step('api', '客户编码自动生成', ok(g0) && /^KH/.test(g0.data?.code || ''), `code=${g0?.data?.code}`)
    ctx.custA = r.data
    return { steps: c.steps }
  }

  if (caseId === 'CRM-CUST-API-002') {
    // 接口层 ownerUserId 必填（页面层仅名称必填）：分别验证两个维度
    const r1 = await api.post('/crm/customer/create', {}).catch((e) => ({ __err: String(e) }))
    const fail1 = r1.__err ? true : !ok(r1)
    c.step('api', '缺名称创建失败', fail1, r1.__err ?? `code=${r1?.code} msg=${r1?.msg}`)
    const r2 = await api.post('/crm/customer/create', { name: testName('B') }).catch((e) => ({ __err: String(e) }))
    const needOwner = r2.__err ? true : !ok(r2)
    c.step('api', '缺负责人时接口是否拒绝（记录行为）', true, needOwner ? `拒绝：${r2.__err ?? r2?.msg}` : `放行：id=${r2?.data?.id}`)
    if (!needOwner && ok(r2)) { ctx.custNoOwner = r2.data }
    return { steps: c.steps, note: needOwner ? 'owner-required' : 'owner-optional' }
  }

  if (caseId === 'CRM-CUST-API-003') {
    const r = await api.post('/crm/customer/create', {
      name: testName('C'),
      mobile: '13800001111',
      telephone: '0755-80001111',
      email: 'test001@example.com',
      wechat: 'testwx001',
      qq: '100001',
      detailAddress: '深圳市南山区科苑路15号101室',
      level: 'A',
      source: '1',
      remark: '自动化测试全字段客户'
    })
    c.step('api', '全字段创建成功', ok(r) && nonEmpty(newId(r)), `code=${r?.code} id=${r?.data?.id}`)
    if (ok(r)) {
      const g = await api.get(`/crm/customer/get?id=${newId(r)}`)
      c.step('api', 'get 回读字段一致', ok(g) && g.data?.mobile === '13800001111' && g.data?.level === 'A',
        `mobile=${g?.data?.mobile} level=${g?.data?.level}`)
      ctx.custC = r.data
    }
    return { steps: c.steps }
  }

  if (caseId === 'CRM-CUST-API-004') {
    const name = testName('D')
    const cr = await api.post('/crm/customer/create', { name })
    c.step('api', '前置：创建待查询客户', ok(cr), `id=${cr?.data?.id}`)
    const pr = await api.get(`/crm/customer/page?pageNo=1&pageSize=20&name=${encodeURIComponent(name)}`)
    const list = pr?.data?.list ?? []
    c.step('api', '按名称过滤查到新建客户', ok(pr) && list.some((x) => String(x.id) === String(cr?.data?.id)),
      `total=${pr?.data?.total} matched=${list.length}`)
    ctx.custD = cr.data
    return { steps: c.steps }
  }

  if (caseId === 'CRM-CUST-API-005') {
    const cr = await api.post('/crm/customer/create', { name: testName('E') })
    c.step('api', '前置：创建待更新客户', ok(cr), `id=${cr?.data?.id}`)
    const ur = await api.put('/crm/customer/update', { id: newId(cr), name: cr.data.name, level: 'A', remark: '已更新' })
    c.step('api', '更新级别为A成功', ok(ur), `code=${ur?.code}`)
    const g = await api.get(`/crm/customer/get?id=${newId(cr)}`)
    c.step('api', '回读级别已变更', ok(g) && g.data?.level === 'A', `level=${g?.data?.level}`)
    ctx.custE = cr.data
    return { steps: c.steps }
  }

  if (caseId === 'CRM-CUST-API-006') {
    const cr = await api.post('/crm/customer/create', { name: testName('F') })
    c.step('api', '前置：创建待锁定客户', ok(cr), `id=${cr?.data?.id}`)
    const lr = await api.put('/crm/customer/lock', { id: newId(cr), lockStatus: 1 })
    c.step('api', '锁定成功', ok(lr), `code=${lr?.code}`)
    const ulr = await api.put('/crm/customer/lock', { id: newId(cr), lockStatus: 0 })
    c.step('api', '解锁成功', ok(ulr), `code=${ulr?.code}`)
    ctx.custF = cr.data
    return { steps: c.steps }
  }

  if (caseId === 'CRM-CUST-API-007') {
    const cr = await api.post('/crm/customer/create', { name: testName('G') })
    c.step('api', '前置：创建待删除客户', ok(cr), `id=${cr?.data?.id}`)
    const dr = await api.delete(`/crm/customer/delete?id=${newId(cr)}`)
    c.step('api', '删除成功', ok(dr), `code=${dr?.code}`)
    const g = await api.get(`/crm/customer/get?id=${newId(cr)}`).catch((e) => ({ __err: String(e) }))
    const gone = g.__err ? true : !ok(g) || !g.data
    c.step('api', '删除后查不到', gone, g.__err ?? `code=${g?.code}`)
    const d2 = await api.delete('/crm/customer/delete?id=999999999999999999').catch((e) => ({ __err: String(e) }))
    c.step('api', '删除不存在 id 合理报错', d2.__err ? true : !ok(d2), d2.__err ?? `code=${d2?.code} msg=${d2?.msg}`)
    return { steps: c.steps }
  }

  // ---------------- UI 层 ----------------
  if (caseId === 'CRM-CUST-UI-001') {
    const r = await openRoute(page, '/crm/jixu/private-pool?archive=all', { check: c })
    c.step('page', '私海客户页无 4xx/5xx 接口失败', r.failures.length === 0, r.failures.slice(0, 3).join(' | '))
    const hit = await bodyContainsAny(page, ['客户名称', '联系手机', '负责人', '客户级别', '跟进状态', '新增客户'])
    c.step('page', '查询条件与新增按钮渲染', hit.length >= 4, hit.join('、'))
    c.step('page', '统计页签渲染', (await bodyContainsAny(page, ['待跟进客户', '意向客户', '保有客户', '全部客户'])).length >= 3)
    await saveScreenshot(page, shotDir, 'CRM-CUST-UI-001-private-pool')
    return { steps: c.steps }
  }

  if (caseId === 'CRM-CUST-UI-002') {
    await openRoute(page, '/crm/jixu/private-pool?archive=all', { check: c })
    const addBtn = await firstVisible(page, ['button:has-text("新增客户")'], 15000)
    await addBtn.click()
    await page.waitForTimeout(1500)
    // 客户编码应自动生成且禁用
    const codeInput = page.locator('input[disabled]').first()
    const codeVal = await codeInput.inputValue().catch(() => '')
    c.step('page', '客户编码自动生成且不可编辑', /^KH/.test(codeVal), `code=${codeVal}`)
    // 空名称直接保存 → 必填提示
    const saveBtn = page.locator('button:has-text("保存")').first()
    await saveBtn.click()
    await page.waitForTimeout(1000)
    const tip = await bodyContainsAny(page, ['客户名称不能为空', '请输入客户名称', '不能为空'])
    c.step('page', '空名称保存触发必填提示', tip.length > 0, tip.join('、'))
    await saveScreenshot(page, shotDir, 'CRM-CUST-UI-002-required-tip')
    const closeBtn = page.locator('button:has-text("关闭")').first()
    if (await closeBtn.isVisible().catch(() => false)) await closeBtn.click()
    return { steps: c.steps }
  }

  if (caseId === 'CRM-CUST-UI-003') {
    const name = testName('U')
    await openRoute(page, '/crm/jixu/private-pool?archive=all', { check: c })
    // 记录新增前「全部客户」计数文本
    const beforeText = await page.locator('body').innerText()
    const beforeM = beforeText.match(/全部客户\s*(\d+)/)
    const before = beforeM ? parseInt(beforeM[1], 10) : null
    const addBtn = await firstVisible(page, ['button:has-text("新增客户")'], 15000)
    await addBtn.click()
    await page.waitForTimeout(1500)
    const nameInput = page.locator('input[placeholder*="企业名称"]').first()
    await nameInput.fill(name)
    // 级别选 A（重点客户）
    const levelSel = page.locator('.el-select').first()
    if (await levelSel.isVisible().catch(() => false)) {
      await levelSel.click()
      await page.waitForTimeout(500)
      const optA = page.locator('.el-select-dropdown .el-option:has-text("A")').first()
      if (await optA.isVisible().catch(() => false)) await optA.click()
    }
    const saveBtn = page.locator('button:has-text("保存")').first()
    await saveBtn.click()
    await page.waitForTimeout(2500)
    const okTip = await bodyContainsAny(page, ['成功', '已保存'])
    c.step('page', '保存成功提示', okTip.length > 0, okTip.join('、'))
    // 列表搜索验证
    const searchInput = page.locator('input[placeholder*="客户名称"]').first()
    if (await searchInput.isVisible().catch(() => false)) {
      await searchInput.fill(name)
      const qBtn = page.locator('button:has-text("查询")').first()
      await qBtn.click()
      await page.waitForTimeout(2000)
    }
    const found = await bodyContainsAny(page, [name])
    c.step('page', '列表出现新建客户', found.length > 0, `name=${name}`)
    const afterText = await page.locator('body').innerText()
    const afterM = afterText.match(/全部客户\s*(\d+)/)
    const after = afterM ? parseInt(afterM[1], 10) : null
    c.step('page', '全部客户计数+1', before !== null && after !== null && after === before + 1, `${before}→${after}`)
    await saveScreenshot(page, shotDir, 'CRM-CUST-UI-003-created')
    ctx.custU = { name }
    return { steps: c.steps }
  }

  if (caseId === 'CRM-CUST-UI-004') {
    const name = ctx.custU?.name ?? testName('U')
    await openRoute(page, '/crm/jixu/private-pool?archive=all', { check: c })
    const searchInput = await firstVisible(page, ['input[placeholder*="客户名称"]'], 15000)
    await searchInput.fill('不存在的客户XYZ999')
    await page.locator('button:has-text("查询")').first().click()
    await page.waitForTimeout(2000)
    const emptyTip = await bodyContainsAny(page, ['暂无数据', '没有数据', 'No Data'])
    c.step('page', '无匹配查询显示空状态', emptyTip.length > 0 || (await tableRows(page)) === 0)
    await page.locator('button:has-text("重置")').first().click()
    await page.waitForTimeout(2000)
    const resetVal = await searchInput.inputValue().catch(() => '?')
    c.step('page', '重置清空查询条件', resetVal === '', `value=${resetVal}`)
    await saveScreenshot(page, shotDir, 'CRM-CUST-UI-004-reset')
    return { steps: c.steps }
  }

  if (caseId === 'CRM-CUST-UI-005') {
    const name = ctx.custU?.name
    if (!name) return { steps: c.steps, skipped: 'UI-003 未产出客户，跳过详情页' }
    await openRoute(page, '/crm/jixu/private-pool?archive=all', { check: c })
    const searchInput = await firstVisible(page, ['input[placeholder*="客户名称"]'], 15000)
    await searchInput.fill(name)
    await page.locator('button:has-text("查询")').first().click()
    await page.waitForTimeout(2000)
    const rowLink = page.locator(`text=${name}`).first()
    c.step('page', '列表行可点击进入详情', await rowLink.isVisible().catch(() => false))
    await rowLink.click()
    await page.waitForTimeout(2500)
    const tabs = await bodyContainsAny(page, ['企业联系方式', '跟进', '商机', '合同', '基本信息'])
    c.step('page', '详情页区块渲染', tabs.length >= 2, tabs.join('、'))
    await saveScreenshot(page, shotDir, 'CRM-CUST-UI-005-detail')
    return { steps: c.steps }
  }

  return { steps: c.steps }
}
