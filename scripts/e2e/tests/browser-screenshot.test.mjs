import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { saveScreenshot } from '../lib/browser.mjs'

test('saveScreenshot falls back to a viewport artifact when full-page capture times out', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfor-e2e-screenshot-'))
  const calls = []
  const page = {
    async screenshot (options) {
      calls.push(options)
      if (calls.length === 1) throw new Error('page.screenshot: Timeout 15000ms exceeded')
      fs.writeFileSync(options.path, 'png')
    }
  }
  const record = { screenshots: [], notes: [] }
  try {
    const result = await saveScreenshot(page, outputDir, 'mes-prod', record)
    assert.match(result, /mes-prod-viewport\.png$/)
    assert.equal(calls.length, 2)
    assert.equal(calls[0].fullPage, true)
    assert.equal(calls[1].fullPage, false)
    assert.deepEqual(record.screenshots, [result])
    assert.match(record.notes[0], /降级为视口截图/)
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true })
  }
})
