export const DEFAULT_CASE_TIMEOUT_MS = 180000
export const TERMINAL_FAILURE_STATUSES = new Set(['FAIL', 'BLOCKED'])

function readValue (argv, index, option) {
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${option} 缺少参数`)
  }
  return value
}

export function validateCaseTimeoutMs (value) {
  if (!Number.isInteger(value) || value < 1000) {
    throw new Error(`--case-timeout-ms 必须是不小于 1000 的整数，当前=${value}`)
  }
  return value
}

export function parseRunnerArgs (
  argv,
  { reuseSession = true, caseTimeoutMs = DEFAULT_CASE_TIMEOUT_MS } = {}
) {
  const args = {
    list: false,
    suite: '',
    caseIds: [],
    headed: false,
    resume: false,
    reuseSession,
    continueOnFailure: false,
    caseTimeoutMs: Number(caseTimeoutMs)
  }

  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]
    if (value === '--list') args.list = true
    else if (value === '--suite') {
      args.suite = readValue(argv, index, '--suite')
      index++
    } else if (value === '--case') {
      args.caseIds.push(readValue(argv, index, '--case'))
      index++
    }
    else if (value === '--headed' || value === '--no-headless') args.headed = true
    else if (value === '--headless') args.headed = false
    else if (value === '--resume') args.resume = true
    else if (value === '--fresh' || value === '--no-resume') args.resume = false
    else if (value === '--reuse-session') args.reuseSession = true
    else if (value === '--no-reuse-session') args.reuseSession = false
    else if (value === '--continue-on-failure') args.continueOnFailure = true
    else if (value === '--case-timeout-ms') {
      args.caseTimeoutMs = Number(readValue(argv, index, '--case-timeout-ms'))
      index++
    }
  }

  args.caseIds = [...new Set(args.caseIds)]
  validateCaseTimeoutMs(args.caseTimeoutMs)
  return args
}

export function caseFailureAction (status, continueOnFailure = false) {
  if (!TERMINAL_FAILURE_STATUSES.has(status)) return 'continue'
  return continueOnFailure ? 'continue-isolated' : 'stop'
}
