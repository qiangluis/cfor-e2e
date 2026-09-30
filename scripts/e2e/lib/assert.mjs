// 轻量断言：失败时抛出带上下文的 Error，runner 会捕获并记为 FAIL。
export function ok (cond, message, details = '') {
  if (!cond) {
    const d = details ? ` | ${details}` : ''
    throw new Error(`断言失败：${message}${d}`)
  }
}

export function nonEmpty (v) {
  return v !== undefined && v !== null && String(v).trim() !== ''
}

/** 分层断言收集器：page / api / db / event 逐层记录，全部通过才算用例通过 */
export function checklist () {
  const steps = []
  return {
    steps,
    step (layer, name, passed, details = '') {
      steps.push({ layer, name, passed: !!passed, details: String(details).slice(0, 500) })
      if (!passed) throw new Error(`[${layer}] ${name}${details ? ` | ${details}` : ''}`)
    }
  }
}
