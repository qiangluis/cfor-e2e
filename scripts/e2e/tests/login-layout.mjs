import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { chromeLaunchOptions } from '../lib/browser.mjs'
import { config } from '../config/index.mjs'

const output = path.join(config.outputRoot, `login-layout-${Date.now()}`)
fs.mkdirSync(output, { recursive: true })
const browser = await chromium.launch({ ...chromeLaunchOptions(), headless: true })
const results = []
try {
  const page = await browser.newPage()
  for (const viewport of [
    { width: 1600, height: 900 }, { width: 1280, height: 720 }, { width: 390, height: 844 }
  ]) {
    await page.setViewportSize(viewport)
    const started = Date.now()
    await page.goto(`${config.webBase}/login`, { waitUntil: 'domcontentloaded' })
    await page.locator('.portal-login-card').waitFor()
    const geometry = await page.evaluate(() => {
      const card = document.querySelector('.portal-login-card').getBoundingClientRect()
      const footer = document.querySelector('.portal-login-footer').getBoundingClientRect()
      const container = document.querySelector('.portal-login-page')
      return {
        cardBottom: card.bottom, footerTop: footer.top,
        scrollWidth: container.scrollWidth, clientWidth: container.clientWidth
      }
    })
    assert.ok(geometry.footerTop >= geometry.cardBottom, 'footer overlaps login form')
    assert.ok(geometry.scrollWidth <= geometry.clientWidth + 1, 'login page overflows horizontally')
    const button = page.locator('.portal-login-card').getByRole('button', { name: '登录', exact: true })
    await button.scrollIntoViewIfNeeded()
    const accessible = await button.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      return element === target || element.contains(target)
    })
    assert.ok(accessible, 'login button is obscured')
    await page.screenshot({ path: path.join(output, `${viewport.width}x${viewport.height}.png`) })
    results.push({ viewport, elapsedMs: Date.now() - started, geometry, buttonAccessible: accessible })
  }
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(results, null, 2))
  console.log(JSON.stringify({ output, results }, null, 2))
} finally {
  await browser.close()
}
