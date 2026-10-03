import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { config } from './config/index.mjs'
import { chromeLaunchOptions } from './lib/browser.mjs'

const output = path.join(config.outputRoot, `startup-${Date.now()}`)
fs.mkdirSync(output, { recursive: true })
const browser = await chromium.launch({
  ...chromeLaunchOptions(),
  headless: true,
  timeout: 30000
})

try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
  const session = await page.context().newCDPSession(page)
  const pending = new Set()
  const errors = []
  const requests = []
  const started = Date.now()
  const safeUrl = (url) => {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  }
  page.on('request', (request) => pending.add(safeUrl(request.url())))
  page.on('requestfinished', (request) => pending.delete(safeUrl(request.url())))
  page.on('requestfailed', (request) => {
    pending.delete(safeUrl(request.url()))
    errors.push({ url: safeUrl(request.url()), error: request.failure()?.errorText })
  })
  page.on('response', (response) => {
    requests.push({
      elapsedMs: Date.now() - started,
      status: response.status(),
      url: safeUrl(response.url())
    })
  })
  page.on('pageerror', (error) => errors.push({ error: error.message }))
  await session.send('Profiler.enable')
  await session.send('Profiler.start')
  await page.goto(`${config.webBase}/login`, {
    waitUntil: 'domcontentloaded',
    timeout: 20000
  }).catch((error) => errors.push({ error: error.message }))
  const { profile } = await session.send('Profiler.stop')
  fs.writeFileSync(path.join(output, 'startup.cpuprofile'), JSON.stringify(profile))
  const samples = new Map()
  for (const id of profile.samples || []) samples.set(id, (samples.get(id) || 0) + 1)
  const hot = profile.nodes
    .map((node) => ({
      samples: samples.get(node.id) || 0,
      function: node.callFrame.functionName,
      url: node.callFrame.url,
      line: node.callFrame.lineNumber + 1
    }))
    .sort((a, b) => b.samples - a.samples)
    .slice(0, 20)
  await page.locator('.portal-login-card').waitFor({ timeout: 30000 })
    .catch((error) => errors.push({ error: error.message }))
  const result = {
    elapsedMs: Date.now() - started,
    url: page.url(),
    pending: [...pending],
    errors,
    requests,
    hot
  }
  fs.writeFileSync(path.join(output, 'diagnosis.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ output, ...result, requests: requests.slice(-15) }, null, 2))
  await page.screenshot({ path: path.join(output, 'login.png'), timeout: 15000 })
    .catch((error) => console.error(error.message))
} finally {
  await browser.close()
}
