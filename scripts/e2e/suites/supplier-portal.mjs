export const cases = ['PB150-OUTSOURCE-PORTAL-001']

export const runCase = async () => {
  // The retained component smoke uses mocked supplier APIs and a separate port.
  // Never promote its output to evidence of a real business workflow.
  throw new Error(
    'BLOCKED: 供应商门户需补 9151 上的真实独立登录与业务数据链；旧模拟接口/9152 组件烟测不作为验收证据'
  )
}
