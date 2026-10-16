import assert from 'node:assert/strict'
import test from 'node:test'
import { runPartnerIsolationEvidence } from '../fixtures/partner-isolation.mjs'

const localConfig = {
  target: 'local',
  tenantId: '1',
  tenantName: 'CFOR 标准平台',
  webBase: 'http://127.0.0.1:9151',
  apiBase: 'http://127.0.0.1:48083',
  db: { host: '127.0.0.1', name: 'cfor_admin_standard' }
}

test('partner business failure remains a failure without being counted as cleanup residue', async () => {
  const caseRecord = { checks: [] }
  await assert.rejects(runPartnerIsolationEvidence({
    context: { caseRecord },
    primaryApi: {
      async getBusiness () {
        return { code: 0, data: { roles: [], permissions: [] } }
      }
    },
    primaryOwnerId: '1',
    dependencies: { config: localConfig, writeFixturesEnabled: true }
  }), /private account retirement requires the current platform super_admin/)
  const cleanup = caseRecord.checks.find((item) =>
    item.name === 'PB034 隔离业务正式清理账号套餐租户停用且令牌zero')
  assert.equal(cleanup.passed, true)
  assert.match(cleanup.details, /tenantId=not-created/)
  assert.match(cleanup.details, /businessCompleted=false/)
  assert.match(cleanup.details, /businessErrors=1/)
  assert.match(cleanup.details, /lifecycleErrors=0/)
})
