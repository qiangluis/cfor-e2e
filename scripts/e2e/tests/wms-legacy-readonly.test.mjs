import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isReadonlyViewRejection, mirrorKey, verifyLegacyWarehouse, viewWriteProbes,
  warehouseSnapshotSql, warehouseViewSql
} from '../fixtures/wms-legacy-readonly.mjs'

const snapshot = [
  ['warehouse', '9007199254740993', 'Warehouse', 'NULL', 'NULL', 'NULL', '0', '0', '1'],
  ['warehouse', '9007199254740994', 'Disabled', 'NULL', 'NULL', 'NULL', '1', '0', '1'],
  ['sale', '11', '21', '9007199254740993', '4.000000', '0', '1'],
  ['purchase', '12', '22', '9007199254740993', '6.000000', '0', '1'],
  ['sale-header', '21', '4.000000', '0'],
  ['purchase-header', '22', '6.000000', '0']
]
const facts = [
  ['table', 'mes_wms_ware_house', 'BASE TABLE'],
  ['table', 'erp_warehouse', 'VIEW'],
  ['view', 'NO', 'select w.id from `cfor_admin_standard`.`mes_wms_ware_house` w'],
  ['projection', '2', '1', '1', '0'],
  ['view-count', '2'],
  ['sale-reference', '1', '4.000000', '1', '1'],
  ['purchase-reference', '1', '6.000000', '1', '1']
]
const pageResponse = {
  code: 0, data: {
    total: 2, list: [{
      id: '9007199254740993', name: 'Warehouse', status: 0, sort: 0, defaultStatus: false,
      warehousePrice: null, truckagePrice: null
    }]
  }
}

const harness = (options = {}) => {
  const record = { checks: [], notes: [], database: [] }
  const calls = []
  const contribution = {
    key: mirrorKey, status: 'READY', added: 0, modified: 0, conflicts: 0, skipped: 1
  }
  const result = (applied) => ({
    code: 0, data: {
      applied, added: 0, modified: 0, conflicts: 0, skipped: 1,
      contributions: [contribution]
    }
  })
  let reads = 0
  const dependencies = {
    config: {
      target: 'local', webBase: 'http://127.0.0.1:9151', apiBase: 'http://127.0.0.1:48083',
      tenantId: '1', tenantName: 'CFOR 标准平台'
    },
    writeEnabled: true,
    assertLocalWriteSafety: async () => calls.push(['safety']),
    runReadOnlySql: async (sql) => {
      calls.push(['read', sql])
      reads += 1
      return {
        available: true, rows: reads === 2 ? structuredClone(facts) : structuredClone(snapshot)
      }
    },
    runLocalFixtureSql: async (sql) => {
      calls.push(['write', sql])
      const operation = viewWriteProbes.find(([, probe]) => sql.includes(probe))
      assert.ok(operation, 'unexpected SQL mutation')
      throw new Error(`ERROR ${operation[2]} (HY000) at line 1: The target table erp_warehouse ` +
        `of the ${operation[0]} is not ${operation[0] === 'INSERT' ? 'insertable-into' : 'updatable'}`)
    },
    ...options.dependencies
  }
  const api = {
    postBusiness: async (path, body) => {
      calls.push(['api', path, body])
      return result(path.endsWith('/apply'))
    },
    ...options.api
  }
  return {
    record, calls, run: () => verifyLegacyWarehouse({
      api, caseRecord: record, pageResponse: options.pageResponse || pageResponse, dependencies
    })
  }
}

test('legacy warehouse closes only on database, nonempty history and mirror apply evidence', async () => {
  const h = harness()
  assert.equal((await h.run()).covered, true)
  assert.equal(h.record.checks.length, 11)
  assert.ok(h.record.checks.every((check) => check.passed))
  const writes = h.calls.filter(([type]) => type === 'write')
  assert.equal(writes.length, 3)
  assert.ok(writes.every(([, sql]) => sql.startsWith('START TRANSACTION;') &&
    sql.endsWith('ROLLBACK;') && sql.includes('WHERE 1=0')))
  const apiCalls = h.calls.filter(([type]) => type === 'api')
  assert.equal(apiCalls.length, 2)
  for (const [, , body] of apiCalls) {
    assert.deepEqual(body, { modules: ['wms'], keys: [mirrorKey], firstRun: false })
  }
})

test('database writable view metadata is a failure even when write rejection and API look correct', async () => {
  let readCount = 0
  const h = harness({ dependencies: {
    runReadOnlySql: async () => {
      const rows = structuredClone(++readCount === 2 ? facts : snapshot)
      if (readCount === 2) rows.find((row) => row[0] === 'view')[1] = 'YES'
      return { available: true, rows }
    }
  } })
  assert.equal((await h.run()).covered, false)
  assert.equal(h.record.checks[0].passed, false)
})

test('empty history and empty page cannot become proof of preservation', async () => {
  let readCount = 0
  const h = harness({ pageResponse: { code: 0, data: { total: 0, list: [] } },
    dependencies: {
      runReadOnlySql: async () => {
        const rows = structuredClone(++readCount === 2 ? facts : snapshot)
        if (readCount === 2) {
          rows.find((row) => row[0] === 'sale-reference').splice(1, 4, '0', 'NULL', 'NULL', 'NULL')
        }
        return { available: true, rows }
      }
    }
  })
  assert.equal((await h.run()).covered, false)
  assert.equal(h.record.checks.find((check) => check.name.startsWith('旧仓库非空分页')).passed, false)
  assert.equal(h.record.checks.find((check) => check.name.startsWith('销售出库历史')).passed, false)
})

test('missing database evidence stops before database probes or mirror apply', async () => {
  const h = harness({ dependencies: {
    runReadOnlySql: async () => ({ available: false, rows: [], reason: 'unconfigured' })
  } })
  assert.equal((await h.run()).covered, false)
  assert.equal(h.calls.length, 0)
  assert.equal(h.record.checks.length, 0)
})

test('read-only mode leaves direct probes and apply unverified', async () => {
  const h = harness({ dependencies: { writeEnabled: false } })
  assert.equal((await h.run()).covered, false)
  assert.equal(h.calls.filter(([type]) => ['api', 'write', 'safety'].includes(type)).length, 0)
})

test('legacy API keeps its existing string sort contract without treating blank as zero', async () => {
  const page = structuredClone(pageResponse)
  page.data.list[0].sort = '0'
  assert.equal((await harness({ pageResponse: page }).run()).covered, true)
  page.data.list[0].sort = ''
  const h = harness({ pageResponse: page })
  assert.equal((await h.run()).covered, false)
  assert.equal(h.record.checks.find((check) => check.name.startsWith('旧仓库非空分页')).passed, false)
})

test('view SQL probes accept only the precise MySQL read-only error, not network or permission errors', () => {
  for (const message of [
    'ERROR 1044 (42000): Access denied', 'mysql exited with 1', 'ETIMEDOUT',
    'ERROR 1288 (HY000): The target table unrelated of the UPDATE is not updatable'
  ]) {
    assert.equal(isReadonlyViewRejection(new Error(message), 1288), false)
  }
  assert.equal(isReadonlyViewRejection(new Error(
    'ERROR 1288 (HY000) at line 1: The target table erp_warehouse of the UPDATE is not updatable'
  ), 1288), true)
})

test('accepted no-op probe and changed warehouse snapshot fail rather than hiding regressions', async () => {
  let readCount = 0
  const h = harness({ dependencies: {
    runLocalFixtureSql: async () => [],
    runReadOnlySql: async () => {
      const rows = structuredClone(++readCount === 2 ? facts : snapshot)
      if (readCount === 3) rows[0][2] = 'Changed'
      return { available: true, rows }
    }
  } })
  assert.equal((await h.run()).covered, false)
  assert.ok(h.record.checks.filter((check) => check.name.startsWith('数据库拒绝'))
    .every((check) => !check.passed))
  assert.equal(h.record.checks.at(-1).passed, false)
})

test('snapshot and projection SQL preserve tenant scope, both ERP histories and default projections', () => {
  assert.match(warehouseSnapshotSql, /erp_sale_out_items/)
  assert.match(warehouseSnapshotSql, /erp_purchase_in_items/)
  assert.match(warehouseSnapshotSql, /total_count/)
  assert.match(warehouseViewSql, /v\.warehouse_price IS NULL AND v\.truckage_price IS NULL/)
  assert.match(warehouseViewSql, /v\.sort=0 AND v\.default_status=0/)
  assert.match(warehouseViewSql, /CAST\(e\.warehouse_id AS CHAR\)=w\.id/)
  assert.doesNotMatch(warehouseSnapshotSql + warehouseViewSql, /\b(?:INSERT|UPDATE|DELETE|DROP)\b/)
})
