import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { launchBrowser } from './lib/browser.mjs'

const base = process.env.CFOR_FIXTURE_URL || 'http://localhost:9151'
const output = process.env.CFOR_FIXTURE_OUTPUT || '/tmp/cfor-bpm-model-fixture'
await mkdir(output, { recursive: true })
const record = { consoleErrors: [], pageErrors: [], failedApiResponses: [] }
const { browser, context, page } = await launchBrowser({ record })
page.setDefaultTimeout(15000)

const modelCalls = () =>
  page.evaluate(
    () => window.bpmModelFixture.requests.filter((url) => url === '/bpm/model/list').length
  )
const waitForCount = (count) =>
  page.waitForFunction(
    (count) =>
      window.bpmModelFixture?.requests.filter((url) => url === '/bpm/category/simple-list')
        .length === count,
    count
  )

try {
  for (const cached of [false, true]) {
    await page.goto(`${base}/tests/fixtures/bpm-model.html?cached=${cached ? 1 : 0}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    })
    await page.getByRole('heading', { name: '业务审批', exact: true }).waitFor()
    await page.getByRole('heading', { name: '未匹配分类', exact: true }).waitFor()
    assert.equal(await modelCalls(), 1, 'Initial mount must load exactly once')
    await page.getByRole('button', { name: '切换页面', exact: true }).click()
    await page.getByRole('heading', { name: '流程模型', exact: true }).waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: '切换页面', exact: true }).click()
    await waitForCount(2)
    assert.equal(await modelCalls(), 2, 'Re-entering must refresh the list')
    await page.getByPlaceholder('搜索流程').fill('合同')
    await page.getByPlaceholder('搜索流程').press('Enter')
    await waitForCount(3)
    await page
      .getByRole('heading', { name: '未匹配分类', exact: true })
      .waitFor({ state: 'hidden' })
    await page.screenshot({
      path: `${output}/${cached ? 'cached' : 'uncached'}.png`,
      fullPage: true
    })
  }

  await page.goto(`${base}/tests/fixtures/bpm-model.html?empty=1`, {
    waitUntil: 'domcontentloaded'
  })
  await page.getByText('暂无流程模型', { exact: true }).waitFor()
  assert.equal(await modelCalls(), 1)
  assert.deepEqual(record.pageErrors, [])
  assert.deepEqual(record.failedApiResponses, [])
  console.log(`BPM model lifecycle PASS: uncached, cached, search, empty; ${output}`)
} finally {
  await context.close()
  await browser.close()
}
