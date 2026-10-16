import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { CRM_CUSTOMER_TAG_FORMAL_API_SURFACE, CRM_CUSTOMER_TAG_SYSTEM_GENERATION_API_SURFACE,
  crmCatalogEvidence, crmTagRelationSnapshot, crmTerminalStateMatches, expectCrmRejection,
  sameCrmTagRelationSnapshot } from '../suites/crm.mjs'

const record = (checks = []) => ({ checks, notes: [] })
const fact = (name, passed = true) => ({ name, passed })

test('CRM original assertions require named evidence instead of caller-declared indices', () => {
  assert.throws(() => crmCatalogEvidence('CRM-BASE-001', record(), [0, 1, 2, 3]), /绑定/)
  const result = record([fact('win')])
  crmCatalogEvidence('CRM-BASE-001', result, { 2: ['win', 'lose'] })
  assert.equal(result.catalogAssertions[2].status, 'GAP')
  assert.equal(result.passCandidate, false)
  result.checks.push(fact('lose'))
  crmCatalogEvidence('CRM-BASE-001', result, result.catalogCheckBindings)
  assert.equal(result.catalogAssertions[2].status, 'VERIFIED')
  assert.equal(result.catalogAssertions[1].status, 'GAP')
  assert.deepEqual(result.catalogAssertions[2].evidenceChecks, ['win', 'lose'])
})

test('missing, failed, non-boolean, empty or contradictory evidence fails closed', () => {
  for (const checks of [[], [fact('proof', false)], [fact('proof', 'true')],
    [fact('proof'), fact('proof', false)]]) {
    const result = record(checks)
    crmCatalogEvidence('CRM-BASE-001', result, { 0: ['proof'] })
    assert.equal(result.catalogAssertions[0].status, 'GAP')
    assert.equal(result.passCandidate, false)
  }
  for (const names of [[], [''], 'proof', null]) {
    const result = record([fact('proof')])
    crmCatalogEvidence('CRM-BASE-001', result, { 0: names })
    assert.equal(result.catalogAssertions[0].status, 'GAP')
  }
})

test('CRM PASS requires all original assertions and every check to pass', () => {
  const result = record([fact('proof')])
  const bindings = Object.fromEntries([0, 1, 2, 3].map((index) => [index, ['proof']]))
  crmCatalogEvidence('CRM-BASE-001', result, bindings)
  assert.equal(result.passCandidate, true)
  result.checks.push(fact('cleanup', false))
  crmCatalogEvidence('CRM-BASE-001', result, bindings)
  assert.equal(result.passCandidate, false)
})

test('winning and losing require exact non-terminal before/after facts and stable stages', () => {
  const before = { id: '9007199254740993', statusTypeId: '11', statusId: '12',
    executionStatus: 'PENDING', endStatus: null }
  for (const endStatus of [1, 2]) {
    const after = { ...before, endStatus }
    assert.equal(crmTerminalStateMatches(before, after, endStatus), true)
    for (const patch of [{ id: '2' }, { statusTypeId: '2' }, { statusId: '2' },
      { executionStatus: 'WON' }, { executionStatus: null }, { endStatus: null },
      { endStatus: 3 }, { id: Number(before.id) }]) {
      assert.equal(crmTerminalStateMatches(before, { ...after, ...patch }, endStatus), false)
    }
    assert.equal(crmTerminalStateMatches({ ...before, endStatus: 1 }, after, endStatus), false)
    assert.equal(crmTerminalStateMatches({ ...before, executionStatus: '' },
      { ...after, executionStatus: '' }, endStatus), false)
  }
  assert.equal(crmTerminalStateMatches(before, { ...before, endStatus: 3 }, 3), false)
})

test('CRM-BASE-001 cleans every owned terminal fixture with an official readback', () => {
  const source = fs.readFileSync(new URL('../suites/crm.mjs', import.meta.url), 'utf8')
  const scenario = source.slice(source.indexOf('async function crmCase001 ('),
    source.indexOf('async function crmCase002 ('))
  for (const [removePath, getPath] of [
    ['/crm/business/delete?id=${secondBusinessId}', '/crm/business/get?id=${secondBusinessId}'],
    ['/crm/business/delete?id=${businessId}', '/crm/business/get?id=${businessId}'],
    ['/crm/customer/delete?id=${customerId}', '/crm/customer/get?id=${customerId}'],
    ['/system/dict-data/delete?id=${dictId}', '/system/dict-data/get?id=${dictId}']
  ]) {
    assert.ok(scenario.includes(removePath), `missing delete: ${removePath}`)
    assert.ok(scenario.includes(getPath), `missing readback: ${getPath}`)
  }
  assert.match(scenario, /if \(remaining != null\) throw new Error/)
  assert.doesNotMatch(scenario, /try \{ await api\.deleteBusiness\([^\n]+\) \} catch \{\}/)
})

test('CRM-BASE-001 probes disabled execution status through business creation and cleans an erroneous write', () => {
  const source = fs.readFileSync(new URL('../suites/crm.mjs', import.meta.url), 'utf8')
  const scenario = source.slice(source.indexOf('async function crmCase001 ('),
    source.indexOf('async function crmCase002 ('))
  assert.match(scenario, /'POST', '\/crm\/business\/create'/)
  assert.match(scenario, /executionStatus: dictValue/)
  assert.match(scenario, /isBusinessSuccess\(disabledCreate\)/)
  assert.match(scenario, /停用状态新建探针错误接受后已受控清理/)
  assert.match(scenario, /\/crm\/business\/delete\?id=\$\{encodeURIComponent\(leakedId\)\}/)
  assert.match(scenario, /\/crm\/business\/get\?id=\$\{encodeURIComponent\(leakedId\)\}/)
})

test('CRM-BASE-001 and CRM-BASE-003 never reuse a quota-limited customer fixture', () => {
  const source = fs.readFileSync(new URL('../suites/crm.mjs', import.meta.url), 'utf8')
  for (const [start, end] of [
    ['async function crmCase001 (', 'async function crmCase002 ('],
    ['async function crmCase003 (', 'async function crmCase004 (']
  ]) {
    const scenario = source.slice(source.indexOf(start), source.indexOf(end))
    assert.match(scenario, /createCrmCustomerFixture\(api, caseRecord, userId, tag/)
    assert.doesNotMatch(scenario, /createOrReuseCrmCustomerFixture/)
  }
})

test('tag relation snapshots compare every relationship field and reject partial evidence', () => {
  const relation = { id: '10', customerId: '20', tagId: '30', sourceType: 'SYSTEM',
    ruleVersion: 2, evidence: 'rule-v2' }
  assert.deepEqual(crmTagRelationSnapshot([relation]), [relation])
  assert.equal(sameCrmTagRelationSnapshot([relation], [{ ...relation }]), true)
  for (const patch of [{ sourceType: 'MANUAL' }, { ruleVersion: 3 }, { evidence: 'other' },
    { tagId: '31' }, { customerId: '21' }]) {
    assert.equal(sameCrmTagRelationSnapshot([relation], [{ ...relation, ...patch }]), false)
  }
  assert.throws(() => crmTagRelationSnapshot([{ ...relation, id: undefined }]), /稳定身份/)
})

test('system tag rejection requires the exact domain code and message', async () => {
  const expected = { code: 1020024009, message: /系统标签不能由人工直接维护/ }
  const success = record()
  await expectCrmRejection({ request: async () => ({
    code: 1020024009, msg: '系统标签不能由人工直接维护'
  }) }, 'POST', '/crm/customer-tag/relation/add', {}, expected, success, '系统标签拒绝')
  assert.equal(success.checks[0].passed, true)
  const wrongCode = record()
  await expectCrmRejection({ request: async () => ({
    code: 1020024010, msg: '系统标签不能由人工直接维护'
  }) }, 'DELETE', '/crm/customer-tag/relation/remove', {}, expected, wrongCode, '系统标签拒绝')
  assert.equal(wrongCode.checks[0].passed, false)
})

test('CRM rejection matcher accepts a RegExp contract without treating it as an object', async () => {
  const result = record()
  await expectCrmRejection({ request: async () => ({
    code: 1020024009, msg: '系统标签不能由人工直接维护'
  }) }, 'POST', '/crm/customer-tag/relation/add', {}, /系统标签不能由人工直接维护/,
  result, '正则拒绝')
  assert.equal(result.checks[0].passed, true)
})

test('CRM cleanup recognizes official not-found business responses as empty', async () => {
  const result = record()
  await expectCrmRejection({ request: async () => ({
    code: 1020006000, msg: '客户不存在', data: null
  }) }, 'GET', '/crm/customer/get?id=1', {}, /客户不存在/, result, '删除后回读')
  assert.equal(result.checks[0].passed, false)
})

test('CRM-BASE-003 refresh evidence uses exact table cells, not a row text contains check', () => {
  const source = fs.readFileSync(new URL('../suites/crm.mjs', import.meta.url), 'utf8')
  const scenario = source.slice(source.indexOf('async function crmCase003 ('),
    source.indexOf('async function crmCase004 ('))
  assert.match(scenario, /getByText\(secondCode, \{ exact: true \}\)/)
  assert.match(scenario, /visibleCode === secondCode/)
  assert.match(scenario, /visibleName === `\$\{tag\}-UI-UPDATED`/)
  assert.match(scenario, /visibleStatus === '停用'/)
  assert.match(scenario, /el-tag--success/)
  assert.match(scenario, /el-tag--info/)
  assert.doesNotMatch(scenario, /rowText\.includes/)
})

test('CRM-BASE-003 configures an owned SYSTEM definition but never fabricates a system-generated relation', () => {
  const source = fs.readFileSync(new URL('../suites/crm.mjs', import.meta.url), 'utf8')
  const scenario = source.slice(source.indexOf('async function crmCase003 ('),
    source.indexOf('async function crmCase004 ('))
  assert.deepEqual(CRM_CUSTOMER_TAG_SYSTEM_GENERATION_API_SURFACE, [])
  assert.deepEqual(CRM_CUSTOMER_TAG_FORMAL_API_SURFACE, [
    '/crm/customer-tag/definition/create',
    '/crm/customer-tag/definition/update',
    '/crm/customer-tag/definition/delete',
    '/crm/customer-tag/definition/get',
    '/crm/customer-tag/definition/list-enabled',
    '/crm/customer-tag/definition/page',
    '/crm/customer-tag/relation/list',
    '/crm/customer-tag/relation/add',
    '/crm/customer-tag/relation/remove',
    '/crm/customer-tag/relation/change-log',
    '/crm/customer-tag/report/summary'
  ])
  assert.match(scenario, /definition\/page\?pageNo=1&pageSize=100&tagType=SYSTEM/)
  assert.match(scenario, /const enabledSystemDefinition = enabledDefinitions\.find/)
  assert.match(scenario, /const systemDefinition = systemDefinitionPage\.list\.find/)
  assert.match(scenario, /ownedSystemId = crmId\(await api\.postBusiness\('\/crm\/customer-tag\/definition\/create'/)
  assert.match(scenario, /正式配置专属 SYSTEM 定义且未生成系统标签关系/)
  assert.match(scenario, /SYSTEM 定义创建后正式回读关系仍为空，未把定义创建冒充自动生成/)
  assert.match(scenario, /正式 CRM 标签 API 清单不含系统规则生成\/刷新入口/)
  assert.match(scenario, /GAP\/BLOCKED：当前正式 CRM 标签 API/)
  assert.match(scenario, /人工入口伪造 SYSTEM 来源也不能添加系统标签/)
  assert.match(scenario, /sameId\(row\.id, ownedSystemId\)/)
  assert.match(scenario, /const systemRelationRows = await crmSql/)
  assert.match(scenario, /r\.source_type='SYSTEM'/)
  assert.match(scenario, /systemRelationRows\[0\]\[3\] === 'SYSTEM'/)
  assert.match(scenario, /systemRelationRows\[0\]\[7\] === 'SYSTEM'/)
  assert.ok(scenario.indexOf('const systemRelationRows = await crmSql') >
    scenario.indexOf("if (systemDefinition)"))
  assert.doesNotMatch(scenario, /postBusiness\('\/crm\/customer-tag\/relation\/add',\s*\{[^}]*sourceType:\s*'SYSTEM'/)
  assert.match(scenario, /正式 API 也没有系统生成入口，无法安全构造关系，未伪造 SYSTEM 来源以验证人工移除/)
})

test('CRM-BASE-003 cleanup only removes this run\'s MANUAL fixtures and fails loudly on residual data', () => {
  const source = fs.readFileSync(new URL('../suites/crm.mjs', import.meta.url), 'utf8')
  const scenario = source.slice(source.indexOf('async function crmCase003 ('),
    source.indexOf('async function crmCase004 ('))
  const cleanup = scenario.slice(scenario.lastIndexOf('} finally {'))
  assert.match(cleanup, /cleanupOwnedManualDefinition\(secondManualId, '专属第二标签'\)/)
  assert.match(cleanup, /cleanupOwnedManualDefinition\(manualId, '专属第一标签'\)/)
  assert.match(cleanup, /definition\.code !== `\$\{tag\}-SYSTEM`/)
  assert.match(cleanup, /definition\.remark !== tag/)
  assert.match(cleanup, /本轮专属无引用 SYSTEM 定义按所有权清理并回读不可见/)
  assert.match(cleanup, /ownedRelations\.some\(\(row\) => row\.sourceType !== 'MANUAL'\)/)
  assert.match(cleanup, /customerId, tagId, sourceType: 'MANUAL', reason: tag/)
  assert.doesNotMatch(cleanup, /sourceType:\s*'SYSTEM'/)
  assert.match(cleanup, /\/crm\/customer-tag\/relation\/list\?customerId=\$\{encodeURIComponent\(customerId\)\}/)
  assert.match(cleanup, /\/crm\/customer-tag\/relation\/change-log\?customerId=\$\{encodeURIComponent\(customerId\)\}/)
  assert.match(cleanup, /beforeLogIds\.every\(\(id\) => afterLogIds\.has\(id\)\)/)
  assert.match(cleanup, /row\.action === 'REMOVE' && row\.sourceType === 'MANUAL'/)
  assert.match(cleanup, /\/crm\/customer-tag\/definition\/page\?pageNo=1&pageSize=100&code=/)
  assert.match(cleanup, /\/crm\/customer-tag\/definition\/get\?id=\$\{encodeURIComponent\(tagId\)\}/)
  assert.match(cleanup, /\/crm\/customer\/page\?pageNo=1&pageSize=100&name=/)
  assert.match(cleanup, /\/crm\/customer\/get\?id=\$\{encodeURIComponent\(customerId\)\}/)
  assert.match(cleanup, /CRM-BASE-003 专属夹具清理失败/)
  assert.doesNotMatch(cleanup, /catch \{\}/)
})

test('CRM GAP mappings remain attached to the original assertion rather than upgrading it', () => {
  const result = record([fact('config')])
  crmCatalogEvidence('CRM-BASE-004', result, {}, { 0: '缺到期客户' })
  assert.equal(result.catalogAssertions[0].status, 'GAP')
  assert.equal(result.catalogAssertions[0].gap, '缺到期客户')
  assert.equal(result.passCandidate, false)
})
