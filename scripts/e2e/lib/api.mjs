// API 层：fetch 封装 + AES 加解密（用于 *-encrypted 接口）。
// config.apiUrl 已含 /admin-api 前缀，这里不再拼接。
import { config } from '../config/index.mjs'
import { encryptRequest, decryptResponse, ENCRYPT_HEADER } from './crypto.mjs'

export function createApiClient ({ token = '', tenantId = '', check } = {}) {
  const headers = () => {
    const h = { 'Content-Type': 'application/json' }
    if (token) h.Authorization = `Bearer ${token}`
    if (tenantId) h['tenant-id'] = String(tenantId)
    return h
  }

  async function request (method, path, { body, encrypted = false, check: c } = {}) {
    const h = headers()
    let payload
    if (body !== undefined) {
      if (encrypted) {
        payload = encryptRequest(body)
        h[ENCRYPT_HEADER] = 'true'
      } else {
        payload = JSON.stringify(body)
      }
    }
    const resp = await fetch(`${config.apiUrl}${path}`, { method, headers: h, body: payload })
    const raw = await resp.text()
    let data = raw
    if (resp.headers.get(ENCRYPT_HEADER.toLowerCase()) === 'true' || resp.headers.get(ENCRYPT_HEADER) === 'true') {
      data = decryptResponse(raw)
    } else {
      try { data = JSON.parse(raw) } catch { /* 保持原文 */ }
    }
    ;(c || check)?.step('api', `${method} ${path} → ${resp.status}`, resp.ok, typeof data === 'object' ? `code=${data.code}` : String(data).slice(0, 120))
    if (!resp.ok) throw new Error(`API ${resp.status}：${method} ${path}`)
    return data
  }

  return {
    get: (p, o) => request('GET', p, o),
    post: (p, body, o) => request('POST', p, { ...o, body }),
    /** 租户名 → 租户 id（登录页同款接口） */
    async tenantIdByName (name) {
      const r = await this.get(`/system/tenant/get-id-by-name?name=${encodeURIComponent(name)}`)
      const id = r?.data ?? r
      if (!id) throw new Error(`租户不存在：${name}`)
      return String(id)
    },
    /** 当前登录用户信息（含租户上下文） */
    getPermissionInfo () {
      return this.get('/system/auth/get-permission-info')
    }
  }
}

/** 后端健康：online 用 login-config（200 即 API 可达）；local 用 actuator/health */
export async function apiHealth ({ check } = {}) {
  if (config.target === 'local') {
    const base = config.apiUrl.replace(/\/admin-api$/, '')
    const r = await fetch(`${base}/actuator/health`)
    const j = await r.json().catch(() => ({}))
    check?.step('api', 'actuator health=UP', j.status === 'UP', JSON.stringify(j).slice(0, 120))
    return
  }
  const r = await fetch(`${config.apiUrl}/system/auth/login-config`)
  check?.step('api', '后端 API 可达（login-config）', r.ok, `status=${r.status}`)
  if (!r.ok) throw new Error(`后端 API 不可达：${r.status}`)
}
