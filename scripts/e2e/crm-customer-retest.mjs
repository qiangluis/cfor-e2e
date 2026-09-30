// CRM 客户：补测 BLOCKED 的 API-002/006/007 + 清理残留测试客户
// 用法：CFOR_PASS=xxx node scripts/e2e/crm-customer-retest.mjs
import { encryptRequest, decryptResponse, ENCRYPT_HEADER } from './lib/crypto.mjs'

const API = 'https://jixu-ai.com/admin-api'
const PASS = process.env.CFOR_PASS
if (!PASS) { console.error('需要 CFOR_PASS'); process.exit(1) }

let TOKEN = ''
function parseBody (text, res) {
  const h = res.headers.get(ENCRYPT_HEADER) ?? res.headers.get(ENCRYPT_HEADER.toLowerCase())
  if (h === 'true' && text) { try { return decryptResponse(text) } catch {} }
  try { return JSON.parse(text) } catch { return text }
}
async function req (method, path, data, { encrypt = false } = {}) {
  const headers = { Authorization: 'Bearer ' + TOKEN, 'tenant-id': '1' }
  let body
  if (data !== undefined) {
    body = encrypt ? encryptRequest(data) : JSON.stringify(data)
    headers['Content-Type'] = 'application/json'
    if (encrypt) headers[ENCRYPT_HEADER] = 'true'
  }
  const r = await fetch(API + path, { method, headers, body })
  return { status: r.status, body: parseBody(await r.text(), r) }
}
async function login () {
  const pre = await req('POST', '/system/auth/tenant-options-encrypted',
    { tenantName: '福奇科技', username: 'admin', password: PASS }, { encrypt: true })
  const ticket = pre.body?.data?.selectionTicket
  if (!ticket) throw new Error('拿不到 selectionTicket：' + JSON.stringify(pre.body).slice(0, 200))
  await req('POST', '/system/auth/login-encrypted',
    { tenantName: '福奇科技', username: 'admin', password: PASS, captchaVerification: '', rememberMe: true }, { encrypt: true })
  const sel = await req('POST', '/system/auth/login-tenant-selection', { selectionTicket: ticket, tenantId: 1 })
  TOKEN = sel.body?.data?.token || sel.body?.data?.accessToken || ''
  if (!TOKEN) throw new Error('登录失败')
  console.log('[登录] ok tenantId =', sel.body?.data?.tenantId)
}
const ok = (r) => r.status === 200 && (r.body?.code === 0 || r.body?.code === '0')
const stamp = () => Date.now().toString(36).slice(-6)
const results = []
function step (id, name, pass, detail) {
  results.push({ id, name, pass, detail })
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${id} ${name} — ${detail}`)
}

await login()

// ---------- API-002：负面断言 ----------
{
  const r1 = await req('POST', '/crm/customer/create', {})
  step('API-002a', '缺名称创建被拒绝', !ok(r1), `status=${r1.status} code=${r1.body?.code} msg=${(r1.body?.msg || '').slice(0, 80)}`)
  const r2 = await req('POST', '/crm/customer/create', { name: '测试客户Neg' + stamp() })
  const refused = !ok(r2)
  step('API-002b', '缺负责人创建行为记录', true, refused ? `拒绝 code=${r2.body?.code} msg=${(r2.body?.msg || '').slice(0, 80)}` : `放行 id=${r2.body?.data?.id}`)
  if (!refused && r2.body?.data?.id) await req('DELETE', `/crm/customer/delete?id=${r2.body.data.id}`)
}

// ---------- API-006：锁定/解锁 ----------
{
  const c = await req('POST', '/crm/customer/create', { name: '测试客户Lock' + stamp() })
  const id = c.body?.data?.id
  step('API-006前置', '创建待锁定客户', ok(c), `id=${id}`)
  if (id) {
    const l = await req('PUT', '/crm/customer/lock', { id, lockStatus: 1 })
    step('API-006a', '锁定成功', ok(l), `code=${l.body?.code} msg=${(l.body?.msg || '').slice(0, 60)}`)
    const g1 = await req('GET', `/crm/customer/get?id=${id}`)
    step('API-006b', '锁定后回读状态', ok(g1), `lockStatus=${g1.body?.data?.lockStatus}`)
    const u = await req('PUT', '/crm/customer/lock', { id, lockStatus: 0 })
    step('API-006c', '解锁成功', ok(u), `code=${u.body?.code}`)
    const d = await req('DELETE', `/crm/customer/delete?id=${id}`)
    step('API-006清理', '删除锁定测试客户', ok(d), `code=${d.body?.code}`)
  }
}

// ---------- API-007：删除 ----------
{
  const c = await req('POST', '/crm/customer/create', { name: '测试客户Del' + stamp() })
  const id = c.body?.data?.id
  step('API-007前置', '创建待删除客户', ok(c), `id=${id}`)
  if (id) {
    const d = await req('DELETE', `/crm/customer/delete?id=${id}`)
    step('API-007a', '删除成功', ok(d), `code=${d.body?.code}`)
    const g = await req('GET', `/crm/customer/get?id=${id}`)
    step('API-007b', '删除后查不到', !ok(g) || !g.body?.data, `code=${g.body?.code}`)
  }
  const d2 = await req('DELETE', '/crm/customer/delete?id=999999999999999999')
  step('API-007c', '删除不存在 id 合理报错', !ok(d2), `status=${d2.status} code=${d2.body?.code} msg=${(d2.body?.msg || '').slice(0, 80)}`)
}

// ---------- 清理残留测试客户 ----------
{
  const p = await req('GET', '/crm/customer/page?pageNo=1&pageSize=100&name=' + encodeURIComponent('测试客户'))
  const list = p.body?.data?.list ?? []
  console.log(`[清理] 搜到 ${list.length} 个"测试客户"（total=${p.body?.data?.total}）`)
  let n = 0
  for (const it of list) {
    const d = await req('DELETE', `/crm/customer/delete?id=${it.id}`)
    if (ok(d)) n++
    else console.log(`[清理] 删除失败 id=${it.id} name=${it.name} code=${d.body?.code} msg=${(d.body?.msg || '').slice(0, 60)}`)
  }
  const p2 = await req('GET', '/crm/customer/page?pageNo=1&pageSize=100&name=' + encodeURIComponent('测试客户'))
  const left = (p2.body?.data?.list ?? []).length
  step('CLEANUP', '残留测试客户清理', left === 0, `删除 ${n} 个，剩余 ${left} 个`)
}

const failed = results.filter((r) => !r.pass)
console.log(`\n==== 结果：${results.length - failed.length}/${results.length} 通过 ====`)
if (failed.length) process.exitCode = 1
