import { runHrmLocalClosure } from '../fixtures/hrm-local-closure.mjs'

export const cases = ['HRM-001']

export async function runCase (context, dependencies = {}) {
  if (context.caseId !== 'HRM-001') throw new Error(`Unsupported HRM case: ${context.caseId}`)
  return (dependencies.runHrmLocalClosure || runHrmLocalClosure)(context, dependencies)
}
