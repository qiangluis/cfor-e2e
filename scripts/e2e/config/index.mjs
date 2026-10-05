import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const explicitEnv = new Set(Object.keys(process.env))
const localEnv = new Set()

function loadEnvFile (file, local = false) {
  if (!fs.existsSync(file)) return
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const text = line.trim()
    if (!text || text.startsWith('#') || !text.includes('=')) continue
    const separator = text.indexOf('=')
    const key = text.slice(0, separator).trim()
    const value = text.slice(separator + 1).trim()
    if (local) localEnv.add(key)
    if (!(key in process.env)) process.env[key] = value
  }
}

loadEnvFile(path.join(here, 'local.env'), true)
// Ignore legacy scripts/e2e/.env files. Local acceptance must be explicit and
// must not inherit stale production or alternate-port endpoints.

const env = (key, fallback = '') => String(process.env[key] ?? fallback).trim()
const envAlias = (keys, fallback, localOnly = false) => {
  const explicit = keys.find((key) => explicitEnv.has(key) && env(key))
  const configured = keys.find((key) => (!localOnly || localEnv.has(key)) && env(key))
  return explicit ? env(explicit) : configured ? env(configured) : fallback
}
const number = (key, fallback) => {
  const value = env(key)
  if (!value) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}
const bool = (value, fallback) => {
  if (value === undefined || value === '') return fallback
  return ['1', 'true', 'yes'].includes(String(value).toLowerCase())
}
const trimSlash = (value) => String(value).replace(/\/+$/, '')
const normalizeApiBase = (value) => trimSlash(value).replace(/\/admin-api$/, '')

// Legacy environment files must never select production implicitly.
const target = explicitEnv.has('CFOR_TARGET') ? env('CFOR_TARGET', 'local') : 'local'
const webBase = trimSlash(
  target === 'local'
    ? envAlias(['CFOR_WEB_BASE', 'CFOR_WEB_URL'], 'http://127.0.0.1:9151', true)
    : envAlias(['CFOR_WEB_BASE', 'CFOR_BASE_URL'], 'https://jixu-ai.com')
)
const apiBase = normalizeApiBase(
  target === 'local'
    ? envAlias(['CFOR_API_BASE', 'CFOR_LOCAL_API_URL'], 'http://127.0.0.1:48083', true)
    : envAlias(['CFOR_API_BASE', 'CFOR_BASE_URL'], 'https://jixu-ai.com')
)
if (target === 'local') {
  for (const [label, base, port] of [['web', webBase, '9151'], ['api', apiBase, '48083']]) {
    const url = new URL(base)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.port !== port) {
      throw new Error(`Local ${label} must use a loopback address on port ${port}`)
    }
  }
}

export const config = Object.freeze({
  target,
  webBase,
  webUrl: webBase,
  apiBase,
  apiUrl: `${apiBase}${env('CFOR_API_PREFIX', '/admin-api')}`,
  apiHealthUrl: env('CFOR_API_HEALTH_URL', target === 'local' ? `${apiBase}/actuator/health` : ''),
  tenantId: env('CFOR_TENANT_ID', ''),
  tenantName: env('CFOR_TENANT_NAME', env('CFOR_TENANT', 'CFOR 标准平台')),
  tenant: env('CFOR_TENANT_NAME', env('CFOR_TENANT', 'CFOR 标准平台')),
  username: env('CFOR_USERNAME', env('CFOR_USER', 'admin')),
  password: env('CFOR_PASSWORD', env('CFOR_PASS', '')),
  purchaseApproverUsername: env('CFOR_PURCHASE_APPROVER_USERNAME', 'purmgr01'),
  purchaseApproverPassword: env('CFOR_PURCHASE_APPROVER_PASSWORD', ''),
  financeApproverUsername: env('CFOR_FINANCE_APPROVER_USERNAME', 'finrvw01'),
  financeApproverPassword: env('CFOR_FINANCE_APPROVER_PASSWORD', ''),
  finalApproverUsername: env('CFOR_FINAL_APPROVER_USERNAME', 'opsmgr01'),
  finalApproverPassword: env('CFOR_FINAL_APPROVER_PASSWORD', ''),
  registerTenantName: env('CFOR_REGISTER_TENANT_NAME', env('CFOR_TENANT_NAME', 'CFOR 标准平台')),
  registerContactName: env('CFOR_REGISTER_CONTACT_NAME', ''),
  registerEmail: env('CFOR_REGISTER_EMAIL', ''),
  registerPassword: env('CFOR_REGISTER_PASSWORD', ''),
  registerEmailCode: env('CFOR_REGISTER_EMAIL_CODE', ''),
  fmsAccountSetId: env('CFOR_FMS_ACCOUNT_SET_ID', ''),
  chromePath: env('CFOR_CHROME_PATH', ''),
  headless: bool(process.env.CFOR_HEADLESS ?? process.env.CFOR_E2E_HEADLESS, true),
  reuseSession: bool(process.env.CFOR_REUSE_SESSION, true),
  evidenceDir: env('CFOR_EVIDENCE_DIR', env('CFOR_E2E_OUT', '/tmp/cfor-e2e')),
  outputRoot: env('CFOR_E2E_OUT', env('CFOR_EVIDENCE_DIR', '/tmp/cfor-e2e')),
  requestTimeoutMs: number('CFOR_E2E_REQUEST_TIMEOUT_MS', 30000),
  browserTimeoutMs: number('CFOR_E2E_BROWSER_TIMEOUT_MS', 60000),
  db: {
    host: env('CFOR_DB_HOST', ''),
    port: env('CFOR_DB_PORT', '3306'),
    name: env('CFOR_DB_NAME', 'cfor_admin_standard'),
    user: env('CFOR_DB_USER', ''),
    password: env('CFOR_DB_PASSWORD', '')
  }
})

export const environmentSummary = () => ({
  target: config.target,
  webBase: config.webBase,
  apiBase: config.apiUrl,
  apiHealthUrl: config.apiHealthUrl || 'not-configured',
  tenantId: config.tenantId || 'resolved-after-login',
  tenantName: config.tenantName,
  username: config.username,
  purchaseApproverUsername: config.purchaseApproverUsername,
  financeApproverUsername: config.financeApproverUsername,
  finalApproverUsername: config.finalApproverUsername,
  registerTenantName: config.registerTenantName,
  fmsAccountSetId: config.fmsAccountSetId || 'from-env',
  dbName: config.db.name
})

export function resolveChromePath () {
  if (config.chromePath) return config.chromePath
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/opt/meta-chromium/chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium'
  ]
  for (const p of candidates) if (fs.existsSync(p)) return p
  throw new Error('找不到 Chrome：请设置 CFOR_CHROME_PATH 指向本机 Chrome 可执行文件')
}
