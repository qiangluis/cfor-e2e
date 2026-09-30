// 证据与断点：result.json / summary.md / checkpoint.json（断点续跑：读+写都实现）。
import fs from 'node:fs'
import path from 'node:path'

export function ensureDir (dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

const ckptPath = (dir) => path.join(dir, 'checkpoint.json')

/** 读断点：返回已通过的 caseId 数组 */
export function loadCheckpoint (dir) {
  try {
    const raw = fs.readFileSync(ckptPath(dir), 'utf8')
    const j = JSON.parse(raw)
    return Array.isArray(j.passed) ? j.passed : []
  } catch { return [] }
}

/** 写断点：把通过的 caseId 追加进去 */
export function saveCheckpoint (dir, caseId) {
  ensureDir(dir)
  const passed = loadCheckpoint(dir)
  if (!passed.includes(caseId)) passed.push(caseId)
  fs.writeFileSync(ckptPath(dir), JSON.stringify({ passed, updatedAt: new Date().toISOString() }, null, 2))
}

export function clearCheckpoint (dir) {
  try { fs.unlinkSync(ckptPath(dir)) } catch {}
}

export function newRun (evidenceDir, runId) {
  const dir = ensureDir(path.join(evidenceDir, runId))
  ensureDir(path.join(dir, 'screenshots'))
  return { runId, dir, shotDir: path.join(dir, 'screenshots'), cases: [] }
}

export function recordCase (run, rec) {
  run.cases.push(rec)
}

export function writeReport (run) {
  const passed = run.cases.filter(c => c.status === 'PASS').length
  const failed = run.cases.filter(c => c.status === 'FAIL').length
  const skipped = run.cases.filter(c => c.status !== 'PASS' && c.status !== 'FAIL').length
  const summary = {
    runId: run.runId,
    at: new Date().toISOString(),
    total: run.cases.length,
    passed, failed, skipped,
    cases: run.cases
  }
  fs.writeFileSync(path.join(run.dir, 'result.json'), JSON.stringify(summary, null, 2))
  const lines = [
    `# CFOR E2E 回归报告（${run.runId}）`,
    '',
    `- 时间：${summary.at}`,
    `- 用例：${summary.total}，通过 ${passed}，失败 ${failed}，跳过/未实现 ${skipped}`,
    '',
    '| 用例 | 套件 | 状态 | 耗时(ms) | 备注 |',
    '|---|---|---|---|---|'
  ]
  for (const c of run.cases) {
    lines.push(`| ${c.caseId} | ${c.suite} | ${c.status} | ${c.durationMs} | ${(c.note || '').replace(/\|/g, '/')} |`)
  }
  lines.push('', '## 分层断言明细', '')
  for (const c of run.cases) {
    lines.push(`### ${c.caseId}（${c.status}）`)
    for (const s of c.steps || []) {
      lines.push(`- [${s.passed ? 'x' : ' '}] [${s.layer}] ${s.name}${s.details ? `（${s.details}）` : ''}`)
    }
    if (c.error) lines.push(`- 错误：${c.error}`)
    lines.push('')
  }
  fs.writeFileSync(path.join(run.dir, 'summary.md'), lines.join('\n'))
  return summary
}
