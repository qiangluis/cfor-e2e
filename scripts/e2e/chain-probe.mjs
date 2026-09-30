// 链路探针：登录 + 探测关键接口是否存在
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
  TOKEN = sel.body?.data?.accessToken || sel.body?.data?.token
  if (!TOKEN) throw new Error('登录失败: ' + JSON.stringify(sel.body).slice(0, 200))
  console.log('登录 OK')
}
const ok = (r) => r.status === 200 && (r.body?.code === 0 || r.body?.code === '0')

await login()
const me = await req('GET', '/system/auth/get-permission-info')
console.log('当前用户 id =', me.body?.data?.user?.id, ' nickname=', me.body?.data?.user?.nickname)

// 探测：ERP 物料/产品
for (const p of ['/erp/product/page', '/wms/product/page', '/erp/sale/order/page', '/erp/sale-order/page']) {
  const r = await req('POST', p, { pageNo: 1, pageSize: 1 })
  const total = r.body?.data?.total
  console.log(p, '=> status', r.status, 'code', r.body?.code, 'msg', (r.body?.msg || '').slice(0, 40), 'total', total)
}
