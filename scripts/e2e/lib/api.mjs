import { config } from '../config/index.mjs'
import { assertBusinessSuccess, isBusinessSuccess } from './assertions.mjs'
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

const nonBusinessCodes = new Set([200, 401, 403, 404, 405, 423, 429, 900, 901, 999])
const systemFailureMessage = /(?:系统|服务器|服务|内部|未知)(?:发生(?:了)?)?(?:异常|错误|故障)|服务(?:暂时)?不可用|网络(?:异常|错误|故障)|连接(?:失败|超时)|Internal\s+Server\s+Error|Service\s+(?:Unavailable|Error|Exception)|(?:System|Server|Runtime|SQL|Database)\s+(?:Error|Exception)|Bad\s+Gateway|Gateway\s+Timeout|ECONN(?:REFUSED|RESET)|ETIMEDOUT|NullPointerException|SQL(?:SyntaxError)?Exception/i

const responseMessages = (payload) => [payload?.msg, payload?.message]
  .filter((message) => typeof message === 'string' && message.trim() !== '')

/**
 * A business rejection is an application-level refusal in an otherwise valid
 * HTTP response. Transport, HTTP, authentication, and service failures stay
 * outside this category so a negative assertion cannot hide runtime errors.
 */
export const isBusinessRejection = (payload) => {
  const code = payload?.code
  const messages = responseMessages(payload)
  return !isBusinessSuccess(payload) &&
    payload?.ok !== true &&
    payload?.success !== true &&
    Number.isSafeInteger(code) &&
    code > 0 &&
    !nonBusinessCodes.has(code) &&
    !(code >= 500 && code < 600) &&
    messages.length > 0 &&
    !messages.some((message) => systemFailureMessage.test(message))
}

const matchesMessage = (messages, expectedMessage) => {
  if (typeof expectedMessage === 'string') {
    return messages.includes(expectedMessage)
  }
  if (expectedMessage instanceof RegExp) {
    return messages.some((message) => {
      expectedMessage.lastIndex = 0
      return expectedMessage.test(message)
    })
  }
  return false
}

/**
 * Match an explicit request-level business rejection contract.
 *
 * `true` accepts any valid business rejection. Object contracts must specify
 * both `code`/`codes` and `message`/`msg` for callers that need exact matching.
 */
export const matchesExpectedBusinessRejection = (payload, expected) => {
  if (!isBusinessRejection(payload)) return false
  if (expected === true) return true
  if (!expected || typeof expected !== 'object') return false

  const expectedCodes = expected.codes ?? expected.code
  const expectedMessage = expected.message ?? expected.msg
  const codeMatches = Array.isArray(expectedCodes)
    ? expectedCodes.length > 0 &&
      expectedCodes.every((code) => Number.isSafeInteger(code)) &&
      expectedCodes.includes(payload.code)
    : Number.isSafeInteger(expectedCodes) && payload.code === expectedCodes
  return codeMatches && matchesMessage(responseMessages(payload), expectedMessage)
}

export const serverApiFailures = (entries = []) => entries.filter((entry) =>
  !entry.expectedBusinessRejectionMatched && (
    entry.networkError ||
    entry.responseError ||
    Number(entry.status) >= 500 ||
    (Number(entry.code) >= 500 && Number(entry.code) < 600)
  )
)

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

    let response, payload
    try {
      response = await fetch(endpoint(pathname), {
        method,
        headers: requestHeaders,
        body: requestBody,
        signal: AbortSignal.timeout(options.timeoutMs || config.requestTimeoutMs)
      })
      payload = payloadFromText(await response.text(), response)
    } catch (error) {
      record?.api?.push({
        method, pathname, status: response?.status ?? null,
        ...(response ? { responseError: true } : { networkError: true }),
        bodySummary: String(redact(error.message || error)).slice(0, 500)
      })
      throw error
    }
    const entry = {
      method,
      pathname,
      status: response.status,
      code: payload?.code,
      bodySummary: (JSON.stringify(redact(payload)) ?? '<empty>').slice(0, 1000)
    }
    if (response.ok &&
      matchesExpectedBusinessRejection(payload, options.expectedBusinessRejection)) {
      entry.expectedBusinessRejectionMatched = true
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
      let response, buffer
      try {
        response = await fetch(endpoint(pathname), {
          method: 'GET',
          headers: {
            ...headers(),
            ...(options.headers || {})
          },
          signal: AbortSignal.timeout(options.timeoutMs || config.requestTimeoutMs)
        })
        buffer = Buffer.from(await response.arrayBuffer())
      } catch (error) {
        record?.api?.push({
          method: 'GET', pathname, status: response?.status ?? null,
          ...(response ? { responseError: true } : { networkError: true }),
          bodySummary: String(redact(error.message || error)).slice(0, 500)
        })
        throw error
      }
      record?.api?.push({
        method: 'GET',
        pathname,
        status: response.status,
        code: response.ok ? 0 : response.status,
        bodySummary: `content-type=${response.headers.get('content-type') || ''}`
      })
      if (!response.ok) throw new Error(`HTTP ${response.status} GET ${pathname}`)
      return {
        buffer,
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
