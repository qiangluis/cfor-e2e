// 未实现套件的诚实桩：runCase 明确返回 notImplemented，
// runner 会把 PARTIAL 记为 PARTIAL（未执行），DESIGNED/BLOCKED 记为 SKIP——绝不伪造 PASS。
export const implemented = false

export async function runCase ({ caseId }) {
  return { notImplemented: true, note: `${caseId} 步骤尚未实现` }
}
