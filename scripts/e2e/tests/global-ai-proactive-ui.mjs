import assert from 'node:assert/strict'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { config } from '../config/index.mjs'
import { launchBrowser, login, openRoute, saveScreenshot } from '../lib/browser.mjs'
import { atomicWriteFile, reportSnapshot } from '../lib/report.mjs'

assert.equal(config.target, 'local')
assert.equal(String(config.tenantId), '1')
const storageStatePath = process.env.CFOR_PROACTIVE_UI_STORAGE_STATE?.trim()
const allowLogin = process.env.CFOR_PROACTIVE_UI_ALLOW_LOGIN === 'true'
assert.ok(storageStatePath || allowLogin,
  'Provide an authenticated CFOR_PROACTIVE_UI_STORAGE_STATE or explicitly authorize login POST')
assert.ok(!(storageStatePath && allowLogin), 'Choose one explicit authentication mode')
const storageState = storageStatePath ? JSON.parse(readFileSync(storageStatePath, 'utf8')) : null
const outputDir = path.join(config.outputRoot, `proactive-ui-${Date.now()}`)
const record = {
  layer: 'real-route-component-ui-only',
  productCaseCount: 0,
  startedAt: new Date().toISOString(),
  consoleErrors: [], pageErrors: [], failedApiResponses: [], requestFailures: [], api: [], screenshots: [],
  checks: [], blockedWrites: [], observedPreviews: [], interactions: [], uiDiagnostics: [],
  authenticationMode: storageState ? 'existing-storage-state' : 'explicit-login-only',
  authenticationRequests: []
}
const browserHandle = await launchBrowser({ headed: true, record })
const { page, context } = browserHandle
const bubbleSelector = '.assistant-proactive-bubble:not(.assistant-proactive-leave-active)'
const captureUiState = async (stage) => {
  const snapshot = await page.evaluate((bubbleSelector) => {
    const describe = (node) => node instanceof Element ? {
      tag: node.tagName, class: node.getAttribute('class'), label: node.getAttribute('aria-label')
    } : null
    const bounds = (node) => {
      if (!node) return null
      const rect = node.getBoundingClientRect()
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    }
    const current = document.querySelector(bubbleSelector)
    const close = current?.querySelector('.assistant-proactive-dismiss')
    const rect = close?.getBoundingClientRect()
    const elements = [
      ['bubble', current], ['dismiss', close],
      ['shell', document.querySelector('.assistant-rail-shell')],
      ['rail', document.querySelector('.assistant-rail')]
    ]
    return {
      at: performance.now(), viewport: { width: innerWidth, height: innerHeight },
      key: current?.getAttribute('data-proactive-key') ?? null,
      title: current?.querySelector('strong')?.textContent?.trim() ?? null,
      activeElement: describe(document.activeElement), dismissFocused: document.activeElement === close,
      hitStack: rect ? document.elementsFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
        .slice(0, 8).map(describe) : [],
      elements: elements.map(([name, element]) => {
        if (!element) return { name, present: false }
        const style = getComputedStyle(element)
        return {
          name, bounds: bounds(element), hover: element.matches(':hover'),
          active: element.matches(':active'), transform: style.transform,
          pointerEvents: style.pointerEvents, opacity: style.opacity, visibility: style.visibility,
          position: style.position, zIndex: style.zIndex, overflow: style.overflow,
          transition: style.transition
        }
      }),
      events: window.__cforProactiveUiEvents || []
    }
  }, bubbleSelector)
  record.uiDiagnostics.push({ stage, ...snapshot })
  return snapshot
}
try {
  let authenticating = allowLogin
  // Install the guard before navigation: login is the only separately authorized non-read request.
  await context.route('**/*', async (route) => {
    const request = route.request()
    const pathname = new URL(request.url()).pathname
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      if (authenticating && allowLogin && request.method() === 'POST' &&
        /^\/(?:admin|app)-api\/system\/auth\/login-encrypted$/.test(pathname) &&
        record.authenticationRequests.length === 0) {
        record.authenticationRequests.push({ method: request.method(), path: pathname })
        await route.continue()
        return
      }
      record.blockedWrites.push({ method: request.method(), path: pathname })
      await route.abort('blockedbyclient')
      return
    }
    await route.continue()
  })
  if (storageState) {
    const origin = new URL(config.webBase).origin
    const savedOrigin = storageState.origins?.find((entry) => entry.origin === origin)
    assert.ok(savedOrigin?.localStorage?.length, 'Storage state must contain this local Web origin')
    const cookies = (storageState.cookies || []).filter((cookie) =>
      cookie.domain.replace(/^\./, '') === new URL(origin).hostname)
    await context.addCookies(cookies)
    await context.addInitScript(({ origin, entries }) => {
      if (location.origin !== origin) return
      for (const { name, value } of entries) localStorage.setItem(name, value)
    }, { origin, entries: savedOrigin.localStorage })
  } else {
    await login(page, { dumpDir: outputDir })
  }
  authenticating = false
  await openRoute(page, '/cost-management/modeling/profile', {
    readySelector: '.page-head h1'
  })
  await browserHandle.flushResponses()
  await page.locator('.global-ai-assistant .assistant-rail').waitFor({ state: 'visible' })
  await page.evaluate(() => {
    const events = []
    window.__cforProactiveUiEvents = events
    const describe = (node) => node instanceof Element ? {
      tag: node.tagName, class: node.getAttribute('class'), label: node.getAttribute('aria-label')
    } : null
    for (const type of [
      'pointerover', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click',
      'focusin', 'focusout', 'keydown', 'keyup'
    ]) {
      document.addEventListener(type, (event) => {
        if (!(event.target instanceof Element)) return
        const close = document.querySelector('.assistant-proactive-dismiss')
        const closeBounds = close?.getBoundingClientRect()
        const nearDismiss = closeBounds && Number.isFinite(event.clientX) &&
          event.clientX >= closeBounds.left - 16 && event.clientX <= closeBounds.right + 16 &&
          event.clientY >= closeBounds.top - 16 && event.clientY <= closeBounds.bottom + 16
        if (!event.target.closest('.global-ai-assistant') && !nearDismiss) return
        const current = event.target.closest('.assistant-proactive-bubble')
        const rect = event.target.getBoundingClientRect()
        const entry = {
          type, at: performance.now(), trusted: event.isTrusted, code: event.code,
          key: current?.getAttribute('data-proactive-key') ?? null,
          target: describe(event.target), path: event.composedPath().slice(0, 6).map(describe),
          isDismiss: Boolean(event.target.closest('.assistant-proactive-dismiss')),
          x: event.clientX, y: event.clientY,
          hitTarget: Number.isFinite(event.clientX)
            ? describe(document.elementFromPoint(event.clientX, event.clientY)) : null,
          bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          activeElement: describe(document.activeElement), defaultPrevented: event.defaultPrevented
        }
        events.push(entry)
        if (events.length > 400) events.shift()
        // Read after native dispatch; a capture-phase microtask may run before target listeners.
        setTimeout(() => {
          entry.defaultPrevented = event.defaultPrevented
          entry.dispatchObserved = true
        }, 0)
      }, { capture: true, passive: true })
    }
  })
  const bubble = page.locator(bubbleSelector)
  const dismiss = bubble.getByRole('button', { name: '关闭当前提示', exact: true })
  const mutedState = () => page.evaluate(() => Object.fromEntries(
    Object.entries(localStorage).filter(([key]) => key.startsWith('cfor:global-ai-assistant:proactive-muted:'))
  ))
  const mutedBefore = await mutedState()
  const dismissVisible = async (method = 'Enter') => {
    const before = await captureUiState(`before-${method}`)
    assert.ok(before.key, 'Current preview must expose its exact local identity')
    const startedAt = Date.now()
    try {
      if (method === 'click') {
        await dismiss.click({ timeout: 1500 })
      } else {
        await dismiss.focus({ timeout: 1500 })
        const focused = await captureUiState(`focused-${method}`)
        assert.equal(focused.dismissFocused, true, 'Keyboard focus did not reach the dismiss button')
        assert.equal(focused.key, before.key, 'Current preview changed before keyboard activation')
        await page.keyboard.press(method)
      }
      // Require a trusted close-button click and prompt removal, not the five-second auto rotation.
      await page.waitForFunction(({ bubbleSelector, key, at }) => {
        const current = document.querySelector(bubbleSelector)
        const clicked = window.__cforProactiveUiEvents.some((event) =>
          event.at >= at && event.type === 'click' && event.isDismiss && event.trusted &&
          event.dispatchObserved &&
          event.key === key
        )
        return clicked && current?.getAttribute('data-proactive-key') !== key
      }, { bubbleSelector, key: before.key, at: before.at }, { timeout: 1000 })
      const after = await captureUiState(`after-${method}`)
      assert.ok(Date.now() - startedAt < 2500, 'Dismiss must finish before the auto-hide delay')
      if (method !== 'click') {
        const keydown = after.events.find((event) =>
          event.at >= before.at && event.type === 'keydown' && event.key === before.key &&
          event.code === (method === 'Space' ? 'Space' : method)
        )
        assert.ok(keydown, 'Missing trusted keyboard event on the current dismiss button')
        assert.equal(keydown.trusted, true)
        assert.equal(keydown.defaultPrevented, false, 'Tooltip cancelled native button activation')
      }
      assert.equal(await page.locator('.assistant-drawer').isVisible(), false,
        'Dismiss unexpectedly opened assistant')
      record.interactions.push({
        method, key: before.key, nextKey: after.key, elapsedMs: Date.now() - startedAt
      })
      return after
    } catch (error) {
      await captureUiState(`failed-${method}`).catch(() => {})
      throw error
    }
  }
  // Drain only visible local previews. No message action, read receipt or mute control is used.
  for (let index = 0; index < 20 && await bubble.isVisible(); index++) {
    record.observedPreviews.push({ stage: 'existing-before', index, text: await bubble.innerText() })
    await dismissVisible()
    record.observedPreviews.push({ stage: 'existing-after', index,
      text: await bubble.isVisible() ? await bubble.innerText() : null })
  }
  assert.equal(await bubble.isVisible(), false, 'Existing local previews did not settle')
  for (const viewport of [
    { width: 1600, height: 900 }, { width: 1280, height: 720 }, { width: 390, height: 844 }
  ]) {
    await page.setViewportSize(viewport)
    const nonce = randomUUID()
    const titles = [`CFOR preview A ${nonce}`, `CFOR preview B ${nonce}`]
    await page.evaluate((titles) => {
      for (const title of titles) window.dispatchEvent(new CustomEvent('global-ai-proactive', {
        detail: { title, content: 'Local component verification only.', dedupeKey: title, kind: 'notice' }
      }))
    }, titles)
    await page.waitForFunction((titles) => titles.every((title) =>
      Object.entries(localStorage).some(([key, value]) =>
        key.startsWith('cfor:global-ai-assistant:seen:') && JSON.parse(value).includes(title))
    ), titles)
    await page.waitForTimeout(500)
    const firstTitle = bubble.locator('.assistant-proactive-copy strong').filter({ hasText: titles[0] })
    for (let index = 0; index < 20; index++) {
      await bubble.waitFor({ state: 'visible' })
      record.observedPreviews.push(await bubble.innerText())
      if (await firstTitle.isVisible()) break
      await dismissVisible()
    }
    await firstTitle.waitFor({ state: 'visible' })
    assert.equal(await bubble.getAttribute('data-proactive-key'), titles[0])
    assert.equal(await page.locator('button button').count(), 0, 'Nested interactive buttons')
    const bounds = await dismiss.boundingBox()
    assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 &&
      bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height,
    'Dismiss button is clipped outside viewport')
    record.checks.push({ name: `visible-control-${viewport.width}`, passed: true, bounds })
    await saveScreenshot(page, outputDir, `proactive-before-${viewport.width}`, record)
    await dismissVisible('click')
    await bubble.locator('.assistant-proactive-copy strong').filter({ hasText: titles[1] })
      .waitFor({ state: 'visible', timeout: 1000 })
    assert.equal(await bubble.getAttribute('data-proactive-key'), titles[1],
      'Closing the first message must preserve the second queued message')
    const secondDismissed = await dismissVisible('Enter')
    assert.notEqual(secondDismissed.key, titles[1])
    assert.equal(await bubble.isVisible(), false, 'A second local preview was not dismissed')
    const spaceTitle = `CFOR preview Space ${nonce}`
    await page.evaluate((title) => window.dispatchEvent(new CustomEvent('global-ai-proactive', {
      detail: { title, content: 'Native Space activation.', dedupeKey: title, kind: 'notice' }
    })), spaceTitle)
    await bubble.locator('strong').filter({ hasText: spaceTitle })
      .waitFor({ state: 'visible', timeout: 1000 })
    assert.equal(await bubble.getAttribute('data-proactive-key'), spaceTitle)
    await dismissVisible('Space')
    assert.equal(await bubble.isVisible(), false, 'Space did not dismiss the last preview')
    assert.deepEqual(await mutedState(), mutedBefore, 'Dismiss changed persistent mute preference')
    await saveScreenshot(page, outputDir, `proactive-dismissed-${viewport.width}`, record)
    record.checks.push({ name: `current-only-keyboard-dismiss-${viewport.width}`, passed: true })
  }
  await browserHandle.flushResponses()
  assert.deepEqual(record.blockedWrites, [], 'Component attempted a business write')
  for (const key of ['consoleErrors', 'pageErrors', 'failedApiResponses', 'requestFailures']) {
    assert.deepEqual(record[key], [], `Unexpected ${key}`)
  }
  record.status = 'VERIFIED_COMPONENT_ONLY'
} catch (error) {
  record.status = 'FAILED_COMPONENT'
  record.error = error
  await captureUiState('failure').catch(() => {})
  await saveScreenshot(page, outputDir, 'proactive-failure', record).catch(() => {})
  process.exitCode = 1
} finally {
  await browserHandle.browser.close()
  record.finishedAt = new Date().toISOString()
  const reportPath = path.join(outputDir, 'ui-report.json')
  atomicWriteFile(reportPath, `${JSON.stringify(reportSnapshot(record), null, 2)}\n`)
  console.log(JSON.stringify({ status: record.status, reportPath, checks: record.checks.length,
    blockedWrites: record.blockedWrites.length }))
}
