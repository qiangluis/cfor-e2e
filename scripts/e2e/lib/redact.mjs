const sensitiveKey = /password|passwd|secret|token|authorization|license|private.?key|mobile|phone|email|id.?card/i

export function resourceUrl (url) {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return '[unavailable]'
  }
}

export function redact (value) {
  if (Array.isArray(value)) return value.map(redact)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key, sensitiveKey.test(key) ? '[REDACTED]' : redact(item)
  ]))
}
