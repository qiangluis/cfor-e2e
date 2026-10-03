import assert from 'node:assert/strict'
import path from 'node:path'
import { config } from '../config/index.mjs'
import { launchBrowser, login, openRoute, saveScreenshot } from '../lib/browser.mjs'
import { collectPagePerformance } from '../lib/performance.mjs'
import { createRunRecord, createCaseRecord, ensureDir, finishCase, writeReport } from '../lib/report.mjs'

const record = createRunRecord({ selectedCases: ['PROC-014-UI'] })
const caseRecord = createCaseRecord({
  id: 'PROC-014-UI', suite: 'procurement', title: '请购列表延迟挂载、无遮挡布局与首次弹窗回归'
})
record.cases.push(caseRecord)
const screenshots = path.join(config.outputRoot, record.runId, 'screenshots')
const caseStarted = Date.now()
const handle = await launchBrowser({ record })
const requestedModules = []
handle.page.on('request', (request) => requestedModules.push(new URL(request.url()).pathname))
const check = (name, passed, details = '') => {
  caseRecord.checks.push({ name, passed, details })
  assert.equal(passed, true, name)
}

try {
  await handle.context.tracing.start({ screenshots: true, snapshots: true, sources: true })
  await login(handle.page)
  const started = Date.now()
  await openRoute(handle.page, '/erp/purchase/purchaseRequest')
  await handle.page.locator('.request-status-tabs').waitFor({ state: 'visible' })
  await handle.page.locator('.vxe-cell--title:visible').filter({ hasText: /^行关闭$/ })
    .first().waitFor({ state: 'visible' })
  const actionColumn = handle.page.locator('.vxe-table--fixed-right-wrapper')
  const actionButtons = actionColumn.getByRole('button', {
    name: /^(修改|提审|审核|弃审|删除|整单关闭)$/
  })
  await actionButtons.first().waitFor({ state: 'visible' })
  caseRecord.performance = await collectPagePerformance(handle.page, Date.now() - started)
  const deferredModules = [
    '/src/views/erp/purchase/request/purchase/formDialog.vue',
    '/src/views/erp/purchase/request/purchase/switchOrder.vue',
    '/src/views/print/printIndex.vue'
  ]
  check('列表首屏不提前请求未打开的表单、来源弹窗与打印模块',
    deferredModules.every((module) => !requestedModules.includes(module)),
    `renderMs=${caseRecord.performance.renderMs}`)

  for (const width of [1600, 1280, 1024]) {
    await handle.page.setViewportSize({ width, height: 900 })
    await actionButtons.first().waitFor({ state: 'visible' })
    await handle.page.waitForFunction(() => {
      const left = document.querySelector('.vxe-table--fixed-left-wrapper')
      const right = document.querySelector('.vxe-table--fixed-right-wrapper')
      return left && right &&
        right.getBoundingClientRect().left - left.getBoundingClientRect().right >= 100
    })
    const fixedBounds = await handle.page.evaluate(() => {
      const left = document.querySelector('.vxe-table--fixed-left-wrapper').getBoundingClientRect()
      const right = document.querySelector('.vxe-table--fixed-right-wrapper').getBoundingClientRect()
      return { leftEnd: left.right, rightStart: right.left, centerWidth: right.left - left.right }
    })
    check(`${width}px 下左右固定列不交叠且保留可读滚动区`,
      fixedBounds.centerWidth >= 100, JSON.stringify(fixedBounds))

    const search = handle.page.locator('.request-search')
    const numberInput = search.getByPlaceholder('请输入请购单号', { exact: true })
    const searchBounds = await numberInput.evaluate((input) => {
      const rect = input.getBoundingClientRect()
      const probes = [rect.left + 4, (rect.left + rect.right) / 2, rect.right - 4]
      return {
        left: rect.left, right: rect.right,
        unobstructed: probes.every((x) =>
          document.elementFromPoint(x, (rect.top + rect.bottom) / 2) === input
        )
      }
    })
    check(`${width}px 下请购单号输入框全宽未被按钮遮挡`,
      searchBounds.unobstructed, JSON.stringify(searchBounds))
    const inputBox = await numberInput.boundingBox()
    await numberInput.click({ position: { x: inputBox.width - 8, y: inputBox.height / 2 } })
    check(`${width}px 下输入框右边缘可正常聚焦`,
      await numberInput.evaluate((input) => document.activeElement === input))
    const toggle = search.locator('.search-collapse__toggle')
    const searchTools = await search.evaluate((root) => {
      const toggle = root.querySelector('.search-collapse__toggle').getBoundingClientRect()
      const config = root.querySelector('.request-field-config').getBoundingClientRect()
      return { toggleEnd: toggle.right, configStart: config.left }
    })
    check(`${width}px 下展开按钮与字段配置不交叠`,
      searchTools.toggleEnd <= searchTools.configStart, JSON.stringify(searchTools))
    await toggle.click()
    await handle.page.waitForFunction(() =>
      document.querySelector('.request-search .search-collapse__toggle')?.textContent.includes('收起')
    )
    await search.getByPlaceholder('请输入供应商名称', { exact: true }).click()
    await toggle.click()
    await handle.page.waitForFunction(() =>
      document.querySelector('.request-search .search-collapse__toggle')?.textContent.includes('展开')
    )
    check(`${width}px 下展开、筛选与收起可真实点击`, true)
    const bounds = await actionColumn.evaluateAll(
      (wrappers) => wrappers.flatMap((wrapper) =>
        [...wrapper.querySelectorAll('button')].filter((button) =>
          button.getClientRects().length &&
          /^(修改|提审|审核|弃审|删除|整单关闭)$/.test(button.textContent.trim())
        ).map((button) => {
          const rect = button.getBoundingClientRect()
          const cell = button.closest('td').getBoundingClientRect()
          return rect.left >= cell.left && rect.right <= cell.right
        })
      )
    )
    check(`${width}px 下行操作完整位于固定操作列内`,
      bounds.length > 0 && bounds.every(Boolean), `buttons=${bounds.length}`)
    const pagerBounds = await handle.page.locator('.request-table .vxe-pager--wrapper')
      .evaluate((pager) => {
        const left = pager.querySelector('.vxe-pager--left-wrapper').getBoundingClientRect()
        const controls = [...pager.children]
          .filter((child) => !child.classList.contains('vxe-pager--left-wrapper'))
          .map((child) => child.getBoundingClientRect())
          .filter((rect) => rect.width > 0 && rect.height > 0)
        return { legendEnd: left.right, controlsStart: Math.min(...controls.map((rect) => rect.left)) }
      })
    check(`${width}px 下图例与分页控件不交叠`,
      pagerBounds.legendEnd <= pagerBounds.controlsStart, JSON.stringify(pagerBounds))
    await saveScreenshot(handle.page, screenshots, `request-list-${width}`, record)
  }

  await handle.page.setViewportSize({ width: 1600, height: 900 })
  await handle.page.getByRole('button', { name: '新增', exact: true }).click()
  const form = handle.page.locator('.el-dialog:visible').last()
  await form.waitFor({ state: 'visible' })
  check('首次点击新增可挂载并打开真实请购表单', requestedModules.includes(deferredModules[0]))
  const numberInput = form.getByPlaceholder('请输入请购单号', { exact: true })
  await handle.page.waitForFunction(
    (input) => Boolean(input.value.trim()), await numberInput.elementHandle()
  )
  check('新增表单通过真实规则取得非空请购编号', Boolean((await numberInput.inputValue()).trim()))
  await saveScreenshot(handle.page, screenshots, 'request-first-form', record)
  await handle.page.keyboard.press('Escape')
  await form.waitFor({ state: 'hidden' })
  await handle.page.getByRole('button', { name: '待生成请购', exact: true }).click()
  const pending = handle.page.locator('.el-dialog:visible').last()
  await pending.waitFor({ state: 'visible' })
  for (const label of ['生产订单', '销售订单', '现存量', 'MRP运算结果']) {
    await pending.getByText(label, { exact: true }).first().waitFor({ state: 'visible' })
  }
  check('首次点击待生成请购可挂载并打开四类真实来源页签',
    requestedModules.includes(deferredModules[1]))
  await saveScreenshot(handle.page, screenshots, 'request-first-pending', record)
  await handle.page.keyboard.press('Escape')
  await pending.waitFor({ state: 'hidden' })
  await handle.flushResponses()
  check('无控制台、页面、浏览器业务接口错误或请求失败',
    !record.consoleErrors.length && !record.pageErrors.length &&
      !record.failedApiResponses.length && !record.requestFailures.length,
    JSON.stringify({
      console: record.consoleErrors, page: record.pageErrors, api: record.failedApiResponses,
      request: record.requestFailures
    }))
  caseRecord.evidence.push('真实 admin Chrome；新增弹窗会取号，不保存、生成请购或执行打印')
  check('请购列表首屏渲染耗时不超过 5 秒',
    caseRecord.performance.withinBudget, `renderMs=${caseRecord.performance.renderMs}`)
  finishCase(caseRecord, 'PASS')
} catch (error) {
  finishCase(caseRecord, 'FAIL', error.message)
  await saveScreenshot(handle.page, screenshots, 'request-ui-fail', record).catch(() => {})
} finally {
  try {
    const traceDir = ensureDir(path.join(config.outputRoot, record.runId, 'trace'))
    await handle.context.tracing.stop({ path: path.join(traceDir, 'browser.zip') })
  } finally {
    await handle.browser.close()
  }
  caseRecord.durationMs = Date.now() - caseStarted
}
const report = await writeReport(record)
console.log(`[${caseRecord.status}] PROC-014-UI report=${report.resultFile}`)
process.exitCode = record.passed ? 0 : 1
