import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  PLM_ASSERTIONS, PLM_REVERSE_ASSERTIONS, PLM_STAGES, PLM_CONTRACT_GAPS, assertPlmLocalTarget,
  plmId, plmRows, initializePlmAssertions, markPlmAssertion, finalizePlmAssertions,
  createPlmModel, createPlmKnowledgeApi, createPlmIdentity, expectPlmRejection,
  runPlmStages, runPlmKnowledgeReference, runPlmPermissions, runPlmRelease, runPlmPlanReference,
  runPlmMesRelease, runPlmWriteClosure
} from '../fixtures/plm-write-closure.mjs'
import { runCase } from '../suites/plm.mjs'
import { caseOutcome } from '../lib/report.mjs'

const runtime = {
  target: 'local', tenantName: 'CFOR 标准平台', tenantId: '1',
  apiBase: 'http://127.0.0.1:48083', apiUrl: 'http://127.0.0.1:48083/admin-api',
  webBase: 'http://127.0.0.1:9151'
}
const ok = (data) => ({ code: 0, data })
const rejected = (code, msg) => ({ code, msg })
const caseRecord = (id = 'PLM-001') => ({ id, checks: [], evidence: [], notes: [] })
const passed = (record, name) => record.checks.find((check) => check.name === name)?.passed
const clone = (value) => structuredClone(value)

// This simulator models only observed public contracts; no network or SQL is used.
function simulator (options = {}) {
  let sequence = 9007199254741000n
  const nextId = () => String(++sequence)
  const calls = []
  const tables = Object.fromEntries([
    'pms', 'projects', 'products', 'materials', 'parts', 'revisions',
    'eboms', 'processes', 'recipes', 'tasks', 'roles', 'users', 'workItems', 'boms', 'plans', 'routes', 'works'
  ].map((name) => [name, new Map()]))
  const memberLevels = new Map()
  const roleMenus = new Map()
  const userRoles = new Map()
  const secrets = []
  let releaseACount = 0
  let rdmReleaseCount = 0
  const permissions = [
    'pms:pm:project:query', 'pms:pm:project-member:query', 'pms:pm:work-item:query',
    'pms:pm:work-item:create', 'plm:rdm:query'
  ]
  const menus = [
    { id: '100', parentId: 0, name: 'PMS' },
    ...permissions.map((permission, index) => ({ id: String(index + 101), parentId: '100', permission }))
  ]
  const reply = (data) => ok(clone(data))
  const route = async (identity, method, path, body, requestOptions) => {
    const url = new URL(path, 'http://mock')
    const get = (key) => url.searchParams.get(key)
    const pathname = url.pathname
    calls.push({ identity, method, path, body: clone(body), options: requestOptions })
    if (options.throwAt === pathname) throw new Error('mock transport failure')
    if (pathname === '/system/tenant/get-id-by-name') return ok(options.tenantId || '1')
    if (pathname === '/system/user/profile/get') {
      return reply(identity === 'owner'
        ? { id: '1', username: 'admin', nickname: 'Test owner' }
        : tables.users.get(identity))
    }
    if (pathname === '/system/menu/list' || pathname === '/system/menu/list-all-simple') {
      return reply(options.noPermission ? [] : menus)
    }
    if (pathname === '/system/role/create') {
      const id = nextId()
      tables.roles.set(id, { id, ...body })
      return ok(id)
    }
    if (pathname === '/system/permission/assign-role-menu') {
      roleMenus.set(body.roleId, body.menuIds)
      return ok(true)
    }
    if (pathname === '/system/user/create') {
      assert.ok(body.password.length >= 4 && body.password.length <= 16)
      secrets.push(body.password)
      const id = nextId()
      tables.users.set(id, { id, ...body, status: 0 })
      return ok(id)
    }
    if (pathname === '/system/permission/assign-user-role') {
      userRoles.set(body.userId, body.roleIds)
      return ok(true)
    }
    if (pathname === '/system/auth/login-encrypted') {
      assert.equal(requestOptions.encrypted, true)
      if (options.loginFailure) return rejected(401, '用户名或密码错误')
      const user = [...tables.users.values()].find((row) =>
        row.username === body.username && row.password === body.password)
      assert.ok(user)
      if (options.tenantSelection) return ok({})
      return ok({ accessToken: `secret-token-${user.id}`, tenantId: options.loginTenantId || '1' })
    }
    if (pathname === '/system/auth/tenant-options-encrypted') {
      return ok({ selectionTicket: 'secret-selection-ticket' })
    }
    if (pathname === '/system/auth/login-tenant-selection') {
      const user = [...tables.users.values()].at(-1)
      return ok({ accessToken: `secret-token-${user.id}`, tenantId: '1' })
    }
    if (pathname === '/system/auth/get-permission-info') {
      const ids = roleMenus.get(userRoles.get(identity)?.[0]) || []
      return reply({ permissions: menus.filter((row) => ids.includes(row.id)).map((row) => row.permission).filter(Boolean) })
    }
    if (pathname === '/system/user/update-status') {
      tables.users.get(body.id).status = body.status
      return ok(true)
    }
    if (pathname === '/system/role/delete') {
      tables.roles.delete(get('id'))
      return ok(true)
    }
    if (pathname === '/pms/pm/project/create') {
      assert.ok(body.name.length <= 31)
      const id = nextId()
      tables.pms.set(id, { id, ...body, ownerStatus: true })
      return ok(id)
    }
    if (pathname === '/pms/pm/project/get') {
      const project = tables.pms.get(get('id'))
      if (identity === 'owner') return reply(project)
      const level = memberLevels.get(identity)
      if (!level) return rejected(2050200000, '无权访问该项目')
      return reply({ ...project, ownerStatus: false, memberStatus: true, writeStatus: level === 3 })
    }
    if (pathname === '/pms/pm/project-member/update-list') {
      memberLevels.clear()
      for (const member of body.members) memberLevels.set(member.userId, member.level)
      return ok(true)
    }
    if (pathname === '/pms/pm/project-member/list') {
      return reply([...memberLevels].map(([userId, level]) => ({ userId, level })))
    }
    if (pathname === '/pms/pm/project-member/delete') {
      assert.ok(memberLevels.has(get('userId')), 'must not delete the reader twice')
      memberLevels.delete(get('userId'))
      return ok(true)
    }
    if (pathname === '/pms/pm/work-item/create') {
      if (memberLevels.get(identity) !== 3) return rejected(2050200003, '当前项目角色无编辑权限')
      const id = nextId()
      tables.workItems.set(id, { id, ...body })
      return ok(id)
    }
    if (pathname === '/pms/pm/work-item/get') return reply(tables.workItems.get(get('id')))
    if (pathname === '/plm/rdm/record/create') {
      const id = nextId()
      tables[body.bizType === 'PROCESS' ? 'processes' : body.bizType === 'RECIPE' ? 'recipes' : 'projects']
        .set(id, { id, ...body })
      return ok(id)
    }
    if (pathname === '/plm/rdm/record/update') {
      const table = body.bizType === 'PROCESS' ? tables.processes
        : body.bizType === 'RECIPE' ? tables.recipes : tables.projects
      table.set(body.id, { ...table.get(body.id), ...body })
      return ok(true)
    }
    if (pathname === '/plm/rdm/project/ledger/get') {
      if (identity !== 'owner' && options.plmPermissionGuard) return rejected(2050200000, '无权访问该项目')
      const project = clone(tables.projects.get(get('id')))
      if (options.foreignProject) project.remark = 'shared data'
      return reply(project)
    }
    if (pathname === '/plm/rdm/project/ledger/tasks') {
      const stage = get('stageCode')
      const projectId = get('projectId')
      if (options.emptyTasks) return ok([])
      let tasks = [...tables.tasks.values()].filter((row) => row.projectId === projectId && row.stage === stage)
      if (!tasks.length) {
        for (let index = 0; index < 2; index++) {
          const id = nextId()
          tables.tasks.set(id, { id, projectId, stage, status: 'PENDING', progressRate: 0 })
        }
        tasks = [...tables.tasks.values()].filter((row) => row.projectId === projectId && row.stage === stage)
      }
      return reply(tasks)
    }
    if (pathname === '/plm/rdm/project/ledger/task/update') {
      const task = tables.tasks.get(body.taskId)
      Object.assign(task, { status: body.status, progressRate: body.progressRate })
      const tasks = [...tables.tasks.values()].filter((row) => row.projectId === task.projectId && row.stage === task.stage)
      if (tasks.every((row) => row.status === 'DONE') && !options.noAdvance) {
        const next = PLM_STAGES[PLM_STAGES.indexOf(task.stage) + 1]
        Object.assign(tables.projects.get(task.projectId), {
          stageCode: next === 'MASS' ? 'MASS_LAUNCH' : next,
          status: next === 'FINISHED' ? 'ARCHIVED' : 'RUNNING'
        })
      }
      return reply(task)
    }
    if (pathname === '/plm/rdm/record/get') {
      const row = clone((get('bizType') === 'RECIPE' ? tables.recipes : tables.processes).get(get('id')))
      if (options.foreignRecipe && get('bizType') === 'RECIPE') row.projectId = '999'
      return reply(row)
    }
    if (pathname === '/plm/core/product/create') {
      const id = nextId()
      tables.products.set(id, { id, ...body })
      return ok(id)
    }
    if (pathname === '/plm/core/product/get') {
      if (identity !== 'owner' && options.plmPermissionGuard) return rejected(2050200000, '无权访问该项目')
      return reply(tables.products.get(get('id')))
    }
    if (pathname === '/plm/core/product/update' || pathname === '/plm/core/product/status') {
      Object.assign(tables.products.get(body.id), body)
      return ok(true)
    }
    if (pathname === '/mes/basUnit/list/enabled') return reply([{ id: '81', name: 'kg' }])
    if (pathname === '/mes/basMaterialCategory/rootList') {
      return reply({ records: options.noCategory ? [] : [{ id: '82', name: 'E2E read-only category' }] })
    }
    if (pathname === '/mes/basMaterial/add') {
      const id = nextId()
      tables.materials.set(id, { id, ...body })
      return { code: 200, success: true, data: id }
    }
    if (pathname === '/mes/basMaterial/queryById') return reply(tables.materials.get(get('id')))
    if (pathname === '/plm/core/part/create') {
      const id = nextId()
      tables.parts.set(id, { id, ...body })
      return ok(id)
    }
    if (pathname === '/plm/core/part/get') return reply(tables.parts.get(get('id')))
    if (pathname === '/plm/core/part/revision/create') {
      if ([...tables.revisions.values()].some((row) => row.partId === body.partId && row.revisionNo === body.revisionNo)) {
        return rejected(400, '同一零部件下版本号不能重复')
      }
      const id = nextId()
      tables.revisions.set(id, { id, ...body, revisionStatus: 'WIP' })
      return ok(id)
    }
    if (pathname === '/plm/core/part/revision/page') {
      return reply({ list: [...tables.revisions.values()].filter((row) => row.partId === get('partId')) })
    }
    if (pathname === '/plm/core/part/revision/status') {
      Object.assign(tables.revisions.get(body.id), body, { releaseTime: '2026-10-10T12:00:00' })
      return ok(true)
    }
    if (pathname === '/plm/core/ebom/save-line') {
      const parent = tables.revisions.get(body.parentPartRevisionId)
      if (body.id && parent?.revisionStatus === 'RELEASED' && options.immutable) {
        return rejected(400, '已发布版本禁止修改')
      }
      const id = body.id || nextId()
      tables.eboms.set(id, { id, ...body, partVersion: 'A' })
      return ok(id)
    }
    if (pathname === '/plm/core/ebom/tree') {
      return reply([...tables.eboms.values()].filter((row) => row.parentPartRevisionId === get('ebomId')))
    }
    if (pathname === '/plm/core/ebom/downstream-refs') return ok([])
    if (pathname === '/ai/knowledge/document/page') {
      return reply(options.noKnowledge ? [] : [{ id: '71', knowledgeId: '72', content: 'KB BODY MUST NOT BE COPIED' }])
    }
    if (pathname === '/plm/core/baseline/page') {
      return reply({ list: options.baseline ? [{
        id: '91', productId: get('productId'),
        remark: tables.products.get(get('productId')).remark, status: 'DRAFT'
      }] : [{
        id: '92', productId: '999', remark: 'shared data', status: 'RELEASED', versionNo: 'A'
      }] })
    }
    if (pathname === '/plm/core/baseline/get') {
      const product = [...tables.products.values()][0]
      return reply({ id: '91', productId: product.id, remark: product.remark, status: 'DRAFT' })
    }
    if (pathname === '/plm/core/baseline/freeze' || pathname === '/plm/core/baseline/release') {
      return reply({
        id: '91', productId: [...tables.products.keys()][0],
        status: pathname.endsWith('freeze') ? 'FROZEN' : 'RELEASED', freezeTime: '2026-10-10T12:00:00',
        versionNo: options.missingBaselineVersion ? null : 'A', releaseTime: '2026-10-10T12:01:00'
      })
    }
    if (pathname === '/plm/core/ebom/preview-production-bom') {
      const line = [...tables.eboms.values()].find((row) => row.parentPartRevisionId === body.ebomId)
      return reply({ canRelease: false, released: false, blocks: [{
        objectId: line.id, reason: 'BOM 行未审批通过，请先完成变更审批'
      }], blockCount: 1 })
    }
    if (pathname === '/plm/core/ebom/release-production-bom') {
      const revision = tables.revisions.get(body.ebomId)
      const line = [...tables.eboms.values()].find((row) => row.parentPartRevisionId === body.ebomId)
      if (line.approvalStatus !== 'APPROVED') return rejected(400, 'EBOM 存在阻塞项，不能下发生产 BOM')
      if (revision.revisionStatus !== 'RELEASED' && options.wipGuard) return rejected(400, '版本尚未发布')
      const parent = tables.parts.get(revision.partId)
      const component = tables.parts.get(line.componentPartId)
      let bom = [...tables.boms.values()].find((row) =>
        row.header.stockId === parent.materialId &&
        (!options.preserveHistory || row.header.version === revision.revisionNo))
      if (!bom) {
        const id = nextId()
        bom = {
          header: { id, stockId: parent.materialId, version: revision.revisionNo, devStatus: 0 },
          lines: [{ id: nextId(), parentId: id, stockId: component.materialId }]
        }
        tables.boms.set(id, bom)
      }
      bom.header.version = revision.revisionNo
      bom.header.mark = `PLM_EBOM_RELEASE ebomId=${body.ebomId}, operator=${parent.remark}`
      bom.lines[0].subStockCount = line.quantity
      bom.lines[0].mark = `${bom.header.mark}, ebomLineId=${line.id}`
      if (revision.revisionNo === 'A' && revision.revisionStatus === 'RELEASED') {
        releaseACount++
        if (releaseACount > 1 && options.duplicateLines) bom.lines.push({ ...bom.lines[0], id: nextId() })
      }
      return reply({ released: true, dryRun: false, releasedLineCount: 1,
        targetMesBomId: bom.header.id, parentPartRevisionId: body.ebomId })
    }
    if (pathname === '/mes/wmsAssemble/queryById') return reply(tables.boms.get(get('id')).header)
    if (pathname === '/mes/wmsAssemble/queryWmsAssembleSubByMainId') {
      return { code: 200, success: true, data: { records: clone(tables.boms.get(get('id')).lines) } }
    }
    if (pathname === '/mes/prodOrder/add') {
      const bom = tables.boms.get(body.prodOrderSubList[0].wmsAssembleId)
      if (options.draftBomGuard !== false && Number(bom?.header.devStatus) === 0) {
        return rejected(500, 'BOM 未启用，研发状态=0')
      }
      const id = nextId()
      const lines = body.prodOrderSubList.map((row) => ({ ...row, id: nextId(), mid: id }))
      const materials = body.prodOrderMaterialList.map((row) => ({
        ...row, id: nextId(), mid: id, bomTotal: row.quantity
      }))
      tables.plans.set(id, { main: { id, ...body }, lines, materials })
      return { code: 200, success: true, data: id }
    }
    if (pathname === '/mes/prodOrder/queryById') return reply(tables.plans.get(get('id')).main)
    if (pathname === '/mes/prodOrder/queryMesProdOrderSubByMainId') return reply(tables.plans.get(get('id')).lines)
    if (pathname === '/plm/rdm/project/ledger/release-to-mes') {
      const recipe = tables.recipes.get(body.recipeVersionId)
      const process = tables.processes.get(body.processVersionId)
      if (options.rdmDraftGuard && (recipe.status !== 'RELEASED' || process.status !== 'RELEASED')) {
        return rejected(400, '配方或工艺版本尚未发布')
      }
      const project = tables.projects.get(body.projectId)
      const component = [...tables.materials.values()].find((row) => row.code === recipe.items[0].itemCode)
      let route = [...tables.routes.values()].find((row) => row.header.projectId === body.projectId)
      const existing = !!route
      rdmReleaseCount++
      if (!route) {
        const id = nextId()
        route = {
          header: { id, projectId: body.projectId, name: process.bizName, version: 'A', devStatus: 2,
            mark: `来源研发项目[${project.bizNo}]，工艺版本[A]` },
          lines: [{ id: nextId(), parentId: id, procedureId: nextId(),
            procedureName: 'Prepare', relationId: body.targetMaterialId, sortOrder: 1 }]
        }
        tables.routes.set(id, route)
      }
      // RDM uses project-scoped production BOMs; do not pretend this is core EBOM publication.
      let bom = [...tables.boms.values()].find((row) => row.header.projectId === body.projectId)
      if (!bom) {
        const id = nextId()
        bom = {
          header: { id, projectId: body.projectId, stockId: body.targetMaterialId, stockCount: 1,
            version: 'A', devStatus: 2, bomUsage: 'PRODUCTION', defaultTechnique: route.header.id,
            mark: `来源研发项目[${project.bizNo}]，配方版本[A]` },
          lines: [{ id: nextId(), parentId: id, stockId: component.id, subStockCount: 1,
            procedureId: route.lines[0].procedureId, mark: project.remark }]
        }
        tables.boms.set(id, bom)
      }
      if (existing && options.rdmRecreateChildren) {
        route.lines[0].id = nextId()
        bom.lines[0].id = nextId()
      }
      Object.assign(tables.materials.get(body.targetMaterialId), {
        defaultProdBom: bom.header.id, defaultTechnique: route.header.id
      })
      const metadata = JSON.parse(project.dataJson)
      metadata.mesRelease = {
        launchStage: 'PILOT', produceOrigin: '2', targetMaterialId: body.targetMaterialId,
        mesBomId: bom.header.id, mesBomVersion: 'A', mesRouteId: route.header.id, mesRouteVersion: 'A',
        recipeVersionId: recipe.id, recipeVersionNo: 'A', processVersionId: process.id, processVersionNo: 'A',
        releasedAt: options.rdmResetAudit ? `2026-10-10T12:00:0${rdmReleaseCount}` : '2026-10-10T12:00:01',
        releasedBy: 'Test owner', remark: body.remark
      }
      project.dataJson = JSON.stringify(metadata)
      if (options.rdmForeignBom) bom.header.projectId = '999'
      if (options.rdmWrongProcedure) bom.lines[0].procedureId = '999'
      if (options.rdmMissingAudit) delete metadata.mesRelease.recipeVersionId
      project.dataJson = JSON.stringify(metadata)
      return reply({
        projectId: options.rdmForeignResponse ? '999' : body.projectId, launchStage: 'PILOT', produceOrigin: '2',
        targetMaterialId: body.targetMaterialId, mesBomId: bom.header.id, mesRouteId: route.header.id,
        mesBomVersion: 'A', mesRouteVersion: 'A', recipeVersionId: recipe.id, recipeVersionNo: 'A',
        processVersionId: process.id, processVersionNo: 'A', procedureCount: 1, bomItemCount: 1,
        bomValidated: true, bomMissingCount: 0
      })
    }
    if (pathname === '/mes/wmsTechRoute/queryById') return reply(tables.routes.get(get('id')).header)
    if (pathname === '/mes/wmsTechRoute/listMesWmsTechRouteSubByMainId') {
      return reply({ records: tables.routes.get(get('parentId')).lines })
    }
    if (pathname === '/mes/prodOrder/prodBom') {
      assert.equal(body.length, 1)
      const row = body[0]
      const work = row.prodWorkId ? tables.works.get(row.prodWorkId) : null
      const bom = tables.boms.get(work?.assembleBomId || row.versionId)
      const component = tables.materials.get(bom.lines[0].stockId)
      return reply(options.emptyExpansion ? [] : [{
        id: options.wrongExpansion ? row.materialId : component.id, pid: row.materialId,
        defaultRoute: bom.header.defaultTechnique, unitId: component.unitId,
        bomNum: 1, qty: row.num, quantity: row.num, ...(work ? { srcEntryId: work.entryId } : {})
      }])
    }
    if (pathname === '/mes/prodOrderMaterial/queryByMainId') return reply(tables.plans.get(get('mid')).materials)
    if (pathname === '/mes/prodOrder/release-gate') {
      const plan = tables.plans.get(get('prodOrderId'))
      return reply({
        prodOrderId: plan.main.id, enabled: !options.disabledGate,
        passed: options.inconsistentGate ? true : !!options.stockReady,
        items: [
          { code: 'BOM', passed: true },
          { code: 'MATERIAL', passed: !!options.stockReady, details: {
            shortageMaterials: options.stockReady ? [] : [{
              materialId: plan.materials[0].materialId, requiredQty: 1, availableQty: 0, shortageQty: 1
            }]
          } }
        ]
      })
    }
    if (pathname === '/mes/prodOrder/check') {
      assert.equal(body.approvalResultType, '1')
      tables.plans.get(body.id).main.billStage = '24'
      return ok(true)
    }
    if (pathname === '/mes/prodWork/transferWorkOrder') {
      assert.equal(options.stockReady, true, 'never bypass material availability')
      const request = body[0]
      const plan = tables.plans.get(request.prodOrderId)
      assert.equal(plan.main.billStage, '24')
      const id = nextId()
      tables.works.set(id, { id, prodOrderId: plan.main.id, prodOrderSubId: request.prodOrderSubId,
        prodOrderNo: plan.main.billNo, assembleBomId: plan.lines[0].wmsAssembleId,
        materialId: plan.lines[0].materialId, qty: request.qty, bomTotal: options.wrongWorkQty ? 2 : 1,
        batchNo: request.batchNo, entryId: nextId() })
      return ok(true)
    }
    if (pathname === '/mes/prodWork/getWorkByProdOrderId') {
      return reply([...tables.works.values()].filter((row) => row.prodOrderId === get('prodOrderId')))
    }
    if (pathname === '/plm/rdm/project/ledger/relations') {
      const project = tables.projects.get(get('projectId'))
      const materialId = JSON.parse(project.dataJson).mesRelease.targetMaterialId
      const plans = [...tables.plans.values()].filter((row) => row.lines[0].materialId === materialId)
      const works = [...tables.works.values()].filter((row) => plans.some((plan) => plan.main.id === row.prodOrderId))
      return reply({
        projectId: project.id, pilotProdOrderTotal: plans.length, pilotWorkTotal: works.length,
        pilotOrders: plans.map((row) => ({ id: row.main.id, billNo: row.main.billNo, qty: 1, produceOrigin: '研发试量产' })),
        workOrders: options.missingWorkRelation ? [] : works.map((row) => ({
          id: row.id, prodOrderId: row.prodOrderId, qty: row.qty, produceOrigin: '研发试量产'
        }))
      })
    }
    throw new Error(`Unmocked API: ${identity} ${method} ${path}`)
  }
  const client = (identity = 'owner') => ({
    request: (method, path, body, options) => route(identity, method, path, body, options),
    getBusiness: (path) => route(identity, 'GET', path),
    postBusiness: (path, body) => route(identity, 'POST', path, body),
    putBusiness: (path, body) => route(identity, 'PUT', path, body),
    deleteBusiness: (path) => route(identity, 'DELETE', path)
  })
  const factories = []
  const apiFactory = (args) => {
    factories.push(args)
    return client(args.token ? args.token.replace('secret-token-', '') : 'anonymous')
  }
  const api = client()
  const record = caseRecord(options.caseId)
  const model = () => createPlmModel({
    api, caseRecord: record, runtime, writeSafety: async () => {},
    tokenFactory: () => 'abcdef123456'
  })
  return { api, apiFactory, record, model, calls, tables, secrets, factories, memberLevels }
}

test('PLM assertions match original catalog exactly and missing evidence cannot become PASS', () => {
  const catalog = JSON.parse(readFileSync(new URL('../cases/catalog.json', import.meta.url), 'utf8'))
  for (const definition of catalog.suites.find((row) => row.id === 'plm').cases) {
    assert.deepEqual(PLM_ASSERTIONS[definition.id], definition.assertions)
    assert.deepEqual(PLM_REVERSE_ASSERTIONS[definition.id], definition.reverse)
    const record = caseRecord(definition.id)
    initializePlmAssertions(record, definition.id)
    record.checks.push({ name: 'one', passed: true })
    markPlmAssertion(record, 0, ['one', 'missing'])
    assert.equal(finalizePlmAssertions(record).acceptanceComplete, false)
    assert.equal(record.catalogAssertions[0].status, 'GAP')
    assert.equal(record.remainingAssertions.length, 4)
    markPlmAssertion(record, 0, ['one'], '缺受控领域关联')
    assert.equal(finalizePlmAssertions(record).partial, true)
    assert.equal(record.remainingReverseAssertions.length, 1)
  }
})

test('PLM local guard rejects production, wrong ports, wrong tenant and unsafe IDs', () => {
  assert.doesNotThrow(() => assertPlmLocalTarget(runtime))
  for (const change of [
    { target: 'production' }, { tenantName: '福奇科技' }, { tenantId: '2' },
    { apiBase: 'http://example.com:48083' }, { webBase: 'http://127.0.0.1:5173' },
    { apiUrl: 'http://example.com/admin-api' }
  ]) assert.throws(() => assertPlmLocalTarget({ ...runtime, ...change }), /BLOCKED:/)
  assert.equal(plmId('9007199254741001', 'sample'), '9007199254741001')
  for (const id of [9007199254741001, '0', '-1', '1.2', '9223372036854775808', null]) {
    assert.throws(() => plmId(id, 'sample'), /BLOCKED:/)
  }
  assert.throws(() => plmRows(ok({})), /有效对象数组/)
  assert.throws(() => plmRows(rejected(500, '系统异常')))
})

test('PLM preflight blocks every business write when jobs/migrations or tenant checks fail', async () => {
  const sim = simulator()
  await assert.rejects(createPlmModel({ api: sim.api, caseRecord: sim.record, runtime,
    writeSafety: async () => { throw new Error('BLOCKED: enabled jobs') } }), /enabled jobs/)
  assert.equal(sim.calls.length, 0)
  const foreign = simulator({ tenantId: '2' })
  await assert.rejects(foreign.model(), /租户名称与令牌目标不一致/)
  assert.equal(foreign.calls.some((call) => call.method !== 'GET'), false)
})

test('PLM model uses exact public APIs and owned string IDs for PMS/product/parts/EBOM/process', async () => {
  const sim = simulator()
  const fixture = await sim.model()
  assert.equal(sim.record.fixtures.plm, fixture)
  assert.ok(BigInt(fixture.projectId) > BigInt(Number.MAX_SAFE_INTEGER))
  assert.equal(fixture.pmsBody.openStatus, false)
  assert.deepEqual(fixture.projectBody.items.map((row) => row.itemCode), [...PLM_STAGES])
  assert.equal('projectId' in fixture.projectBody, false, 'PMS ID must not be stored as PLM customerId')
  assert.equal(JSON.parse(fixture.projectBody.dataJson).pmsProjectId, fixture.pmsProjectId)
  assert.equal(fixture.lineBody.parentPartRevisionId, fixture.parent.revisionId)
  assert.equal(fixture.lineBody.componentRevisionId, fixture.component.revisionId)
  assert.equal(fixture.processBody.projectId, fixture.projectId)
  assert.equal(sim.record.checks.every((check) => check.passed), true)
  assert.equal(sim.calls.filter((call) => call.path === '/plm/core/part/revision/create').length, 4)
  assert.equal(sim.calls.some((call) => /baseline\/create|route-release-receipt/.test(call.path)), false)
})

test('PLM owned model refuses foreign round trips before further downstream writes', async () => {
  const sim = simulator({ foreignProject: true })
  await assert.rejects(sim.model(), /所有权或写入回读失败/)
  assert.equal(sim.calls.some((call) => call.path === '/plm/core/product/create'), false)
  assert.equal(sim.record.checks.at(-1).passed, false)
})

test('PLM model blocks missing category and foreign recipe before attempting RDM release', async () => {
  const missing = simulator({ noCategory: true })
  await assert.rejects(missing.model(), /缺少物料分类/)
  assert.equal(missing.calls.some((call) => call.path === '/mes/basMaterial/add'), false)
  const foreign = simulator({ foreignRecipe: true })
  await assert.rejects(foreign.model(), /所有权或写入回读失败/)
  assert.equal(foreign.record.checks.at(-1).passed, false)
  assert.equal(foreign.calls.some((call) => call.path.endsWith('release-to-mes')), false)
})

test('PLM stages require real nonempty task completion and eight automatic transitions', async () => {
  const sim = simulator()
  const fixture = await sim.model()
  await runPlmStages({ api: sim.api, fixture, caseRecord: sim.record })
  assert.equal(fixture.stageTransitions.length, 8)
  assert.equal(sim.calls.filter((call) => call.path === '/plm/rdm/project/ledger/task/update').length, 16)
  assert.equal(passed(sim.record, 'PLM 项目阶段推进至 FINISHED 与 ARCHIVED'), true)
  for (const option of [{ emptyTasks: true }, { noAdvance: true }]) {
    const failure = simulator(option)
    const model = await failure.model()
    await assert.rejects(runPlmStages({ api: failure.api, fixture: model, caseRecord: failure.record }))
    assert.equal(passed(failure.record, 'PLM 项目阶段推进至 FINISHED 与 ARCHIVED'), undefined)
    assert.equal(failure.record.checks.at(-1).passed, false)
  }
})

test('PLM knowledge reference preserves only hub IDs, never copies content or opens detail', async () => {
  const sim = simulator()
  const fixture = await sim.model()
  await runPlmKnowledgeReference({ api: sim.api, knowledgeApi: sim.api, fixture, caseRecord: sim.record })
  const update = sim.calls.find((call) => call.path === '/plm/rdm/record/update')
  assert.deepEqual(JSON.parse(update.body.dataJson).knowledgeReferences, [{ knowledgeDocumentId: '71', knowledgeId: '72' }])
  assert.doesNotMatch(JSON.stringify(sim.record), /KB BODY|content/)
  assert.equal(sim.calls.some((call) => /knowledge\/document\/get|parse-detail/.test(call.path)), false)
  assert.ok(sim.record.notes.includes(PLM_CONTRACT_GAPS.knowledge))
  const missing = simulator({ noKnowledge: true })
  const model = await missing.model()
  await runPlmKnowledgeReference({ api: missing.api, fixture: model, caseRecord: missing.record })
  assert.equal(missing.calls.some((call) => call.path === '/plm/rdm/record/update'), false)
  assert.match(missing.record.notes.join(), /缺前置/)
})

test('PLM knowledge client sanitizes success/failure audit bodies without hiding request failures', async () => {
  for (const failure of [false, true]) {
    const audit = { api: [] }
    const client = createPlmKnowledgeApi({ token: 'token', tenantId: '1', record: audit,
      apiFactory: (args) => ({ getBusiness: async () => {
        args.record.api.push({ pathname: '/ai/knowledge/document/page', code: failure ? 500 : 0,
          responseError: failure, bodySummary: 'KB PRIVATE BODY' })
        if (failure) throw new Error('KB PRIVATE BODY')
        return ok([{ id: '71', knowledgeId: '72', content: 'KB PRIVATE BODY' }])
      } }) })
    if (failure) await assert.rejects(client.getBusiness('/ai/knowledge/document/page?pageNo=1&pageSize=100&status=0'), /正文已省略/)
    else assert.deepEqual((await client.getBusiness('/ai/knowledge/document/page?pageNo=1&pageSize=100&status=0')).data,
      [{ id: '71', knowledgeId: '72' }])
    assert.doesNotMatch(JSON.stringify(audit), /PRIVATE BODY/)
    assert.equal(audit.api[0].responseError, failure)
    await assert.rejects(client.getBusiness('/ai/knowledge/document/get?id=71'), /只允许/)
  }
})

test('PLM two identities have the same global permissions but PMS project scope enforces writes', async () => {
  const sim = simulator()
  const fixture = await sim.model()
  const record = { api: [] }
  await runPlmPermissions({ api: sim.api, fixture, caseRecord: sim.record, runtime,
    record, apiFactory: sim.apiFactory })
  assert.equal(passed(sim.record, 'PLM PMS 只读成员具有全局创建权限但项目写入被拒绝'), true)
  assert.equal(passed(sim.record, 'PLM PMS 移除成员后私有项目不可读'), true)
  assert.equal(passed(sim.record, 'PLM 非项目成员不能凭全局查询权限读取研发项目'), false)
  assert.equal(passed(sim.record, 'PLM 非项目成员不能凭全局查询权限读取项目产品'), false)
  assert.equal(sim.calls.filter((call) => call.path.startsWith('/pms/pm/project-member/delete')).length, 2)
  assert.equal([...sim.tables.users.values()].every((user) => user.status === 1), true)
  assert.equal(sim.tables.roles.size, 0)
  assert.deepEqual([...sim.memberLevels.keys()], ['1'])
  for (const args of sim.factories) {
    assert.equal(args.tenantId, '1')
    assert.equal(args.token ? args.record === record : args.record === undefined, true)
  }
  for (const secret of sim.secrets) assert.equal(JSON.stringify(sim.record).includes(secret), false)
  assert.doesNotMatch(JSON.stringify(sim.record), /secret-token|selectionTicket/)
})

test('PLM identity preparation failures clean up owned users/roles and tenant selection remains isolated', async () => {
  const failure = simulator({ loginFailure: true })
  const fixture = await failure.model()
  await assert.rejects(createPlmIdentity({ api: failure.api, fixture, caseRecord: failure.record,
    label: 'reader', runtime, apiFactory: failure.apiFactory }), /business failure/)
  assert.equal(failure.tables.roles.size, 0)
  assert.equal([...failure.tables.users.values()].every((user) => user.status === 1), true)
  const selected = simulator({ tenantSelection: true })
  const model = await selected.model()
  const reader = await createPlmIdentity({ api: selected.api, fixture: model, caseRecord: selected.record,
    label: 'reader', runtime, apiFactory: selected.apiFactory })
  await reader.cleanup()
  assert.ok(selected.calls.some((call) => call.path === '/system/auth/login-tenant-selection'))
  assert.doesNotMatch(JSON.stringify(selected.record), /secret-token|secret-selection/)
})

test('PLM identity wrong tenant or missing permission is blocked and deactivated before membership writes', async () => {
  const wrong = simulator({ loginTenantId: '2' })
  const fixture = await wrong.model()
  await assert.rejects(createPlmIdentity({ api: wrong.api, fixture, caseRecord: wrong.record,
    label: 'reader', runtime, apiFactory: wrong.apiFactory }), /租户不匹配/)
  assert.equal(wrong.tables.roles.size, 0)
  assert.equal([...wrong.tables.users.values()][0].status, 1)
  const missing = simulator({ noPermission: true })
  const model = await missing.model()
  await assert.rejects(createPlmIdentity({ api: missing.api, fixture: model, caseRecord: missing.record,
    label: 'reader', runtime, apiFactory: missing.apiFactory }), /权限菜单/)
  assert.equal(missing.calls.some((call) => call.path === '/system/role/create'), false)
})

test('PLM transport failures during permission checks still clean both identities and keep mapped gaps', async () => {
  const sim = simulator({ throwAt: '/pms/pm/work-item/create' })
  await assert.rejects(runPlmWriteClosure({ caseId: 'PLM-001', api: sim.api, knowledgeApi: sim.api,
    caseRecord: sim.record, runtime, apiFactory: sim.apiFactory,
    writeSafety: async () => {}, tokenFactory: () => 'abcdef123456' }), /transport/)
  assert.equal(sim.tables.roles.size, 0)
  assert.equal([...sim.tables.users.values()].every((row) => row.status === 1), true)
  assert.deepEqual([...sim.memberLevels.keys()], ['1'])
  assert.equal(sim.record.catalogAssertions[2].status, 'GAP')
  assert.match(sim.record.notes.join(), /写侧中断/)
  assert.ok(sim.record.remainingAssertions.includes('成员权限隔离'))
})

test('PLM denial assertions reject service errors, unrelated refusals and unexpected success', async () => {
  for (const response of [
    rejected(500, '系统异常'), rejected(400, '参数错误'), ok({ released: true }), rejected(403, '没有该操作权限')
  ]) {
    const record = caseRecord()
    const result = await expectPlmRejection({ api: { request: async () => response }, method: 'POST', path: '/x',
      expected: { code: 400, message: '版本尚未发布' }, caseRecord: record, name: 'negative' })
    assert.equal(result.passed, false)
  }
  await assert.rejects(expectPlmRejection({ api: { request: async () => { throw new Error('HTTP 500') } },
    method: 'POST', path: '/x', expected: { code: 400, message: '版本尚未发布' }, caseRecord: caseRecord(), name: 'negative' }),
  /HTTP 500/)
})

test('PLM production-plan denial requires unpublished status, not missing BOM, service or auth failure', async () => {
  const fixture = { tag: 'E2E-PLM-abcdef123456', parent: { materialId: '101' } }
  for (const [response, expected] of [
    [rejected(500, '以下物料未配置生产BOM：物料101'), false],
    [rejected(500, '生产BOM系统异常'), false],
    [rejected(403, '没有该操作权限'), false],
    [rejected(500, 'BOM 版本尚未发布'), true],
    [rejected(400, 'BOM 版本尚未启用'), true]
  ]) {
    const record = caseRecord()
    await runPlmPlanReference({ api: { request: async () => response }, fixture, caseRecord: record,
      bomId: '201', label: 'WIP', expectDenied: true })
    assert.equal(passed(record, 'PLM WIP 未发布模型不能被生产计划引用'), expected)
  }
})

test('PLM release writes real MES/plan samples and exposes WIP acceptance and overwritten history', async () => {
  const sim = simulator({ caseId: 'PLM-002', draftBomGuard: false })
  const fixture = await sim.model()
  await runPlmRelease({ api: sim.api, fixture, caseRecord: sim.record })
  assert.equal(passed(sim.record, 'PLM 未审批 EBOM 正式下发拒绝'), true)
  assert.equal(passed(sim.record, 'PLM 父子零件版本尚未发布时正式下发拒绝'), false)
  assert.equal(passed(sim.record, 'PLM WIP 未发布模型不能被生产计划引用'), false)
  assert.equal(passed(sim.record, 'PLM CORE-DRAFT 未发布模型不能被生产计划引用'), false)
  assert.equal(passed(sim.record, 'PLM 重复 EBOM 下发保持同 BOM 同子行与来源数量'), true)
  assert.equal(passed(sim.record, 'PLM B 版正式下发不覆盖 A 版 MES 历史'), false)
  assert.equal(passed(sim.record, 'PLM 已下发 A 版 EBOM 禁止原位保存'), false)
  assert.equal(passed(sim.record, 'PLM 已下发 A 版拒绝原位保存后完整源行不变'), true)
  assert.equal(fixture.planReferences.length, 2)
  assert.equal(sim.tables.eboms.get(fixture.lineId).quantity, 1)
  assert.ok(sim.record.notes.includes(PLM_CONTRACT_GAPS.baseline))
  assert.ok(sim.record.notes.includes(PLM_CONTRACT_GAPS.consumption))
  assert.equal(sim.calls.some((call) => /\/baseline\/(?:freeze|release)$/.test(call.path)), false)
  assert.equal(sim.calls.some((call) => /receipt|delete-line|release-to-mes|\/check$/.test(call.path)), false)
})

test('PLM core draft plan rejection preserves version checks and does not abort RDM release', async () => {
  const sim = simulator({ caseId: 'PLM-002', preserveHistory: true, immutable: true,
    wipGuard: true, rdmDraftGuard: true, stockReady: true })
  const result = await runPlmWriteClosure({ caseId: 'PLM-002', api: sim.api, caseRecord: sim.record,
    runtime, writeSafety: async () => {}, tokenFactory: () => 'abcdef123456' })
  assert.equal(passed(sim.record, 'PLM CORE-DRAFT 未发布模型不能被生产计划引用'), true)
  assert.equal(passed(sim.record, 'PLM 重复 EBOM 下发保持同 BOM 同子行与来源数量'), true)
  assert.equal(passed(sim.record, 'PLM B 版正式下发不覆盖 A 版 MES 历史'), true)
  assert.equal(result.fixture.planReferences.some((row) => row.label === 'CORE-DRAFT'), false)
  assert.equal(result.fixture.mesConsumption.status, 'WORK_CREATED')
  assert.equal(result.acceptanceComplete, false)
})

test('PLM repeat downlink duplicates fail even when HTTP and released flags are successful', async () => {
  const sim = simulator({ duplicateLines: true })
  const fixture = await sim.model()
  await runPlmRelease({ api: sim.api, fixture, caseRecord: sim.record })
  assert.equal(passed(sim.record, 'PLM 重复 EBOM 下发保持同 BOM 同子行与来源数量'), false)
})

test('PLM baseline version absence cannot masquerade as repeat release idempotency', async () => {
  const sim = simulator({ baseline: true, missingBaselineVersion: true })
  const fixture = await sim.model()
  await runPlmRelease({ api: sim.api, fixture, caseRecord: sim.record })
  assert.equal(passed(sim.record, 'PLM 专属基线冻结状态及来源回读'), true)
  assert.equal(passed(sim.record, 'PLM 专属基线发布保留版本与来源'), false)
  assert.equal(passed(sim.record, 'PLM 重复基线发布保留版本与首次发布时间'), false)
})

test('PLM RDM corrected-contract simulation closes enabled BOM/route, real usage, work and project backflow', async () => {
  const sim = simulator({ rdmDraftGuard: true, stockReady: true })
  const fixture = await sim.model()
  await runPlmMesRelease({ api: sim.api, fixture, caseRecord: sim.record })
  assert.equal(passed(sim.record, 'PLM RDM 草稿配方工艺不能下发启用 MES 模型'), true)
  assert.equal(passed(sim.record, 'PLM RDM 重复下发保持主子实体和首次发布审计幂等'), true)
  assert.equal(passed(sim.record, 'PLM MES 正式用料展开消费下发 BOM 工艺和真实数量'), true)
  assert.equal(passed(sim.record, 'PLM MES 正式转工单消费专属计划 BOM 且数量守恒'), true)
  assert.equal(passed(sim.record, 'PLM MES 工单实际物料清单保留源配方用量'), true)
  assert.equal(passed(sim.record, 'PLM MES 正式工单和试量产计划经项目关系 API 回流'), true)
  assert.equal(fixture.mesConsumption.status, 'WORK_CREATED')
  assert.ok(BigInt(fixture.mesConsumption.workId) > BigInt(Number.MAX_SAFE_INTEGER))
  assert.equal(sim.record.checks.every((row) => row.passed), true)
  assert.equal(sim.calls.filter((call) => call.path.endsWith('release-to-mes')).length, 3)
  const statuses = sim.calls.filter((call) => call.path === '/plm/rdm/record/update')
  assert.deepEqual(statuses.map((call) => [call.body.bizType, call.body.id, call.body.status]), [
    ['RECIPE', fixture.recipeId, 'RELEASED'], ['PROCESS', fixture.processId, 'RELEASED']
  ])
  for (const call of statuses) assert.equal(call.body.projectId, fixture.projectId)
  assert.ok(sim.record.notes.includes(PLM_CONTRACT_GAPS.approval))
  assert.equal(sim.calls.some((call) => /start-approval|receipt|inventory|\/delete/.test(call.path)), false)
})

test('PLM RDM source-behavior simulation exposes accepted drafts, regenerated children and missing stock', async () => {
  const sim = simulator({ rdmRecreateChildren: true, rdmResetAudit: true })
  const fixture = await sim.model()
  await runPlmMesRelease({ api: sim.api, fixture, caseRecord: sim.record })
  assert.equal(passed(sim.record, 'PLM RDM 草稿配方工艺不能下发启用 MES 模型'), false)
  assert.ok(fixture.prematureRdmRelease)
  assert.equal(passed(sim.record, 'PLM RDM 重复下发保持主子实体和首次发布审计幂等'), false)
  assert.equal(passed(sim.record, 'PLM MES 下达门禁识别正式下发 BOM 已启用'), true)
  assert.equal(passed(sim.record, 'PLM MES 缺料门禁返回真实专属子件缺口'), true)
  assert.equal(fixture.mesConsumption.status, 'BLOCKED')
  assert.equal(sim.calls.some((call) => /prodOrder\/check|transferWorkOrder/.test(call.path)), false)
  assert.match(sim.record.notes.join(), /草稿.*启用 MES|未伪填 claimed/)
  const materials = sim.calls.find((call) => call.path === '/mes/prodOrder/add').body.prodOrderMaterialList
  assert.equal(materials.length, 1)
  assert.equal(materials[0].claimed, 0)
  const idempotency = sim.record.checks.find((row) => row.name === 'PLM RDM 重复下发保持主子实体和首次发布审计幂等')
  const details = JSON.parse(idempotency.details)
  assert.equal(details.firstBomId, details.repeatedBomId)
  assert.notDeepEqual(details.firstBomLineIds, details.repeatedBomLineIds)
  assert.notDeepEqual(details.firstRouteNodeIds, details.repeatedRouteNodeIds)
  assert.notEqual(details.firstReleasedAt, details.repeatedReleasedAt)
})

for (const change of [{ rdmRecreateChildren: true }, { rdmResetAudit: true }]) {
  test(`PLM repeat RDM downlink rejects independent idempotency regression ${Object.keys(change)[0]}`, async () => {
    const sim = simulator({ rdmDraftGuard: true, ...change })
    const fixture = await sim.model()
    await runPlmMesRelease({ api: sim.api, fixture, caseRecord: sim.record })
    assert.equal(passed(sim.record, 'PLM RDM 重复下发保持主子实体和首次发布审计幂等'), false)
  })
}

for (const option of [
  'rdmForeignResponse', 'rdmForeignBom', 'rdmWrongProcedure', 'rdmMissingAudit',
  'wrongExpansion', 'emptyExpansion', 'disabledGate', 'wrongWorkQty'
]) {
  test(`PLM RDM downstream ${option} cannot become executable closure evidence`, async () => {
    const sim = simulator({ rdmDraftGuard: true, stockReady: true, [option]: true })
    const fixture = await sim.model()
    await assert.rejects(runPlmMesRelease({ api: sim.api, fixture, caseRecord: sim.record }),
      /所有权或写入回读失败/)
    assert.equal(sim.record.checks.at(-1).passed, false)
    assert.notEqual(fixture.mesConsumption?.status, 'WORK_CREATED')
    assert.equal(passed(sim.record, 'PLM MES 正式工单和试量产计划经项目关系 API 回流'), undefined)
  })
}

test('PLM inconsistent material gate cannot trigger approval or manufacture work creation', async () => {
  const sim = simulator({ rdmDraftGuard: true, inconsistentGate: true })
  const fixture = await sim.model()
  await assert.rejects(runPlmMesRelease({ api: sim.api, fixture, caseRecord: sim.record }),
    /下达门禁识别正式下发 BOM/)
  assert.equal(sim.calls.some((call) => /prodOrder\/check|transferWorkOrder/.test(call.path)), false)
})

test('PLM missing work relation remains a failed check despite successful work creation', async () => {
  const sim = simulator({ rdmDraftGuard: true, stockReady: true, missingWorkRelation: true })
  const fixture = await sim.model()
  await runPlmMesRelease({ api: sim.api, fixture, caseRecord: sim.record })
  assert.equal(passed(sim.record, 'PLM MES 正式转工单消费专属计划 BOM 且数量守恒'), true)
  assert.equal(passed(sim.record, 'PLM MES 正式工单和试量产计划经项目关系 API 回流'), false)
})

test('PLM RDM transport failure propagates and finalizes missing evidence rather than manufacturing denial', async () => {
  const sim = simulator({ caseId: 'PLM-002', throwAt: '/plm/rdm/project/ledger/release-to-mes' })
  await assert.rejects(runPlmWriteClosure({ caseId: 'PLM-002', api: sim.api, caseRecord: sim.record,
    runtime, writeSafety: async () => {}, tokenFactory: () => 'abcdef123456' }), /transport/)
  assert.equal(passed(sim.record, 'PLM RDM 草稿配方工艺不能下发启用 MES 模型'), undefined)
  assert.equal(sim.record.catalogComplete, false)
  assert.equal(sim.record.catalogAssertions[1].status, 'GAP')
  assert.equal(sim.record.catalogAssertions[2].status, 'GAP')
  assert.match(sim.record.notes.join(), /写侧中断/)
})

test('PLM reverse gaps block completion even when every original forward assertion has checks', () => {
  for (const id of Object.keys(PLM_ASSERTIONS)) {
    const record = caseRecord(id)
    initializePlmAssertions(record, id)
    for (let index = 0; index < record.catalogAssertions.length; index++) {
      const name = `forward-${index}`
      record.checks.push({ name, passed: true })
      markPlmAssertion(record, index, [name])
    }
    const outcome = finalizePlmAssertions(record)
    assert.equal(record.remainingAssertions.length, 0)
    assert.deepEqual(record.remainingReverseAssertions, PLM_REVERSE_ASSERTIONS[id])
    assert.equal(outcome.partial, true)
    assert.equal(outcome.acceptanceComplete, false)
  }
})

test('PLM simulated MES work closure still cannot certify missing core/ERP/approval and deletion contracts', async () => {
  const sim = simulator({ caseId: 'PLM-002', preserveHistory: true, immutable: true, wipGuard: true,
    baseline: true, rdmDraftGuard: true, stockReady: true })
  const result = await runPlmWriteClosure({ caseId: 'PLM-002', api: sim.api, caseRecord: sim.record,
    runtime, writeSafety: async () => {}, tokenFactory: () => 'abcdef123456' })
  assert.equal(result.fixture.mesConsumption.status, 'WORK_CREATED')
  assert.equal(sim.record.checks.every((row) => row.passed), true)
  assert.equal(sim.record.catalogAssertions[2].status, 'VERIFIED')
  assert.equal(sim.record.catalogAssertions[1].status, 'GAP')
  assert.deepEqual(sim.record.remainingReverseAssertions, PLM_REVERSE_ASSERTIONS['PLM-002'])
  assert.ok(sim.record.notes.includes(PLM_CONTRACT_GAPS.approval))
  assert.match(sim.record.notes.join(), /downstream-refs.*为空/)
  assert.equal(result.acceptanceComplete, false)
  assert.equal(result.partial, true)
})

test('PLM safe new-version behavior is independently verifiable but absent formal consumption stays GAP', async () => {
  const sim = simulator({ caseId: 'PLM-002', preserveHistory: true, immutable: true, wipGuard: true, baseline: true })
  const result = await runPlmWriteClosure({ caseId: 'PLM-002', api: sim.api, caseRecord: sim.record, runtime,
    writeSafety: async () => {}, tokenFactory: () => 'abcdef123456' })
  assert.equal(passed(sim.record, 'PLM 父子零件版本尚未发布时正式下发拒绝'), true)
  assert.equal(passed(sim.record, 'PLM B 版正式下发不覆盖 A 版 MES 历史'), true)
  assert.equal(passed(sim.record, 'PLM 已下发 A 版 EBOM 禁止原位保存'), true)
  assert.equal(passed(sim.record, 'PLM 已下发 A 版拒绝原位保存后完整源行不变'), true)
  assert.equal(sim.record.catalogAssertions[2].status, 'VERIFIED',
    '重复下发幂等有独立证据，不应因其他消费缺口被误判')
  assert.equal(result.partial, true)
  assert.equal(result.acceptanceComplete, false)
  assert.equal(sim.record.catalogAssertions[1].status, 'GAP')
  assert.ok(sim.record.notes.some((note) => note.includes('PLM-001 尚未完整验收')))
})

test('PLM-001 complete mock execution retains source-confirmed association/version/knowledge gaps', async () => {
  const sim = simulator({ plmPermissionGuard: true })
  const result = await runPlmWriteClosure({ caseId: 'PLM-001', api: sim.api, knowledgeApi: sim.api,
    caseRecord: sim.record, runtime, apiFactory: sim.apiFactory, writeSafety: async () => {},
    tokenFactory: () => 'abcdef123456' })
  assert.equal(result.acceptanceComplete, false)
  assert.equal(result.partial, true)
  assert.equal(sim.record.catalogAssertions[2].status, 'VERIFIED')
  assert.deepEqual(sim.record.remainingAssertions, ['项目阶段完整', '产品/BOM/工艺版本可追溯', '不复制知识正文'])
  assert.equal(sim.tables.roles.size, 0)
})

function mockPage () {
  let url = runtime.webBase
  let value = ''
  const actions = []
  const locator = {
    first: () => locator,
    fill: async (text) => { value = text; actions.push(['fill', text]) },
    click: async () => { actions.push(['click']) },
    filter: () => locator,
    waitFor: async () => {},
    innerText: async () => value
  }
  return { actions, url: () => url, navigate: (path) => { url = `${runtime.webBase}${path}` },
    getByPlaceholder: () => locator, getByRole: () => locator, locator: () => locator }
}

test('PLM suite reuses one login context and opens actual menu routes showing owned samples', async () => {
  const record = caseRecord()
  const page = mockPage()
  const calls = []
  const result = await runCase({ caseId: 'PLM-001', page, record: { api: [] }, caseRecord: record, outputDir: '/tmp/mock' }, {
    runtime,
    login: async (_, options) => { calls.push(['login', options]); return { token: 'owner-token', tenantId: '1' } },
    createApiClient: (args) => {
      calls.push(['api', args])
      return { getBusiness: async () => ok({ menus: [{
        path: '/plm', children: [
          { path: 'product', component: 'plm/core/product-ledger/index' },
          { path: 'project', component: 'plm/rdm/project/project-ledger/index' }
        ]
      }] }) }
    },
    runPlmWriteClosure: async (args) => {
      assert.equal(args.runtime.tenantId, '1')
      assert.ok(args.knowledgeApi)
      return { fixture: { productNo: 'owned-product', projectBody: { bizNo: 'owned-project' } },
        partial: true, acceptanceComplete: false }
    },
    openRoute: async (_, path, options) => { calls.push(['route', path, options]); page.navigate(path) },
    saveScreenshot: async (_, __, name) => { calls.push(['shot', name]) }
  })
  assert.equal(calls.filter(([name]) => name === 'login').length, 1)
  assert.deepEqual(calls.find(([name]) => name === 'login')[1], { returnContext: true })
  assert.deepEqual(calls.filter(([name]) => name === 'route').map(([, path]) => path), ['/plm/product', '/plm/project'])
  assert.deepEqual(page.actions.filter(([name]) => name === 'fill').map(([, value]) => value), ['owned-product', 'owned-project'])
  assert.equal(record.checks.every((check) => check.passed), true)
  assert.equal(result.acceptanceComplete, false)
})

test('PLM suite missing menu and service-origin/tenant mismatch cannot be reported complete', async () => {
  const page = mockPage()
  const record = caseRecord('PLM-002')
  const dependencies = {
    runtime, login: async () => ({ token: 'owner-token', tenantId: '1' }),
    createApiClient: () => ({ getBusiness: async () => ok({ menus: [] }) }),
    runPlmWriteClosure: async ({ caseRecord }) => {
      caseRecord.catalogAssertions = [{ assertion: 'mock assertion', status: 'VERIFIED', evidenceChecks: ['API'] }]
      return { fixture: { productNo: 'owned-product' }, partial: false, acceptanceComplete: true }
    }
  }
  const result = await runCase({ caseId: 'PLM-002', page, caseRecord: record }, dependencies)
  assert.equal(result.acceptanceComplete, false)
  assert.equal(result.partial, true)
  assert.match(result.note, /权限菜单/)
  assert.equal(record.catalogAssertions[0].status, 'GAP')
  await assert.rejects(runCase({ caseId: 'PLM-002', page, caseRecord: caseRecord() }, {
    ...dependencies, login: async () => ({ token: 'token', tenantId: '2' })
  }), /BLOCKED:/)
  await assert.rejects(runCase({ caseId: 'PLM-002', page, caseRecord: caseRecord() }, {
    ...dependencies, login: async () => ({ token: 'token', tenantId: '' })
  }), /登录缺少/)
  await assert.rejects(runCase({ caseId: 'PLM-002', page, caseRecord: caseRecord() }, {
    ...dependencies, runtime: { ...runtime, target: 'production' },
    login: async () => { throw new Error('must not login') }
  }), /只允许本地/)
})

test('PLM runtime failure checks win over partial classification without modifying runner/catalog', () => {
  const result = caseOutcome({ failedChecks: [{ name: 'WIP rejected', passed: false }], partial: true,
    hasAssertions: true, result: { partial: true, acceptanceComplete: false } })
  assert.equal(result.status, 'FAIL')
})
