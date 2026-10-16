import { openRoute, saveScreenshot } from '../lib/browser.mjs'

const requireFact = (condition, message) => {
  if (!condition) throw new Error(`COST-002 page: ${message}`)
}

export function costOpeningPageActions ({ outputDir, record }) {
  return {
    async selectFormalContext ({ page, fixture, phase }) {
      if (phase === 'formal') {
        await openRoute(page, '/cost-management/monthly/opening-wip', {
          readySelector: '[data-testid="formal-opening-wip"]', retries: 1
        })
      }
      const root = page.locator('[data-testid="formal-opening-wip"]')
      await root.waitFor({ state: 'visible' })
      const model = root.locator('[data-testid="opening-model-select"]')
      await model.locator('input').waitFor({ state: 'visible' })
      await page.waitForFunction(() => {
        const input = document.querySelector('[data-testid="opening-model-select"] input')
        return input && !input.disabled
      })
      await model.click()
      const modelOption = page.locator(
        `.el-select-dropdown:visible [data-model-id="${fixture.modelId}"]`
      )
      await modelOption.first().waitFor({ state: 'visible' })
      requireFact(await modelOption.count() === 1, '专属正式模型选项不唯一或缺失')
      requireFact(await modelOption.getAttribute('data-model-version') === fixture.versionNo,
        '专属正式模型版本不匹配')
      await modelOption.click()
      const period = root.locator('[data-testid="opening-period-select"]')
      await page.waitForFunction(() => {
        const input = document.querySelector('[data-testid="opening-period-select"] input')
        return input && !input.disabled
      })
      await period.click()
      const periodOption = page.locator(
        `.el-select-dropdown:visible [data-period-id="${fixture.periodId}"]`
      )
      await periodOption.first().waitFor({ state: 'visible' })
      requireFact(await periodOption.count() === 1, '专属正式期间选项不唯一或缺失')
      requireFact(await periodOption.getAttribute('data-month') === fixture.month,
        '专属正式期间月份不匹配')
      await periodOption.click()
      await root.locator('[data-testid="opening-formal-row"]').waitFor({ state: 'visible' })
      requireFact(await root.getAttribute('data-loaded') === 'true' &&
        await root.getAttribute('data-error') === '', '正式页面加载失败')
    },
    async observeFormalRow ({ page, fixture, phase }) {
      const root = page.locator('[data-testid="formal-opening-wip"]')
      const rows = root.locator('[data-testid="opening-formal-row"]')
      requireFact(await rows.count() === 1, '正式页面不是唯一专属在制行')
      const observation = await root.evaluate((element) => {
        const identities = [...element.querySelectorAll('[data-testid="opening-formal-row"]')]
        const identity = identities[0]
        const row = identity?.closest('tr')
        const attribute = (name) => identity?.getAttribute(`data-${name}`) || ''
        const text = (field) => row?.querySelector(`[data-field="${field}"]`)
          ?.textContent?.trim().replaceAll(',', '') || attribute(field.replace(/[A-Z]/g, (letter) =>
            `-${letter.toLowerCase()}`))
        return {
          modelId: element.dataset.modelId,
          versionNo: element.dataset.modelVersion,
          month: element.dataset.month,
          periodId: element.dataset.periodId,
          stage: element.dataset.stage,
          matchedRowCount: identities.length,
          row: identity && {
            backendId: attribute('backend-id'),
            materialId: attribute('material-id'),
            productCode: attribute('product-code'),
            costCenterCode: attribute('cost-center-code'),
            costCenterName: attribute('cost-center-name'),
            statusText: attribute('status-text') || row?.querySelector('.el-tag')?.textContent?.trim(),
            quantity: text('quantity'),
            materialAmount: text('materialAmount'),
            laborAmount: text('laborAmount'),
            expenseAmount: text('expenseAmount'),
            totalAmount: text('totalAmount'),
            unitCost: text('unitCost')
          }
        }
      })
      requireFact(observation.periodId === fixture.periodId, '观察期间漂移')
      await saveScreenshot(page, outputDir, `cost-002-formal-${phase}`, record)
      return observation
    }
  }
}
