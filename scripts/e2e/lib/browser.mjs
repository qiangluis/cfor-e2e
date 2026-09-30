// 浏览器层：真实 Chrome（playwright-core + 本机 Chrome）。
// 登录成功判定以页面状态为准（URL 离开 /login + 用户标识出现），
// 不解析 login-encrypted 的加密响应体——旧版直接 response.json() 取 code 是错的。
import { chromium } from 'playwright-core'
import fs from 'node:fs'
import path from 'node:path'
import { config, resolveChromePath } from '../config/index.mjs'
import { ensureDir } from './report.mjs'

// 登录页选择器。文案依据 2026-09-29 从线上 bundle 逆向出的真实值：
//   zh-CN 语言包：login.tenantNamePlaceholder="请输入租户名称"
//   login.usernamePlaceholder="请输入用户名"、login.passwordPlaceholder="请输入密码"、
//   login.login="登录"；租户校验通过提示"企业名称校验通过"。
// 页面结构：.portal-login-card 卡片内有"账密登录"/"手机号登录"页签，
// 账密表单为 Element Plus el-form，三个 el-input。
const SEL = {
  loginCard: '.portal-login-card',
  accountTab: 'button:has-text("账密登录")',
  tenantInput: [
    'input[placeholder="请输入租户名称"]',
    'input[placeholder*="租户"]',
    'input[name="tenantName"]'
  ],
  tenantValidatedTip: 'text=企业名称校验通过',
  usernameInput: [
    'input[placeholder="请输入用户名"]',
    'input[placeholder*="用户名"]',
    'input[name="username"]'
  ],
  passwordInput: [
    'input[placeholder="请输入密码"]',
    'input[name="password"]',
    'input[type="password"]'
  ],
  // 注意："账密登录"页签按钮也含"登录"二字，必须精确匹配
  loginButton: [
    '.portal-login-card button.el-button:has-text("登录")',
    'button:has-text("登录")'
  ],
  // 登录成功后页面上必有的用户标识（任一命中即算成功）
  loggedInMarkers: [
    '.avatar', '.user-info', '[class*="user"]',
    'text=工作台'
  ]
}

async function firstVisible (page, candidates, timeout = 8000) {
  for (const sel of candidates) {
    const loc = page.locator(sel).first()
    try {
      await loc.waitFor({ state: 'visible', timeout })
      return loc
    } catch { /* 试下一个 */ }
  }
  throw new Error(`找不到可见元素，候选：${candidates.join(' / ')}`)
}

/**
 * 登录失败时的现场导出：把登录卡片区的 HTML 落盘，方便离线分析选择器失效原因。
 * @returns 导出的文件路径（失败返回 null）
 */
export async function dumpLoginDom (page, dumpDir, tag = 'login') {
  if (!dumpDir) return null
  try {
    ensureDir(dumpDir)
    const card = await page.locator(SEL.loginCard).first().innerHTML().catch(() => '')
    const html = card || await page.content().catch(() => '')
    const file = path.join(dumpDir, `${tag}-dom.html`)
    fs.writeFileSync(file, html)
    return file
  } catch { return null }
}

export async function launchBrowser () {
  // 沙箱出站走代理：Chromium 默认不读 *_proxy 环境变量，必须显式传；
  // 且带认证的代理要把 username/password 拆出来单独传（URL 内嵌认证 Chromium 可能不认）
  const rawProxy = process.env.https_proxy || process.env.HTTPS_PROXY ||
    process.env.http_proxy || process.env.HTTP_PROXY
  let proxy
  if (rawProxy) {
    try {
      const u = new URL(rawProxy)
      proxy = {
        server: `${u.protocol}//${u.host}`,
        ...(u.username ? { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) } : {})
      }
    } catch { proxy = { server: rawProxy } }
  }
  return chromium.launch({
    headless: config.headless,
    executablePath: resolveChromePath(),
    proxy,
    args: ['--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check']
  })
}

export function watchApiFailures (page) {
  const failures = []
  page.on('response', (resp) => {
    const url = resp.url()
    if (!url.includes('/admin-api/')) return
    if (resp.status() >= 400) failures.push(`${resp.status()} ${url}`)
  })
  return failures
}

async function readToken (page) {
  return page.evaluate(() => {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      try {
        const v = JSON.parse(localStorage.getItem(k))
        if (v && typeof v === 'object' && (v.token || v.accessToken)) return v.token || v.accessToken
      } catch { /* 非 JSON，跳过 */ }
    }
    return localStorage.getItem('token') || localStorage.getItem('accessToken') || ''
  })
}

/**
 * 尝试从 storageState 恢复登录态：直接进 /index，能看到已登录标识且 token 存在即算恢复成功。
 * @returns {{token: string} | null}
 */
export async function restoreSession (page, ctx) {
  await page.goto(`${config.webUrl}/index`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {})
  if (page.url().includes('/login')) return null
  for (const sel of SEL.loggedInMarkers) {
    try {
      await page.locator(sel).first().waitFor({ state: 'visible', timeout: 5000 })
      const token = await readToken(page)
      if (token) {
        const { createApiClient } = await import('./api.mjs')
        ctx.token = token
        ctx.api = createApiClient({ token })
        return { token }
      }
    } catch { /* 试下一个 */ }
  }
  return null
}

/**
 * 真实登录。流程：等登录卡片渲染 → 切"账密登录"页签 → 租户名 → 触发校验 →
 * 用户名/密码 → 登录 → 等页面状态。
 * @returns {{ token: string, failures: string[] }}
 */
export async function login (page, { check, dumpDir } = {}) {
  try {
  const failures = watchApiFailures(page)
  await page.goto(`${config.webUrl}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {})

  // 0. 等登录卡片真正渲染出来（冷加载时 chunk 较多，表单可能还没挂载）
  await page.locator(SEL.loginCard).first().waitFor({ state: 'visible', timeout: 60000 })
  // 切到"账密登录"页签（若默认不是它）
  const tab = page.locator(SEL.accountTab).first()
  if (await tab.isVisible().catch(() => false)) {
    const cls = await tab.getAttribute('class').catch(() => '')
    if (!cls || !cls.includes('active')) await tab.click().catch(() => {})
  }

  // 1. 租户名（多步登录的第一步：先校验租户）
  const tenantInput = await firstVisible(page, SEL.tenantInput, 30000)
  await tenantInput.fill(config.tenant)
  await tenantInput.press('Tab')
  // 等租户校验完成：出现"企业名称校验通过"（非致命，超时则继续）
  await page.locator(SEL.tenantValidatedTip).first()
    .waitFor({ state: 'visible', timeout: 10000 }).catch(() => {})

  // 2. 用户名 + 密码
  const userInput = await firstVisible(page, SEL.usernameInput, 30000)
  await userInput.fill(config.username)
  const passInput = await firstVisible(page, SEL.passwordInput, 30000)
  await passInput.fill(config.password)

  // 3. 提交：只把 login-encrypted 响应当"请求已发出"的信号，不解析加密体
  const loginResp = page.waitForResponse(
    (r) => r.url().includes('/system/auth/login-encrypted') && r.request().method() === 'POST',
    { timeout: 30000 }
  ).catch(() => null)
  const loginBtn = await firstVisible(page, SEL.loginButton, 30000)
  await loginBtn.click()
  await loginResp

  // 4. 成功判定：URL 离开 /login，且出现任一已登录标识
  await page.waitForURL((url) => !url.href.includes('/login'), { timeout: 30000 })
  let markerOk = false
  for (const sel of SEL.loggedInMarkers) {
    try {
      await page.locator(sel).first().waitFor({ state: 'visible', timeout: 5000 })
      markerOk = true
      break
    } catch { /* 试下一个 */ }
  }
  check?.step('page', '登录后离开 /login', true, page.url())
  check?.step('page', '已登录标识可见', markerOk)

  const token = await readToken(page)
  check?.step('page', '本地 token 已写入', !!token)
  return { token, failures }
  } catch (e) {
    // 登录挂掉时自动导出登录区 DOM，下次不用靠猜
    const f = await dumpLoginDom(page, dumpDir, 'login')
    throw new Error(`${e.message}${f ? `（已导出登录区 DOM：${f}）` : ''}`)
  }
}

export async function openRoute (page, routePath, { check } = {}) {
  const failures = watchApiFailures(page)
  await page.goto(`${config.webUrl}${routePath}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {})
  return { failures }
}

export async function tableRows (page, selector = 'table tbody tr, .el-table__body tbody tr') {
  return page.locator(selector).count()
}

export async function saveScreenshot (page, shotDir, name) {
  ensureDir(shotDir)
  const file = path.join(shotDir, `${name}.png`)
  await page.screenshot({ path: file, fullPage: false })
  return file
}

/** 页面正文是否包含任一关键词（用于菜单/标题断言） */
export async function bodyContainsAny (page, keywords) {
  const text = await page.locator('body').innerText()
  return keywords.filter((k) => text.includes(k))
}
