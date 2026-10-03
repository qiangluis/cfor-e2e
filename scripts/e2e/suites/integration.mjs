export const cases = ['INT-001', 'INT-002']

export const runCase = async ({ caseRecord }) => {
  caseRecord.notes.push(
    'INT-002 需要真实外部连接和凭据，当前保持 BLOCKED；不能用平台目录存在替代外部连接成功。'
  )
  return { designed: true }
}
