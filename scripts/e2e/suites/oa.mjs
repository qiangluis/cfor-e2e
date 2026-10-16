import { runOaLocalClosure } from '../fixtures/oa-local-closure.mjs'

export const cases = ['OA-001']

export async function runCase (context, dependencies = {}) {
  if (context.caseId !== 'OA-001') throw new Error(`Unsupported OA case: ${context.caseId}`)
  return (dependencies.runOaLocalClosure || runOaLocalClosure)(context, dependencies)
}
