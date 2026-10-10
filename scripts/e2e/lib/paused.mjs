import fs from 'node:fs'

// 暂停清单：命中的用例在 runner 中直接登记为 SKIPPED 并附带原因，不执行浏览器步骤。
// 用途是当某模块正由另一会话重新开发时，先冻结该模块的自动化，避免与在途改动互相干扰。
// 恢复方式：清空 `cases/paused.json` 的 suites/cases，或删除该文件。
export function loadPausedCatalog (file) {
  if (!file || !fs.existsSync(file)) {
    return { reason: '', suites: [], cases: [] }
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  const suites = Array.isArray(raw.suites) ? raw.suites.map(String) : []
  const cases = Array.isArray(raw.cases) ? raw.cases.map(String) : []
  return { reason: String(raw.reason || '').trim(), suites, cases }
}

export function pauseReasonFor (definition, paused) {
  if (!definition || !paused) return ''
  const suiteId = String(definition.suite ?? '')
  const caseId = String(definition.id ?? '')
  const pausedSuite = (paused.suites || []).includes(suiteId)
  const pausedCase = (paused.cases || []).includes(caseId)
  if (!pausedSuite && !pausedCase) return ''
  return paused.reason || '该用例已暂停自动化执行'
}
