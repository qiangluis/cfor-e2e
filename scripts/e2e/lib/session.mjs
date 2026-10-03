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
