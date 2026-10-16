import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const base = process.env.CFOR_FIXTURE_URL || 'http://localhost:9151'
const output = process.env.CFOR_FIXTURE_OUTPUT || '/tmp/cfor-employee-fixture-20261014'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({
  executablePath:
    process.platform === 'darwin' && process.arch === 'arm64'
      ? fileURLToPath(new URL('./lib/chrome-macos.sh', import.meta.url))
      : process.env.CFOR_CHROME_PATH ||
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  env: {
    ...process.env,
    CFOR_NATIVE_CHROME_PATH:
      process.env.CFOR_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  },
  headless: true
})
let page
const errors = []
const blocked = []
async function settlePage() {
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.el-loading-mask')].every(
      (element) =>
        getComputedStyle(element).display === 'none' ||
        getComputedStyle(element).visibility === 'hidden' ||
        getComputedStyle(element).opacity === '0'
    )
  )
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  )
}
async function screenshot(name) {
  await settlePage()
  await page.screenshot({ path: `${output}/${name}.png`, fullPage: true, animations: 'disabled' })
}
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.origin === new URL(base).origin && !url.pathname.includes('/admin-api/')) {
      await route.continue()
    } else {
      blocked.push(`${route.request().method()} ${url.origin}${url.pathname}`)
      await route.abort()
    }
  })
  page = await context.newPage()
  page.setDefaultTimeout(15000)
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`${base}/tests/fixtures/hrm-employee.html`, {
    waitUntil: 'commit',
    timeout: 90000
  })
  await page.getByRole('cell', { name: 'EMP-001', exact: true }).waitFor({ timeout: 90000 })
  await page.getByRole('cell', { name: 'EMP-002', exact: true }).waitFor()
  console.log('Employee fixture list loaded')
  await screenshot('employee-list-desktop')

  const queryForm = page.locator('.el-form').first()
  await queryForm
    .locator('.el-form-item')
    .filter({ hasText: '入职状态' })
    .locator('.el-select')
    .click()
  await page.getByRole('option', { name: '在职', exact: true }).click()
  await queryForm.getByRole('button', { name: '搜索', exact: true }).click()
  await page.getByRole('cell', { name: 'EMP-002', exact: true }).waitFor({ state: 'hidden' })
  const query = await page.evaluate(
    () =>
      window.hrmEmployeeFixture.requests
        .filter((request) => request.path === '/hrm/employee/page')
        .at(-1).params
  )
  assert.equal(query.entryStatus, 1)
  assert.equal(query.status, undefined)
  assert.equal(query.pageSize, 100)

  const row = page.locator('.el-table__body-wrapper tr').filter({ hasText: 'EMP-001' })
  await row.getByRole('button', { name: '编辑', exact: true }).click()
  let dialog = page.getByRole('dialog', { name: '编辑', exact: true })
  await dialog.getByPlaceholder('请输入员工姓名').waitFor()
  assert.equal(await dialog.getByPlaceholder('请输入员工姓名').inputValue(), '回归员工甲')
  await dialog.getByRole('tab', { name: '入职信息', exact: true }).click()
  await dialog
    .locator('[role="tab"][aria-selected="true"]')
    .filter({ hasText: '入职信息' })
    .waitFor()
  assert.equal(await dialog.getByPlaceholder('请输入工号').inputValue(), 'EMP-001')
  await screenshot('employee-edit-desktop')
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })

  await row.getByRole('button', { name: '更多', exact: true }).click()
  await page.getByRole('menuitem', { name: '绑定用户', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '编辑', exact: true })
  await dialog.getByPlaceholder('请输入员工姓名').waitFor()
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })

  for (const [action, title] of [
    ['办理转正', '办理转正'],
    ['调整部门/岗位', '调整部门/岗位'],
    ['晋升', '办理晋升'],
    ['降级', '办理降级'],
    ['办理离职', '办理离职']
  ]) {
    await row.getByRole('button', { name: '更多', exact: true }).click()
    await page.getByRole('menuitem', { name: action, exact: true }).click()
    dialog = page.getByRole('dialog', { name: title, exact: true })
    await dialog.waitFor()
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
  }

  await row.getByRole('button', { name: '合同', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '员工合同', exact: true })
  await dialog.waitFor()
  await dialog.getByText('暂无数据', { exact: true }).waitFor()
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })

  await row.getByRole('button', { name: '经历', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '员工经历与异动', exact: true })
  for (const name of ['教育经历', '工作经历', '培训经历', '异动记录']) {
    await dialog.getByRole('tab', { name, exact: true }).click()
    await dialog.locator('[role="tab"][aria-selected="true"]').filter({ hasText: name }).waitFor()
    await dialog.getByRole('tabpanel').filter({ hasText: '暂无数据' }).waitFor()
  }
  await screenshot('employee-experience-desktop')
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })

  await queryForm.getByRole('button', { name: '重置', exact: true }).click()
  await page.getByRole('cell', { name: 'EMP-002', exact: true }).waitFor()
  await page.evaluate(() =>
    window.hrmEmployeeFixture.router.replace({
      query: { statusCategory: '11', todoType: '3', leaderEmployeeId: '9223372036854775001' }
    })
  )
  await page.getByText('合同即将到期', { exact: true }).waitFor()
  await page.getByText('团队直属员工', { exact: true }).waitFor()
  await queryForm.getByRole('button', { name: '重置', exact: true }).click()
  await page.getByText('合同即将到期', { exact: true }).waitFor({ state: 'hidden' })

  const requests = await page.evaluate(() => window.hrmEmployeeFixture.requests)
  assert.equal(
    requests.every((request) => request.method === 'get'),
    true
  )
  assert.equal(
    requests
      .filter((request) => request.path === '/hrm/employee/get')
      .every((request) => request.query.id === '9223372036854775001'),
    true
  )
  for (const kind of [
    'contract',
    'education-experience',
    'work-experience',
    'training-experience',
    'change-record'
  ]) {
    const request = requests.find((request) => request.path === `/hrm/employee/${kind}/list`)
    assert.equal(request?.params.employeeId, '9223372036854775001', kind)
  }
  for (const [width, height] of [
    [1280, 720],
    [390, 844]
  ]) {
    await page.setViewportSize({ width, height })
    // ContentWrap remeasures collapsed search controls after a debounced resize.
    await page.waitForTimeout(300)
    await page.locator('.el-table__body-wrapper .el-scrollbar__wrap').evaluate((element) => {
      element.scrollLeft = 0
    })
    await screenshot(`employee-list-${width}`)
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      `Page overflow at ${width}px`
    )
    const controls = await queryForm
      .getByRole('button', { name: '搜索', exact: true })
      .boundingBox()
    const input = await queryForm.getByPlaceholder('请输入员工姓名').boundingBox()
    assert.ok(controls && input)
    assert.ok(
      controls.y >= input.y + input.height ||
        input.y >= controls.y + controls.height ||
        controls.x >= input.x + input.width ||
        input.x >= controls.x + controls.width,
      `Search controls overlap the employee-name field at ${width}px`
    )
    const paginationClipped = await page.locator('.el-pagination').evaluate((element) =>
      [...element.children].some((child) => {
        const { left, right, width } = child.getBoundingClientRect()
        return width > 0 && (left < 0 || right > innerWidth)
      })
    )
    assert.equal(paginationClipped, false, `Pagination clipped at ${width}px`)
    if (width < 640) {
      assert.equal(await page.locator('.el-table__body-wrapper .is-fixed-column--right').count(), 0)
      await page.getByRole('columnheader', { name: '工号', exact: true }).waitFor()
    }
  }
  assert.deepEqual(errors, [])
  assert.deepEqual(blocked, [])
  console.log(`Employee real-component fixture PASS; screenshots: ${output}`)
} catch (error) {
  if (page) await page.screenshot({ path: `${output}/failure.png`, fullPage: true }).catch(() => {})
  console.error(JSON.stringify({ pageErrors: errors, blockedRequests: blocked }))
  throw error
} finally {
  await browser.close()
}
