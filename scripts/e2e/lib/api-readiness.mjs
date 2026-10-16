import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'

export const DEFAULT_API_READY_TIMEOUT_MS = 15 * 60 * 1000
export const DEFAULT_API_READY_INTERVAL_MS = 2000
export const DEFAULT_API_READY_REQUEST_TIMEOUT_MS = 5000

export function runnerHealthUrl (settings) {
  if (settings.target === 'local') {
    const api = new URL(settings.apiBase)
    if (!['http:', 'https:'].includes(api.protocol) ||
        !['127.0.0.1', 'localhost', '[::1]'].includes(api.hostname) ||
        api.port !== '48083' || api.username || api.password) {
      throw new Error('BLOCKED: Local API readiness requires a credential-free loopback:48083')
    }
    // Local readiness cannot be disabled or redirected by a stale health URL.
    return new URL('/actuator/health', api.origin).href
  }
  if (!settings.apiHealthUrl?.trim()) return null
  const health = new URL(settings.apiHealthUrl)
  if (!['http:', 'https:'].includes(health.protocol) || health.username || health.password) {
    throw new Error('BLOCKED: API health URL must use HTTP(S) without embedded credentials')
  }
  return health.href
}

function positiveDuration (value, name) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2147483647) {
    throw new Error(`BLOCKED: ${name} must be a positive bounded integer in milliseconds`)
  }
  return value
}

async function probeHealth (url, timeoutMs, dependencies) {
  const { fetch: request, setTimeout: schedule, clearTimeout: cancel } = dependencies
  const controller = new AbortController()
  let response
  let timer
  try {
    // Bound both connect and response-body reads, even if a transport ignores abort.
    const body = await Promise.race([
      (async () => {
        response = await request(url, {
          method: 'GET',
          redirect: 'manual',
          cache: 'no-store',
          signal: controller.signal
        })
        return response.json()
      })(),
      new Promise((resolve, reject) => {
        timer = schedule(() => {
          const error = new Error(`API health request exceeded ${timeoutMs}ms`)
          error.name = 'TimeoutError'
          error.code = 'E2E_API_HEALTH_REQUEST_TIMEOUT'
          controller.abort(error)
          reject(error)
        }, timeoutMs)
      })
    ])
    return {
      httpStatus: response.status,
      httpOk: response.ok === true && response.status >= 200 && response.status < 300,
      healthStatus: body?.status ?? null,
      body
    }
  } catch (error) {
    return {
      httpStatus: response?.status ?? null,
      httpOk: false,
      healthStatus: null,
      ...(response ? { responseError: true } : { networkError: true }),
      error
    }
  } finally {
    if (timer !== undefined) cancel(timer)
  }
}

export async function waitForApiReady ({
  settings,
  timeoutMs = DEFAULT_API_READY_TIMEOUT_MS,
  intervalMs = DEFAULT_API_READY_INTERVAL_MS,
  requestTimeoutMs = DEFAULT_API_READY_REQUEST_TIMEOUT_MS,
  onAttempt
}, dependencies = {}) {
  const url = runnerHealthUrl(settings)
  if (!url) {
    return { status: 'SKIPPED', reason: 'health endpoint not configured', url, attempts: [] }
  }
  positiveDuration(timeoutMs, 'API readiness timeout')
  positiveDuration(intervalMs, 'API readiness interval')
  positiveDuration(requestTimeoutMs, 'API health request timeout')
  const tools = {
    fetch: globalThis.fetch,
    now: () => performance.now(),
    sleep,
    setTimeout,
    clearTimeout,
    ...dependencies
  }
  const startedAt = tools.now()
  const deadline = startedAt + timeoutMs
  const evidence = {
    status: 'WAITING', url, timeoutMs, intervalMs, requestTimeoutMs,
    elapsedMs: 0, attempts: []
  }
  while (true) {
    const remainingMs = deadline - tools.now()
    if (remainingMs <= 0) break
    const outcome = await probeHealth(url, Math.min(requestTimeoutMs, remainingMs), tools)
    evidence.elapsedMs = Math.max(0, tools.now() - startedAt)
    const attempt = {
      attempt: evidence.attempts.length + 1,
      elapsedMs: evidence.elapsedMs,
      ...outcome
    }
    evidence.attempts.push(attempt)
    onAttempt?.(attempt)
    if (outcome.httpOk && outcome.healthStatus === 'UP' && tools.now() <= deadline) {
      evidence.status = 'UP'
      return evidence
    }
    const delayMs = Math.min(intervalMs, deadline - tools.now())
    if (delayMs > 0) await tools.sleep(delayMs)
  }
  evidence.status = 'BLOCKED'
  evidence.elapsedMs = Math.max(0, tools.now() - startedAt)
  const last = evidence.attempts.at(-1)
  const error = new Error(
    `BLOCKED: API not ready after ${timeoutMs}ms (${url}; ` +
    `HTTP=${last?.httpStatus ?? 'unavailable'}, status=${last?.healthStatus ?? 'unknown'})`,
    { cause: last?.error }
  )
  error.name = 'ApiReadinessError'
  error.code = 'E2E_API_NOT_READY'
  error.status = 'BLOCKED'
  error.readiness = evidence
  throw error
}
