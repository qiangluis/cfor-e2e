import { isBusinessSuccess } from './assertions.mjs'

export function resolveLoginContext (payload, token) {
  const tenantId = payload?.data?.tenantId
  const validType = typeof tenantId === 'string' ||
    (typeof tenantId === 'number' && Number.isSafeInteger(tenantId))
  const normalized = validType ? String(tenantId).trim() : ''
  return {
    token,
    tenantId: isBusinessSuccess(payload) &&
      typeof token === 'string' && token.length > 0 &&
      payload?.data?.accessToken === token && /^[1-9]\d*$/.test(normalized)
      ? normalized
      : ''
  }
}

export function extractAccessToken (entries, now = Date.now()) {
  for (const [key, raw] of entries) {
    if (!/^(?:ACCESS_TOKEN|accessToken|access_token)$/i.test(key) || !raw) continue
    let value
    try {
      value = JSON.parse(raw)
    } catch {
      value = raw
    }
    if (value && typeof value === 'object') {
      if (typeof value.e === 'number' && value.e <= now) continue
      value = value.v
      if (typeof value === 'string') {
        try { value = JSON.parse(value) } catch {}
      }
    }
    if (typeof value !== 'string') continue
    value = value.replace(/^Bearer\s+/i, '').trim()
    if (value.length > 20 && !/[{}"\s]/.test(value)) return value
  }
  return ''
}
