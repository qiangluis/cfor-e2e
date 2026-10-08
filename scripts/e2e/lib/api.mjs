import { config } from '../config/index.mjs'
import { assertBusinessSuccess } from './assertions.mjs'
import { decryptResponse, encryptRequest, ENCRYPT_HEADER } from './crypto.mjs'
import { redact } from './redact.mjs'

function endpoint (pathname) {
  const value = String(pathname)
  if (/^https?:\/\//.test(value)) return value
  if (value.startsWith('/admin-api/')) return `${config.apiBase}${value}`
  return `${config.apiUrl}${value.startsWith('/') ? value : `/${value}`}`
}

function payloadFromText (text, response) {
  const encrypted =
    response.headers.get(ENCRYPT_HEADER.toLowerCase()) === 'true' ||
    response.headers.get(ENCRYPT_HEADER) === 'true'
  if (encrypted) return decryptResponse(text)
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return { raw: text }
  }
}

export const createApiClient = ({ token = '', tenantId = config.tenantId, check, record } = {}) => {
  const headers = () => ({
    'content-type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(tenantId ? { 'tenant-id': String(tenantId) } : {})
  })

  const request = async (method, pathname, body, options = {}) => {
    const requestHeaders = {
      ...headers(),
      ...(options.headers || {})
    }
    let requestBody
    if (body !== undefined) {
      if (options.encrypted) {
        requestBody = encryptRequest(body)
        requestHeaders[ENCRYPT_HEADER] = 'true'
      } else if (body instanceof FormData || body instanceof Blob || body instanceof ArrayBuffer) {
        requestBody = body
        delete requestHeaders['content-type']
      } else {
        requestBody = JSON.stringify(body)
      }
    }

    const response = await fetch(endpoint(pathname), {
      method,
      headers: requestHeaders,
      body: requestBody,
      signal: AbortSignal.timeout(options.timeoutMs || config.requestTimeoutMs)
    })
    const text = await response.text()
    const payload = payloadFromText(text, response)
    const entry = {
      method,
      pathname,
      status: response.status,
      code: payload?.code,
      bodySummary: JSON.stringify(redact(payload)).slice(0, 1000)
    }
    record?.api?.push(entry)
    check?.step('api', `${method} ${pathname} -> ${response.status}`, response.ok, entry.bodySummary)
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${method} ${pathname}: ${entry.bodySummary.slice(0, 500)}`)
    }
    return payload
  }

  const business = async (method, pathname, body, options = {}) => {
    const result = await request(method, pathname, body, options)
    return assertBusinessSuccess(result, pathname)
  }

  return {
    request,
    get: (pathname, options) => request('GET', pathname, undefined, options),
    post: (pathname, body, options) => request('POST', pathname, body, options),
    put: (pathname, body, options) => request('PUT', pathname, body, options),
    delete: (pathname, options) => request('DELETE', pathname, undefined, options),
    getBusiness: (pathname, options) => business('GET', pathname, undefined, options),
    postBusiness: (pathname, body, options) => business('POST', pathname, body, options),
    putBusiness: (pathname, body, options) => business('PUT', pathname, body, options),
    deleteBusiness: (pathname, options) => business('DELETE', pathname, undefined, options),
    async upload (pathname, formData, options = {}) {
      return request('POST', pathname, formData, options)
    },
    async uploadBusiness (pathname, formData, options = {}) {
      return assertBusinessSuccess(await this.upload(pathname, formData, options), pathname)
    },
    async download (pathname, options = {}) {
      const response = await fetch(endpoint(pathname), {
        method: 'GET',
        headers: {
          ...headers(),
          ...(options.headers || {})
        },
        signal: AbortSignal.timeout(options.timeoutMs || config.requestTimeoutMs)
      })
      record?.api?.push({
        method: 'GET',
        pathname,
        status: response.status,
        code: response.ok ? 0 : response.status,
        bodySummary: `content-type=${response.headers.get('content-type') || ''}`
      })
      if (!response.ok) throw new Error(`HTTP ${response.status} GET ${pathname}`)
      return {
        buffer: Buffer.from(await response.arrayBuffer()),
        contentType: response.headers.get('content-type'),
        contentDisposition: response.headers.get('content-disposition')
      }
    },
    async tenantIdByName (name) {
      const result = await this.get(`/system/tenant/get-id-by-name?name=${encodeURIComponent(name)}`)
      return String(result?.data ?? result)
    },
    getPermissionInfo () {
      return this.get('/system/auth/get-permission-info')
    }
  }
}

export async function checkHealth ({ timeoutMs = Math.min(config.requestTimeoutMs, 5000) } = {}) {
  if (!config.apiHealthUrl) return { response: null, body: null, error: null }
  try {
    const response = await fetch(config.apiHealthUrl, {
      signal: AbortSignal.timeout(timeoutMs)
    })
    const body = await response.json().catch(() => ({}))
    return { response, body, error: null }
  } catch (error) {
    return {
      response: null,
      body: null,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export async function apiHealth ({ check } = {}) {
  const { response, body } = await checkHealth()
  const passed = response ? response.ok && body?.status === 'UP' : true
  check?.step('api', '后端健康检查', passed, response ? JSON.stringify(body) : 'health endpoint not configured')
  if (!passed) throw new Error(`后端健康检查失败：${response?.status || 'unavailable'}`)
  return { response, body }
}

export async function publicRequest (method, pathname, body) {
  const response = await fetch(endpoint(pathname), {
    method,
    headers: {
      'content-type': 'application/json',
      ...(config.tenantId ? { 'tenant-id': String(config.tenantId) } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(config.requestTimeoutMs)
  })
  const text = await response.text()
  return { response, payload: payloadFromText(text, response) }
}
