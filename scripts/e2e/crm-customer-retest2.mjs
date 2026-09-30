// 续跑：API-006/007 带负责人 + 调查 G 客户删不掉的原因
// 用法：CFOR_PASS=xxx node scripts/e2e/crm-customer-retest2.mjs
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
  await req('POST', '/system/auth/login-encrypted',
    { tenantName: '福奇科技', username: 'admin', password: PASS, captchaVerification: '', rememberMe: true }, { encrypt: true })
  const sel = await req('POST', '/system/auth/login-tenant-selection', { selectionTicket: ticket, tenantId: 1 })
  TOKEN = sel.body?.data?.token || sel.body?.data?.accessToken || ''
  if (!TOKEN) throw new Error('登录失败')
}
const ok = (r) => r.status === 200 && (r.body?.code === 0 || r.body?.code === '0')
// 注意：/crm/customer/create 成功时 data 直接就是 id（数字），不是对象
const newId = (r) => (typeof r.body?.data === 'number' ? r.body.data : r.body?.data?.id)
const stamp = () => Date.now().toString(36).slice(-6)
function step (id, name, pass, detail) {
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${id} ${name} — ${detail}`)
  if (!pass) process.exitCode = 1
}

await login()
const me = await req('GET', '/system/auth/get-permission-info')
const uid = me.body?.data?.user?.id
console.log('[当前用户] id =', uid)
if (!uid) throw new Error('拿不到当前用户 id')

// ---------- API-006：锁定/解锁（带负责人） ----------
{
  const c = await req('POST', '/crm/customer/create', { name: '测试客户Lock' + stamp(), ownerUserId: uid })
  const id = newId(c)
  step('API-006前置', '创建待锁定客户', ok(c), `id=${id} code=${c.body?.code}`)
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

// ---------- API-007：删除（带负责人） ----------
{
  const c = await req('POST', '/crm/customer/create', { name: '测试客户Del' + stamp(), ownerUserId: uid })
  const id = newId(c)
  step('API-007前置', '创建待删除客户', ok(c), `id=${id}`)
  if (id) {
    const d = await req('DELETE', `/crm/customer/delete?id=${id}`)
    step('API-007a', '删除成功', ok(d), `code=${d.body?.code}`)
    const g = await req('GET', `/crm/customer/get?id=${id}`)
    step('API-007b', '删除后查不到', !ok(g) || !g.body?.data, `code=${g.body?.code}`)
  }
}

// ---------- 调查 G（公海，id=10857）删不掉 ----------
{
  const g = await req('GET', '/crm/customer/get?id=10857')
  console.log('[G详情] status=', g.status, 'code=', g.body?.code, 'msg=', (g.body?.msg || '').slice(0, 80))
  if (ok(g)) console.log('[G详情] data=', JSON.stringify(g.body.data).slice(0, 500))
  // 公海列表里找 G
  const p = await req('GET', '/crm/customer/page?pageNo=1&pageSize=100&name=' + encodeURIComponent('测试客户G'))
  const list = p.body?.data?.list ?? []
  for (const it of list) {
    console.log('[G列表行] id=', it.id, 'code=', it.code, 'name=', it.name, 'owner=', it.ownerUserName ?? it.ownerUserId, 'pool=', it.pool ?? it.customerPool ?? '?')
  }
}
console.log('====  done ====')
