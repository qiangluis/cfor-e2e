// 引导中心首次初始化（API 直调版）
// 流程对齐前端 Dt()：保存企业组织资料 → 保存引导状态 → 应用首轮预置
// 用法：CFOR_PASS=xxx node scripts/e2e/init-guide.mjs all
import { encryptRequest, decryptResponse, ENCRYPT_HEADER } from './lib/crypto.mjs'
import { readFileSync } from 'node:fs'

const API = 'https://jixu-ai.com/admin-api'
const PASS = process.env.CFOR_PASS
if (!PASS) { console.error('需要 CFOR_PASS'); process.exit(1) }
const mode = process.argv[2] || 'probe'

const LOGO_URL = 'https://assets.jixu-ai.com/20260929/logo-placeholder_1790671906242.png'
// 与浏览器任务在页面上填写的值保持一致
const ORG = {
  enterpriseFullName: '福奇科技有限公司',
  enterpriseShortName: '福奇科技',
  enterpriseType: '生产型',
  unifiedSocialCreditCode: '91350100MA2YK3L4X9',
  taxpayerQualification: '一般纳税人',
  industryCategory: '制造业',
  industrySubCategory: '计算机、通信和其他电子设备制造业',
  province: '广东省', provinceCode: 440000,
  city: '深圳市', cityCode: 440300,
  district: '南山区', districtCode: 440305,
  registeredAddress: '广东省深圳市南山区科苑路15号测试楼101室',
  enterpriseLogoUrl: LOGO_URL
}
const MODULES = ['system', 'bpm', 'erp', 'wms', 'mes', 'quality', 'fms', 'cost', 'crm', 'hrm', 'pms', 'plm', 'iot', 'integration']
const INDUSTRY_TEMPLATE = 'electronics_pcb'

let TOKEN = ''

function parseBody (text, res) {
  const h = res.headers.get(ENCRYPT_HEADER) ?? res.headers.get(ENCRYPT_HEADER.toLowerCase())
  if (h === 'true' && text) { try { return decryptResponse(text) } catch {} }
  try { return JSON.parse(text) } catch { return text }
}

async function req (method, path, data, { encrypt = false, form = null } = {}) {
  const headers = { Authorization: 'Bearer ' + TOKEN, 'tenant-id': '1' }
  let body
  if (form) body = form
  else if (data !== undefined) {
    body = encrypt ? encryptRequest(data) : JSON.stringify(data)
    headers['Content-Type'] = 'application/json'
    if (encrypt) headers[ENCRYPT_HEADER] = 'true'
  }
  const r = await fetch(API + path, { method, headers, body })
  return { status: r.status, body: parseBody(await r.text(), r) }
}

async function login () {
  // 1) 租户预检拿 selectionTicket；2) 加密登录；3) 租户选择拿租户绑定 token
  const pre = await req('POST', '/system/auth/tenant-options-encrypted',
    { tenantName: '福奇科技', username: 'admin', password: PASS }, { encrypt: true })
  const ticket = pre.body?.data?.selectionTicket
  if (!ticket) throw new Error('拿不到 selectionTicket：' + JSON.stringify(pre.body).slice(0, 200))
  const enc = await req('POST', '/system/auth/login-encrypted',
    { tenantName: '福奇科技', username: 'admin', password: PASS, captchaVerification: '', rememberMe: true }, { encrypt: true })
  TOKEN = enc.body?.data?.accessToken
  const sel = await req('POST', '/system/auth/login-tenant-selection', { selectionTicket: ticket, tenantId: 1 })
  TOKEN = sel.body?.data?.accessToken || TOKEN
  if (!TOKEN) throw new Error('登录失败')
  console.log('[登录] ok，tenantId =', sel.body?.data?.tenantId)
}

async function uploadLogoIfNeeded () {
  // LOGO 已提前上传；这里仅做占位（URL 硬编码在顶部）
  console.log('[LOGO]', LOGO_URL)
}

async function runAll () {
  await uploadLogoIfNeeded()
  // 1. 保存企业组织资料（对齐前端 Mt）
  const org = await req('PUT', '/system/enterprise-organization/current', ORG)
  console.log('[保存企业资料]', org.status, 'code=' + org.body?.code, (org.body?.msg || '').slice(0, 120))
  if (org.body?.code !== 0) throw new Error('保存企业资料失败')
  // 2. 保存引导状态（对齐前端 saveState）
  const st = await req('PUT', '/system/system-init/state',
    { industryTemplate: INDUSTRY_TEMPLATE, selectedModules: MODULES, currentStep: 2 })
  console.log('[保存引导状态]', st.status, 'code=' + st.body?.code, (st.body?.msg || '').slice(0, 120))
  if (st.body?.code !== 0) throw new Error('保存引导状态失败')
  // 3. 应用首轮预置（对齐前端 applyPreset(modules, firstRun=true)）
  console.log('[应用预置] 开始，模块数 =', MODULES.length)
  const ap = await req('POST', '/system/system-init/preset/apply', { modules: MODULES, firstRun: true })
  console.log('[应用预置]', ap.status, 'code=' + ap.body?.code, (ap.body?.msg || '').slice(0, 200))
  const d = ap.body?.data || {}
  console.log('[预置结果] applied=' + d.applied, 'added=' + d.added, 'skipped=' + d.skipped,
    'modified=' + d.modified, 'conflicts=' + d.conflicts)
  // 4. 复查状态
  const state = await req('GET', '/system/system-init/state')
  const rd = await req('GET', '/system/system-init/readiness')
  console.log('[复查] state.status=' + state.body?.data?.status,
    'readiness=' + rd.body?.data?.progressPercent + '%',
    rd.body?.data?.requiredCompleted + '/' + rd.body?.data?.requiredTotal)
}

await login()
if (mode === 'all') { await runAll(); console.log('\n初始化流程执行完毕' ) } else { console.log('探查模式：未执行写操作') }
