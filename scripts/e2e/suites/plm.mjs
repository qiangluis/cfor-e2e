export const cases = ['PLM-001', 'PLM-002']

export const runCase = async ({ caseRecord }) => {
  caseRecord.notes.push('案例已锁定产品项目下发为正式发布链路，未发布版本不得被 ERP/MES 业务使用。')
  return { designed: true }
}
