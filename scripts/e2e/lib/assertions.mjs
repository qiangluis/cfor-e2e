export const nonEmpty = (value) =>
  value !== undefined && value !== null && String(value).trim() !== ''

export const asList = (value) => {
  if (Array.isArray(value)) return value
  if (Array.isArray(value?.list)) return value.list
  if (Array.isArray(value?.records)) return value.records
  if (Array.isArray(value?.data?.list)) return value.data.list
  if (Array.isArray(value?.data?.records)) return value.data.records
  if (Array.isArray(value?.result?.list)) return value.result.list
  if (Array.isArray(value?.result?.records)) return value.result.records
  if (Array.isArray(value?.data)) return value.data
  if (Array.isArray(value?.result)) return value.result
  return []
}

export const unwrapWebStorageValue = (rawValue) => {
  if (!rawValue) return null
  try {
    const parsed = JSON.parse(rawValue)
    if (parsed && typeof parsed === 'object' && 'v' in parsed) {
      return typeof parsed.v === 'string' ? JSON.parse(parsed.v) : parsed.v
    }
    return parsed
  } catch {
    return rawValue
  }
}

export const isBusinessSuccess = (body) =>
  (body?.code === 0 && body.success !== false) ||
  (body?.code === 200 && body.success === true)

export const assertBusinessSuccess = (body, label) => {
  if (!isBusinessSuccess(body)) {
    const summary = JSON.stringify(redact(body)) ?? '<empty>'
    throw new Error(`${label} business failure: ${summary.slice(0, 500)}`)
  }
  return body
}

export const assertStatus = (actual, expected, label) => {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`)
  }
}
import { redact } from './redact.mjs'
