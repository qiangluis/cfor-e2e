// e2e 全局配置：全部来自环境变量（支持 scripts/e2e/.env），无硬编码密钥。
// 约定（已在 .env.example 中说明）：
//   CFOR_TARGET=online 时，浏览器与 API 都走 CFOR_BASE_URL + CFOR_API_PREFIX；
//   CFOR_TARGET=local  时，浏览器走 CFOR_WEB_URL，API 走 CFOR_LOCAL_API_URL。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

function loadDotEnv () {
  // .env 查找顺序（都不覆盖已存在的真实环境变量）：
  //   1. scripts/e2e/.env（README 文档的标准位置）
  //   2. scripts/e2e/config/.env（兼容旧位置）
  const candidates = [
    path.join(here, '..', '.env'),
    path.join(here, '.env')
  ]
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const t = line.trim()
      if (!t || t.startsWith('#') || !t.includes('=')) continue
      const i = t.indexOf('=')
      const k = t.slice(0, i).trim()
      if (!(k in process.env)) process.env[k] = t.slice(i + 1).trim()
    }
  }
}
loadDotEnv()

const env = (k, d = '') => (process.env[k] ?? d).trim()
const bool = (k, d) => {
  const v = (process.env[k] ?? '').trim().toLowerCase()
  if (!v) return d
  return ['1', 'true', 'yes'].includes(v)
}

const target = () => env('CFOR_TARGET', 'online')
const baseUrl = () => env('CFOR_BASE_URL', 'https://jixu-ai.com').replace(/\/$/, '')
const apiPrefix = () => env('CFOR_API_PREFIX', '/admin-api')

function buildConfig () {
  const t = target()
  const b = baseUrl()
  return {
    target: t,
    // 浏览器打开的站点根地址
    webUrl: t === 'local' ? env('CFOR_WEB_URL', 'http://127.0.0.1:9160').replace(/\/$/, '') : b,
    // API 根地址（已含 /admin-api 前缀；lib/api.mjs 不再自行拼接，避免重复）
    apiUrl: t === 'local'
      ? env('CFOR_LOCAL_API_URL', 'http://127.0.0.1:48083/admin-api').replace(/\/$/, '')
      : b + apiPrefix(),
    tenant: env('CFOR_TENANT', '福奇科技'),
    username: env('CFOR_USER', 'admin'),
    get password () {
      const p = env('CFOR_PASS', '')
      if (!p) throw new Error('缺少 CFOR_PASS：请在环境变量或 scripts/e2e/.env 中设置登录密码')
      return p
    },
    headless: bool('CFOR_HEADLESS', true),
    chromePath: env('CFOR_CHROME_PATH', ''),
    evidenceDir: env('CFOR_EVIDENCE_DIR', '/tmp/cfor-e2e'),
    // 是否复用一次登录（默认开；--no-reuse-session 可关）
    reuseSession: bool('CFOR_REUSE_SESSION', true)
  }
}

// 懒加载：每次访问都重新读环境变量。
// runner 解析 --headless/--no-headless 等参数时才写 process.env，
// 而 import 是 hoist 先执行的；不用懒加载这些 CLI 开关永远不生效。
export const config = new Proxy({}, {
  get (_t, prop) { return buildConfig()[prop] }
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
