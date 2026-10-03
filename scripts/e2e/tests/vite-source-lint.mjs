import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = process.env.CFOR_WEB_ROOT ||
  path.resolve(here, '../../../../cfor/cfor-admin-vue3')
const require = createRequire(path.join(root, 'package.json'))
const { ESLint } = require('eslint')
const loadFormatter = ESLint.prototype.loadFormatter
const vitePackageFile = require.resolve('vite/package.json')
const vitePackage = JSON.parse(fs.readFileSync(vitePackageFile, 'utf8'))
const viteImport = vitePackage.exports['.'].import
const viteEntry = typeof viteImport === 'string' ? viteImport : viteImport.default
const { loadConfigFromFile } = await import(
  pathToFileURL(path.resolve(path.dirname(vitePackageFile), viteEntry)).href
)
const originalCwd = process.cwd()
const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'cfor-source-lint-cache-'))
const fixtures = fs.mkdtempSync(path.join(root, 'src/e2e-source-lint-'))
const file = path.join(fixtures, 'AcceptanceProbe.vue')
const context = {
  error (message) {
    assert.equal(typeof message, 'string')
    throw new Error(message)
  },
  warn (message) { assert.equal(typeof message, 'string') }
}

try {
  // Formatters may be asynchronous; diagnostics must still receive text.
  ESLint.prototype.loadFormatter = async function (...args) {
    const formatter = await loadFormatter.apply(this, args)
    return { ...formatter, format: async (...values) => formatter.format(...values) }
  }
  process.chdir(root)
  const loaded = await loadConfigFromFile({ command: 'serve', mode: 'env.local' })
  const plugin = loaded.config.plugins.flat(Infinity).find((item) => item?.name === 'cfor:source-lint')
  assert.ok(plugin, 'source lint plugin must be enabled in development')
  await plugin.configResolved({ root: path.join(root, 'supplier'), envDir: root, cacheDir: cache })
  assert.equal(await plugin.transform.call(context, '', `${file}?vue&type=style`), null)
  fs.writeFileSync(file, '<template>\n  <div>Acceptance</div>\n</template>\n')
  await plugin.transform.call(context, '', file)
  await plugin.transform.call(context, '', file)
  assert.ok(fs.existsSync(path.join(cache, '.eslintcache')))
  fs.writeFileSync(file, '<script setup lang="ts">\nconst broken =\n</script>\n')
  await assert.rejects(plugin.transform.call(context, '', file), /Parsing error/)
  fs.writeFileSync(file, '<template>\n  <div>Acceptance</div>\n</template>\n')
  await plugin.transform.call(context, '', file)
  const build = await loadConfigFromFile({ command: 'build', mode: 'env.local' })
  assert.equal(build.config.plugins.flat(Infinity).some((item) => item?.name === 'cfor:source-lint'), false)
  console.log('PASS: source cache, async diagnostics, generated-module skip, changed-source error, recovery and build scope')
} finally {
  ESLint.prototype.loadFormatter = loadFormatter
  process.chdir(originalCwd)
  fs.rmSync(fixtures, { recursive: true, force: true })
  fs.rmSync(cache, { recursive: true, force: true })
}
