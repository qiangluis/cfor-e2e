import assert from 'node:assert/strict'

// Accept Jackson LocalDate tuples or ISO dates without rollover or timezone conversion.
export const normalizeLocalDate = (value, label = 'LocalDate') => {
  let parts
  if (typeof value === 'string') {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
    assert.ok(match, `${label}: expected an ISO date`)
    parts = match.slice(1).map(Number)
  } else {
    assert.ok(Array.isArray(value) && value.length === 3 &&
      Array.from(value).every(Number.isSafeInteger), `${label}: expected a LocalDate tuple`)
    parts = value
  }
  const [year, month, day] = parts
  const leapYear = year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0)
  const maxDay = [4, 6, 9, 11].includes(month)
    ? 30
    : month === 2 ? (leapYear ? 29 : 28) : 31
  assert.ok(year >= 1 && year <= 9999 && month >= 1 && month <= 12 &&
    day >= 1 && day <= maxDay, `${label}: invalid calendar date`)
  return parts.map((part, index) => String(part).padStart(index === 0 ? 4 : 2, '0')).join('-')
}
