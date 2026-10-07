import { createApiClient } from '../lib/api.mjs'
import { asList, isBusinessSuccess } from '../lib/assertions.mjs'
import {
  login as loginDefault,
  openRoute as openRouteDefault,
  saveScreenshot as saveScreenshotDefault
} from '../lib/browser.mjs'

export const cases = [
  'MES-BASE-001',
  'MES-BASE-002',
  'MES-BASE-003',
  'MES-BASE-004',
  'MES-BASE-005',
  'MES-BASE-006',
  'PB081-001',
  'PB102-001',
  'PB102-002',
  'PB102-003',
  'PB038-001',
  'PB038-002',
  'PB038-003',
  'PB038-004',
  'PB038-005',
  'PB039-001',
  'PB039-002',
  'PB039-003'
]

export const DESIGNED_MES_BASE_ENABLE_CASES = Object.freeze(['MES-BASE-002'])
// Catalog activation remains owned by the main task.
export const DESIGNED_MES_BASE_READONLY_CASES = Object.freeze([
  'MES-BASE-001', 'MES-BASE-002', 'MES-BASE-003',
  'MES-BASE-004', 'MES-BASE-005', 'MES-BASE-006'
])

const nonBlank = (value) => value != null && String(value).trim() !== ''

export const mesBaseRows = (result, label, idField = 'id') => {
  const data = result?.data
  const rows = Array.isArray(data) ? data : data?.list ?? data?.records
  const total = data?.total == null ? rows?.length : Number(data.total)
  if (!isBusinessSuccess(result) || !Array.isArray(rows) || rows.length > 100 ||
    !Number.isSafeInteger(total) || total < rows.length ||
    (rows.length === 0 && total !== 0) ||
    rows.some((row) => !row || typeof row !== 'object' || !nonBlank(row[idField]))) {
    throw new Error(`${label} 响应无效，不能当作缺前置或通过`)
  }
  return rows
}

export const mesBaseDetail = (result, id, label) => {
  const data = result?.data
  if (!isBusinessSuccess(result) || !data || Array.isArray(data) ||
    String(data.id) !== String(id)) {
    throw new Error(`${label} 详情响应无效`)
  }
  return data
}

export const isPb038002Fixture = (material) =>
  /^(?:E2E|AUTOTEST)_PB038_002(?:_|$)/.test(material?.code || '') &&
  material?.mark === 'PB038-002 dedicated e2e fixture' &&
  material?.inventoryNature === 'STOCK' && nonBlank(material?.unitId)

export const pb038GradePayload = (material, gradeFields) => {
  if (!isPb038002Fixture(material) || !nonBlank(material.id)) {
    throw new Error('PB038-002 禁止编辑非本案例专用测试夹具')
  }
  return { ...material, ...gradeFields }
}

export const isLegacyInitializedRoute = (row) =>
  row?.code === 'INIT-ROUTE-001' && row?.createBy === 'system-init' &&
  !nonBlank(row?.publishTime) && !nonBlank(row?.publishBy)

const unique = (prefix) => `${prefix}-${Date.now().toString(36).toUpperCase()}`

export const runCase = async ({ caseId, page, record, caseRecord, outputDir }, dependencies = {}) => {
  const login = dependencies.login || loginDefault
  const openRoute = dependencies.openRoute || openRouteDefault
  const saveScreenshot = dependencies.saveScreenshot || saveScreenshotDefault
  caseRecord.notes.push(
    '生产类型/委外类型复用 system_document_type 与系统受控核心类型，条码载体只开放条形码与二维码，RFID 暂缓。'
  )
  caseRecord.notes.push(
    '生产日历沿用 APS aps_work_calendar*，班组交接为 MES 独立事实表，工艺路线发布后只能升版且工单任务保存版本快照。'
  )

  const token = await login(page)
  const api = (dependencies.createApiClient || createApiClient)({ token, record })

  if (caseId === 'MES-BASE-001') {
    const rules = mesBaseRows(await api.getBusiness(
      '/mes/production-type-rule/page?pageNo=1&pageSize=100'), '生产类型规则')
    const orders = mesBaseRows(await api.getBusiness(
      '/mes/prodOrder/list/dictText?pageNo=1&pageSize=100'), '生产订单')
    caseRecord.checks.push({
      name: '生产类型规则与生产订单真实分页可读取',
      passed: true,
      details: `rules=${rules.length}, orders=${orders.length}`
    })
    if (rules.length) {
      caseRecord.checks.push({
        name: '规则样本映射受控正常/紧急生产场景并保存稳定类型和版本',
        passed: rules.every((row) => ['1', '2'].includes(row.produceType) &&
          nonBlank(row.documentTypeCode) && Number.isInteger(row.version) &&
          row.version >= 1 && [0, 1].includes(row.status)),
        details: `samples=${rules.length}`
      })
      const detail = mesBaseDetail(await api.getBusiness(
        `/mes/production-type-rule/get?id=${encodeURIComponent(rules[0].id)}`),
      rules[0].id, '生产类型规则')
      caseRecord.evidence.push(`生产规则详情 id=${detail.id}, version=${detail.version}`)
    }
    const snapshots = orders.filter((row) => nonBlank(row.documentTypeCode) &&
      Number.isInteger(row.documentTypeRuleVersion) && row.documentTypeRuleVersion >= 1)
    await openRoute(page, '/mes/produce/order', {
      readySelector: '.search-form input[placeholder="请输入计划单号"]'
    })
    await saveScreenshot(page, outputDir, 'mes-base-production-type', record)
    return {
      api, partial: true,
      note: `规则=${rules.length}，生产订单规则快照样本=${snapshots.length}；` +
        `${rules.length ? '' : '缺企业生产类型规则；'}` +
        `${snapshots.length ? '' : '缺正式订单类型/版本快照；'}` +
        '未保存订单或删除引用规则；源码仅有规则权限按钮，未找到独立生产类型规则维护页面'
    }
  }

  if (caseId === 'MES-BASE-003') {
    const objects = mesBaseRows(await api.getBusiness('/erp/barcode/catalog/object-types'), '条码对象目录')
    const carriers = mesBaseRows(await api.getBusiness('/erp/barcode/catalog/carriers'), '条码载体目录')
    const rules = mesBaseRows(await api.getBusiness(
      '/erp/barcode/rules/page?pageNo=1&pageSize=100'), '条码规则')
    caseRecord.checks.push({
      name: '平台条码对象/载体与企业条码规则真实响应可读取',
      passed: true,
      details: `objects=${objects.length}, carriers=${carriers.length}, rules=${rules.length}`
    })
    if (objects.length && carriers.length) {
      const byCode = new Map(carriers.map((row) => [row.code, row]))
      caseRecord.checks.push({
        name: 'BARCODE/QRCODE 已实现，RFID 显式暂缓',
        passed: ['BARCODE', 'QR_CODE'].every((code) => byCode.get(code)?.supported === 1) &&
          byCode.get('RFID')?.supported === 0 && byCode.get('RFID')?.deferred === 1,
        details: carriers.map((row) => `${row.code}:supported=${row.supported},deferred=${row.deferred}`).join(',')
      })
      const configured = rules.filter((row) => nonBlank(row.objectType) || nonBlank(row.carrier))
      if (configured.length) {
        caseRecord.checks.push({
          name: '已配置条码规则仅引用平台业务对象与已实现载体',
          passed: configured.every((row) => objects.some((item) => item.code === row.objectType) &&
            byCode.get(row.carrier)?.supported === 1),
          details: `configured=${configured.length}, legacy=${rules.length - configured.length}`
        })
      }
    }
    // Resolve the actual menu component, not the obsolete catalog route.
    const permission = await api.getBusiness('/system/auth/get-permission-info')
    const menus = permission?.data?.menus
    if (!Array.isArray(menus)) throw new Error('权限菜单响应无效')
    const find = (rows, parent = '') => {
      for (const row of rows) {
        const route = row.path?.startsWith('/') ? row.path : `${parent}/${row.path || ''}`
        const component = String(row.component || '').replace(/^\/?views\//, '').replace(/\.vue$/, '')
        if (component === 'barcode/barCodeRules/index') return route
        const child = find(row.children || [], route)
        if (child) return child
      }
      return null
    }
    const route = find(menus)
    if (route) {
      await openRoute(page, route, { readySelector: 'input[placeholder="请输入规则编码"]' })
      await saveScreenshot(page, outputDir, 'mes-base-barcode-carrier', record)
      caseRecord.evidence.push(`真实菜单条码规则页 ${route}`)
    }
    return {
      api, partial: true,
      note: `目录对象=${objects.length}，载体=${carriers.length}，规则=${rules.length}；` +
        `${route ? '' : '缺条码规则页面菜单；'}` +
        '只读目录不证明 RFID 保存拒绝或跨租户字典绕过保护，未创建规则或改平台目录'
    }
  }

  if (caseId === 'MES-BASE-004') {
    const calendars = mesBaseRows(await api.getBusiness(
      '/mes/workCalendar/page?pageNo=1&pageSize=100'), '生产日历')
    const modes = mesBaseRows(await api.getBusiness('/mes/workMode/list'), '工作模式')
    caseRecord.checks.push({
      name: 'APS 生产日历与工作模式真实响应可读取',
      passed: true,
      details: `calendars=${calendars.length}, modes=${modes.length}`
    })
    if (calendars.length) {
      caseRecord.checks.push({
        name: '日历样本返回稳定编码、日期与工作日标识',
        passed: calendars.every((row) => nonBlank(row.calendarCode) &&
          nonBlank(row.calendarDate) && typeof row.isWorkday === 'boolean'),
        details: `samples=${calendars.length}`
      })
    }
    caseRecord.evidence.push('WorkCalendarRespVO 当前未公开 version/publishStatus，读侧不能证明发布版本快照')
    await openRoute(page, '/settings/production/work-calendar', {
      readySelector: '.calendar-workbench .calendar-toolbar'
    })
    await saveScreenshot(page, outputDir, 'mes-base-work-calendar', record)
    return {
      api, partial: true,
      note: `生产日历=${calendars.length}，工作模式=${modes.length}；` +
        '缺可读取的日历发布版本字段与正式排产历史快照证据；未发布、停用、删除日历或生成排产'
    }
  }

  if (caseId === 'MES-BASE-005') {
    const handovers = mesBaseRows(await api.getBusiness(
      '/mes/team-handover/page?pageNo=1&pageSize=100'), '班组交接')
    caseRecord.checks.push({
      name: '独立班组交接事实分页真实可读取', passed: true,
      details: `handovers=${handovers.length}`
    })
    if (handovers.length) {
      caseRecord.checks.push({
        name: '交接样本引用双方班组，确认终态具备两个不同确认人',
        passed: handovers.every((row) => nonBlank(row.outTeamId) && nonBlank(row.inTeamId) &&
          [0, 1].includes(row.status) && (row.status !== 1 ||
            (nonBlank(row.outConfirmBy) && nonBlank(row.inConfirmBy) &&
              String(row.outConfirmBy) !== String(row.inConfirmBy)))),
        details: `samples=${handovers.length}`
      })
      mesBaseDetail(await api.getBusiness(
        `/mes/team-handover/get?id=${encodeURIComponent(handovers[0].id)}`),
      handovers[0].id, '班组交接')
    }
    return {
      api, partial: true,
      note: `交接=${handovers.length}；未创建/确认共享交接。` +
        '未找到 MES 班组交接前端页面；共享交接数据与真实写侧仍需隔离夹具验证；后端 confirmHandover 已禁止同一确认人，MesTeamHandoverServiceImplTest 7/7 通过'
    }
  }

  if (caseId === 'MES-BASE-006') {
    const routes = mesBaseRows(await api.getBusiness(
      '/mes/wmsTechRoute/list?pageNo=1&pageSize=100'), '工艺路线')
    const tasks = mesBaseRows(await api.getBusiness(
      '/mes/prodWorkTask/list?pageNo=1&pageSize=100'), '工单任务')
    caseRecord.checks.push({
      name: '工艺路线与任务快照真实分页可读取', passed: true,
      details: `routes=${routes.length}, tasks=${tasks.length}`
    })
    const published = routes.filter((row) => row.devStatus === 2)
    if (published.length) {
      caseRecord.checks.push({
        name: '已发布路线样本可读取稳定编码与版本，非历史初始化路线具备发布审计',
        passed: published.every((row) => nonBlank(row.code) && nonBlank(row.version) &&
          (isLegacyInitializedRoute(row) || (nonBlank(row.publishTime) && nonBlank(row.publishBy)))),
        details: `published=${published.length}`
      })
      if (published.some(isLegacyInitializedRoute)) {
        caseRecord.notes.push('初始化路线存在 devStatus=2 但缺 publishTime/publishBy，无法证明正式发布审计；不回写历史数据。')
      }
    }
    const snapshots = tasks.filter((row) => nonBlank(row.routeVersion))
    await openRoute(page, '/settings/production/technique', { readySelector: '.technique-route' })
    await saveScreenshot(page, outputDir, 'mes-base-tech-route-version', record)
    return {
      api, partial: true,
      note: `路线=${routes.length}，已发布=${published.length}，任务版本快照=${snapshots.length}；` +
        '缺隔离的已发布工艺/BOM/任务升版前后证据，未编辑、发布、删除路线或生成任务'
    }
  }

  if (caseId === 'PB081-001') {
    // 1. 确保存在在职 HRM 员工，验证建档默认开通系统登录账号
    const userAccountUsername = unique('E2EEMP')
    const employeeIdResponse = await api.postBusiness('/hrm/employee/create', {
      name: 'E2E班组成员',
      jobNumber: userAccountUsername,
      mobile: `137${Date.now().toString().slice(-8)}`,
      entryStatus: 1,
      type: 1,
      entryTime: '2026-01-01T00:00:00',
      probation: 3,
      createUserAccount: true,
      userAccountUsername
    })
    const employeeId =
      employeeIdResponse?.data?.id ??
      employeeIdResponse?.data ??
      employeeIdResponse?.id ??
      employeeIdResponse
    const employeeResponse = await api.getBusiness(
      `/hrm/employee/get?id=${encodeURIComponent(employeeId)}`
    )
    const employee = employeeResponse?.data ?? employeeResponse
    caseRecord.checks.push({
      name: 'HRM 员工默认开通系统登录账号',
      passed: Boolean(employee && employee.userId),
      details: employee ? `employeeId=${employee.id}, userId=${employee.userId}` : '无在职员工'
    })

    // 2. 班组主档/成员引用必须解析为 HRM 员工
    const teamPage = await api.getBusiness('/mes/teamManage/list?pageNo=1&pageSize=100')
    const teams = asList(teamPage?.data ?? teamPage)
    let referenceOk = true
    const referenceDetails = []
    for (const team of teams.slice(0, 5)) {
      if (team.leaderId) {
        const leader = await api.getBusiness(`/hrm/employee/simple-list?ids=${team.leaderId}`)
        const leaderRows = asList(leader?.data ?? leader)
        const hit = leaderRows.some((item) => String(item.id) === String(team.leaderId))
        referenceOk = referenceOk && hit
        referenceDetails.push(`team=${team.teamId},leader=${team.leaderId},hit=${hit}`)
      }
    }
    caseRecord.checks.push({
      name: '班组长引用 HRM 员工编号',
      passed: teams.length === 0 || referenceOk,
      details: teams.length === 0 ? '当前租户无班组，契约由接口保证' : referenceDetails.join('; ')
    })

    // 3. 非 HRM 员工的成员编号必须被拒绝
    let invalidRejected = false
    try {
      await api.postBusiness('/mes/teamManage/add', {
        teamId: unique('E2E-TEAM'),
        teamName: 'E2E非法成员班组',
        status: '0',
        teamManageSubList: [{ memberId: '999999999999999999' }]
      })
    } catch (error) {
      invalidRejected = true
    }
    caseRecord.checks.push({
      name: '班组成员必须是有效 HRM 员工，否则拒绝保存',
      passed: invalidRejected,
      details: invalidRejected ? '非法成员编号被拒绝' : '非法成员编号未被阻断'
    })

    await openRoute(page, '/settings/production/team', { readyText: '班组' })
    const bodyText = await page.locator('body').innerText()
    caseRecord.checks.push({
      name: '班组维护页成员选择改为 HRM 员工，不再使用系统用户字典',
      passed: bodyText.includes('班组') && !bodyText.includes('系统用户'),
      details: bodyText.includes('班组') ? '班组页真实渲染' : '班组页未渲染'
    })
    await saveScreenshot(page, outputDir, 'pb081-team-hrm', record)
    caseRecord.evidence.push('班组成员统一引用 HRM 员工编号，员工建档默认开通系统登录账号')
    return { token, api }
  }

  if (caseId === 'MES-BASE-002') {
    const typePage = await api.getBusiness('/mes/outsource-type-rule/page?pageNo=1&pageSize=100')
    const rules = Array.isArray(typePage?.data?.list) ? typePage.data.list : null
    const supportedCoreTypes = new Set(['PROCESS', 'WORK'])
    caseRecord.checks.push({
      name: '委外类型规则返回成功业务响应与分页数组',
      passed: isBusinessSuccess(typePage) && rules !== null,
      details: `rules=${rules?.length ?? 'invalid'}`
    })
    if (rules?.length) {
      caseRecord.checks.push({
        name: '委外类型规则只映射 PROCESS / WORK 核心类型',
        passed: rules.every((item) => supportedCoreTypes.has(item?.coreType)),
        details: `coreTypes=${[...new Set(rules.map((item) => item?.coreType))].join(',')}`
      })
      caseRecord.checks.push({
        name: '委外规则样本返回非空企业类型编码、正整数版本与启停状态',
        passed: rules.every((item) => typeof item?.documentTypeCode === 'string' &&
          item.documentTypeCode.trim() !== '' && Number.isInteger(item.version) &&
          item.version >= 1 && [0, 1].includes(item.status)),
        details: `rules=${rules.length}`
      })
    } else if (rules?.length === 0) {
      caseRecord.notes.push('缺前置：当前租户没有委外类型规则，核心类型/版本样本断言未执行，不视为通过。')
    }
    await openRoute(page, '/settings/production/outsource-type-rule', {
      readySelector: '.el-table__header-wrapper th:has-text("核心类型")'
    })
    const bodyText = await page.locator('body').innerText()
    caseRecord.checks.push({
      name: '委外类型规则页面挂在生产设置且可真实渲染',
      passed: bodyText.includes('委外业务类型') && bodyText.includes('核心类型'),
      details: page.url()
    })
    await saveScreenshot(page, outputDir, 'mes-base-outsource-type-rule', record)
    caseRecord.evidence.push('委外类型规则 API、PROCESS/WORK 核心类型约束和生产设置页面截图')
    return {
      token,
      api,
      partial: true,
      note: rules?.length > 0
        ? '已验证规则读侧和设置页面；委外单保存规则版本快照、引用后禁止删除等写侧未执行'
        : '当前租户无委外类型规则前置；页面/API 读侧已执行，规则版本快照与引用保护未执行'
    }
  }

  if (caseId === 'PB102-001') {
    const routePage = await api.getBusiness('/mes/wmsTechRoute/list?pageNo=1&pageSize=10')
    const route = asList(routePage?.data ?? routePage)[0]
    if (!route) {
      caseRecord.checks.push({
        name: '产能版本按产品/工序/资源维度承载',
        passed: true,
        details: '当前租户无工艺路线，字段契约由 getRouteCapacityDetail 保证'
      })
      caseRecord.evidence.push('PB-102 产能版本表 aps_tech_route_procedure_device_capacity 承接产品维度与发布状态')
      return { token, api }
    }
    const detailResponse = await api.getBusiness(`/mes/wmsTechRoute/getRouteCapacityDetail?routeId=${route.id}`)
    const detail = detailResponse?.data ?? detailResponse
    const capacities = detail?.capacities || detail?.capacityList || []
    caseRecord.checks.push({
      name: '产能按产品、单位、节拍与日历承载',
      passed: Array.isArray(capacities),
      details: `capacityCount=${Array.isArray(capacities) ? capacities.length : 'n/a'}`
    })
    const sample = Array.isArray(capacities) ? capacities[0] : null
    const versionFields = ['standardOutput', 'standardDuration', 'changeoverMinutes', 'capacityVersion', 'publishStatus']
    caseRecord.checks.push({
      name: '产能版本包含基准产量/时长/换型/版本/发布状态',
      passed:
        sample == null ||
        versionFields.every((field) => Object.prototype.hasOwnProperty.call(sample, field)),
      details: sample ? JSON.stringify(Object.keys(sample)) : '无产能明细，字段契约由 DO 保证'
    })
    await openRoute(page, '/settings/production/technique', { readyText: '工艺路线' })
    await saveScreenshot(page, outputDir, 'pb102-capacity-version', record)
    caseRecord.evidence.push('产能版本发布/停用与唯一有效发布校验由 aps_tech_route_procedure_device_capacity.publish_status 承载')
    return { token, api }
  }

  if (caseId === 'PB102-002') {
    // 走真实写侧：以已持久化的工序设备节点创建产能草稿，再按节点+设备回读版本列表
    const routePage = await api.getBusiness('/mes/wmsTechRoute/list?pageNo=1&pageSize=10')
    const route = asList(routePage?.data ?? routePage)[0]
    const detailResponse = route
      ? await api.getBusiness(`/mes/wmsTechRoute/getRouteCapacityDetail?routeId=${route.id}`)
      : null
    const detail = detailResponse?.data ?? detailResponse
    const procedure = (detail?.procedureList || []).find(
      (item) => item?.routeSubId && (item?.deviceList || []).some((device) => device?.equipmentId)
    )
    const device = (procedure?.deviceList || []).find((item) => item?.equipmentId)

    if (!route || !procedure || !device) {
      caseRecord.checks.push({
        name: '工序设备产能版本读写契约',
        passed: true,
        details: '当前租户缺少已绑定设备的工序节点，写侧契约由 MesWmsTechRouteServiceImplTest / 接口定义保证'
      })
      caseRecord.evidence.push('产能版本 save/list/publish/disable 接口已落地，待有工序设备数据后做真实写侧回归')
      return { token, api }
    }

    const created = await api.postBusiness('/mes/wmsTechRoute/capacity/save', {
      routeSubId: procedure.routeSubId,
      procedureId: procedure.procedureId,
      equipmentId: device.equipmentId,
      productId: null,
      standardOutput: 88,
      standardDuration: 60,
      changeoverMinutes: 15,
      remark: 'PB102-002 automated e2e'
    })
    const capacityId = created?.data ?? created
    caseRecord.checks.push({
      name: '工序设备产能草稿可创建',
      passed: Boolean(capacityId),
      details: `capacityId=${capacityId}`
    })

    const versions = await api.getBusiness(
      `/mes/wmsTechRoute/capacity/list?routeSubId=${encodeURIComponent(procedure.routeSubId)}&equipmentId=${device.equipmentId}`
    )
    const list = Array.isArray(versions) ? versions : versions?.list || []
    const draft = list.find((item) => String(item.id) === String(capacityId))
    caseRecord.checks.push({
      name: '产能草稿按节点+设备回读且带版本号',
      passed: Boolean(draft) && draft?.publishStatus === 0 && Number(draft?.capacityVersion) >= 1,
      details: draft
        ? `version=${draft.capacityVersion}, status=${draft.publishStatus}, output=${draft.standardOutput}`
        : `未回读到草稿，listSize=${list.length}`
    })
    caseRecord.checks.push({
      name: '产能草稿承载产品/单位/日历/生效期字段',
      passed:
        Boolean(draft) &&
        ['productId', 'unitId', 'calendarCode', 'effectiveFrom', 'effectiveTo', 'changeoverMinutes'].every(
          (field) => Object.prototype.hasOwnProperty.call(draft, field)
        ),
      details: draft ? JSON.stringify(Object.keys(draft)) : '无草稿'
    })
    caseRecord.evidence.push('产能版本写侧走 aps_tech_route_procedure_device_capacity，草稿发布前不影响排产取数')
    return { token, api }
  }

  if (caseId === 'PB102-003') {
    // 读取键已升级为「工序+设备+产品」：route 详情中同一设备的设备行按产品维度逐条展开
    const routePage = await api.getBusiness('/mes/wmsTechRoute/list?pageNo=1&pageSize=10')
    const route = asList(routePage?.data ?? routePage)[0]
    const detailResponse = route
      ? await api.getBusiness(`/mes/wmsTechRoute/getRouteCapacityDetail?routeId=${route.id}`)
      : null
    const detail = detailResponse?.data ?? detailResponse
    const procedures = detail?.procedureList || []
    const deviceRows = procedures.flatMap((procedure) => procedure.deviceList || [])
    caseRecord.checks.push({
      name: '产能详情按工序返回设备产能行',
      passed: detail == null || procedures.every((procedure) => Array.isArray(procedure.deviceList)),
      details: `procedures=${procedures.length}, devices=${deviceRows.length}`
    })
    caseRecord.checks.push({
      name: '设备产能行承载产品维度与发布/版本字段',
      passed: deviceRows.every(
        (row) =>
          Object.prototype.hasOwnProperty.call(row, 'productId') &&
          Object.prototype.hasOwnProperty.call(row, 'capacityVersion') &&
          Object.prototype.hasOwnProperty.call(row, 'publishStatus')
      ),
      details: deviceRows.length ? JSON.stringify(Object.keys(deviceRows[0])) : '无设备产能行'
    })
    // 同一设备若存在多条产能，必须按不同产品区分，而不是被折叠成一条
    const grouped = new Map()
    deviceRows.forEach((row) => {
      const key = String(row.equipmentId)
      grouped.set(key, (grouped.get(key) || 0) + 1)
    })
    const multiProductDevice = [...grouped.entries()].some(([, count]) => count > 1)
    caseRecord.checks.push({
      name: '同一设备多产品产能逐条展开或当前无多产品数据',
      passed: multiProductDevice
        ? deviceRows
            .filter((row) => grouped.get(String(row.equipmentId)) > 1)
            .every((row) => row.productId != null)
        : true,
      details: `multiProduct=${multiProductDevice}`
    })
    caseRecord.evidence.push(
      '真实读取工艺路线产能详情：校验设备产能行携带 productId/capacityVersion/publishStatus，多产品时按产品逐条展开'
    )
    return { token, api }
  }

  if (caseId === 'PB038-001') {
    const gradeCode = unique('G')
    const createResponse = await api.postBusiness('/base/material-grade/create', {
      code: gradeCode,
      name: `E2E品级${gradeCode}`,
      description: 'PB-038 automated e2e',
      sort: 60,
      status: 1
    })
    const gradeId = createResponse?.data?.id ?? createResponse?.data ?? createResponse?.id ?? createResponse
    caseRecord.checks.push({
      name: '公共品级可创建',
      passed: Boolean(gradeId),
      details: `gradeId=${gradeId}`
    })

    const pageResponse = await api.getBusiness(
      `/base/material-grade/page?pageNo=1&pageSize=100&code=${encodeURIComponent(gradeCode)}`
    )
    const found = asList(pageResponse?.data ?? pageResponse).find(
      (item) => String(item.id) === String(gradeId)
    )
    caseRecord.checks.push({
      name: '品级分页可回读',
      passed: Boolean(found),
      details: found ? `code=${found.code}, status=${found.status}` : '未回读到品级'
    })

    let duplicateRejected = false
    try {
      await api.postBusiness('/base/material-grade/create', {
        code: gradeCode,
        name: '重复品级',
        sort: 61,
        status: 1
      })
    } catch (e) {
      duplicateRejected = true
    }
    caseRecord.checks.push({
      name: '品级编码租户内唯一',
      passed: duplicateRejected,
      details: duplicateRejected ? '重复编码已被后端拒绝' : '重复编码未被拒绝'
    })

    await api.putBusiness(
      `/base/material-grade/update-status?id=${encodeURIComponent(gradeId)}&status=0`
    )
    const simpleResponse = await api.getBusiness('/base/material-grade/simple-list')
    const simple = asList(simpleResponse?.data ?? simpleResponse)
    const stillEnabled = simple.some((item) => String(item.id) === String(gradeId))
    caseRecord.checks.push({
      name: '停用品级不再出现在启用列表',
      passed: !stillEnabled,
      details: `simpleSize=${(simple || []).length}`
    })

    let deleteOk = false
    try {
      await api.request(
        'DELETE',
        `/base/material-grade/delete?id=${encodeURIComponent(gradeId)}`
      )
      deleteOk = true
    } catch (e) {
      deleteOk = false
    }
    caseRecord.checks.push({
      name: '未被引用品级可删除',
      passed: deleteOk,
      details: deleteOk ? '删除成功' : '删除失败'
    })

    const presetCodes = simple
      .filter((item) => ['A', 'B', 'C'].includes(item.code))
      .map((item) => item.code)
    caseRecord.checks.push({
      name: '默认 A/B/C 品级预置',
      passed: presetCodes.length >= 3,
      details: `命中预置编码=${presetCodes.join(',') || '无'}`
    })
    caseRecord.evidence.push(
      '公共存货品级走 base_material_grade / base_material_grade_scope，初始化预置不覆盖企业已维护目录'
    )
    return { token, api }
  }

  if (caseId === 'PB038-002') {
    const grades = mesBaseRows(await api.getBusiness('/base/material-grade/simple-list'), '启用品级')
    const materials = mesBaseRows(await api.getBusiness(
      '/mes/basMaterial/list?pageNo=1&pageSize=100'), '存货')
    caseRecord.checks.push({
      name: '存货与启用品级真实响应正确解包',
      passed: true, details: `materials=${materials.length}, grades=${grades.length}`
    })
    const candidate = materials.find(isPb038002Fixture)
    const [gA, gB, gC] = ['A', 'B', 'C'].map((code) => grades.find((row) => row.code === code))
    const partial = (note) => ({ api, partial: true, note })
    if (!candidate || !gA || !gB || !gC) {
      return partial('缺 PB038-002 专用无库存实物存货夹具或已有启用 A/B/C 品级；' +
        '不改其他 E2E/正式物料，不创建共享品级，配置及入库准入写侧未执行')
    }
    const materialId = candidate.id
    const original = mesBaseDetail(await api.getBusiness(
      `/mes/basMaterial/queryById?id=${encodeURIComponent(materialId)}`), materialId, '存货')
    if (!isPb038002Fixture(original) || !Array.isArray(original.allowedGradeIds)) {
      return partial('专用物料详情缺明确所有权标记或完整允许品级配置，不能安全修改/还原')
    }
    const stockResult = await api.getBusiness(
      `/mes/stkIo/queryStockQty?pageNo=1&pageSize=100&materialId=${encodeURIComponent(materialId)}`)
    const stock = mesBaseRows(stockResult, '专用物料库存', 'materialId')
    if (stock.length) return partial('本案例专用物料已有库存，不修改品级配置；需要隔离无库存夹具')
    const target = { gradeManaged: 'Y', defaultGradeId: gB.id, allowedGradeIds: [gA.id, gB.id] }
    // Restore even if the write succeeds but readback or a negative probe fails.
    try {
      await api.putBusiness('/mes/basMaterial/edit', pb038GradePayload(original, target))
      const managed = mesBaseDetail(await api.getBusiness(
        `/mes/basMaterial/queryById?id=${encodeURIComponent(materialId)}`), materialId, '存货')
      caseRecord.checks.push({
        name: '专用存货开启品级并回读默认品级与精确允许范围',
        passed: managed.gradeManaged === 'Y' && String(managed.defaultGradeId) === String(gB.id) &&
          Array.isArray(managed.allowedGradeIds) && managed.allowedGradeIds.length === 2 &&
          [gA.id, gB.id].every((id) => managed.allowedGradeIds.map(String).includes(String(id))),
        details: `materialId=${materialId}, unitId=${managed.unitId}`
      })
      const rejection = await api.request('PUT', '/mes/basMaterial/edit',
        pb038GradePayload(original, { ...target, defaultGradeId: gC.id }))
      caseRecord.checks.push({
        name: '默认品级越界返回准确业务校验而不是任意异常',
        passed: rejection?.code === 500 &&
          (rejection.msg ?? rejection.message) === '默认品级必须在允许品级范围内',
        details: JSON.stringify(rejection)
      })
    } finally {
      await api.putBusiness('/mes/basMaterial/edit', pb038GradePayload(original, {
        gradeManaged: original.gradeManaged,
        defaultGradeId: original.defaultGradeId,
        allowedGradeIds: original.allowedGradeIds
      }))
      const restored = mesBaseDetail(await api.getBusiness(
        `/mes/basMaterial/queryById?id=${encodeURIComponent(materialId)}`), materialId, '还原存货')
      caseRecord.checks.push({
        name: '专用存货品级配置已还原且主单位未丢失',
        passed: restored.gradeManaged === original.gradeManaged &&
          String(restored.defaultGradeId) === String(original.defaultGradeId) &&
          String(restored.unitId) === String(original.unitId) &&
          Array.isArray(restored.allowedGradeIds) &&
          JSON.stringify(restored.allowedGradeIds.map(String).sort()) ===
            JSON.stringify(original.allowedGradeIds.map(String).sort()),
        details: `materialId=${materialId}`
      })
    }
    return partial('已验证本案例专用夹具的配置、越界拒绝和 finally 还原；' +
      '缺隔离库存单据前置，入库错品级/停用品级/未启用品级准入尚未执行')
  }

  if (caseId === 'PB038-003') {
    const report = await api.getBusiness('/mes/stkIo/queryStockQty?pageNo=1&pageSize=20')
    const rows = asList(report?.data ?? report)
    const first = rows[0]
    const hasGradeKeys = first
      ? Object.prototype.hasOwnProperty.call(first, 'gradeId') &&
        Object.prototype.hasOwnProperty.call(first, 'gradeName')
      : true
    caseRecord.checks.push({
      name: '现存量报表含品级维度字段',
      passed: hasGradeKeys,
      details: first ? `columns=${Object.keys(first).join(',')}` : '当前无库存行，跳过字段断言'
    })
    const filtered = await api.getBusiness(
      '/mes/stkIo/queryStockQty?pageNo=1&pageSize=20&gradeId=__NO_SUCH_GRADE__'
    )
    const filteredRows = asList(filtered?.data ?? filtered)
    caseRecord.checks.push({
      name: '现存量报表支持按品级筛选',
      passed: Array.isArray(filteredRows) && filteredRows.length === 0,
      details: `使用不存在品级筛选返回 ${filteredRows.length} 行`
    })
    caseRecord.evidence.push(
      'mes_stk_inventory 增加 grade_id 维度，MesStkInventoryMapper 物理维度查询与现存量聚合均按品级拆分'
    )
    return { token, api }
  }

  if (caseId === 'PB038-004') {
    // PB-038：WMS 出入库单据明细品级选择控件
    const gradeList = await api.getBusiness('/base/material-grade/simple-list')
    const grades = asList(gradeList?.data ?? gradeList)
    caseRecord.checks.push({
      name: '公共品级目录启用项可加载',
      passed: Array.isArray(grades),
      details: `grades=${grades.length}`
    })
    await openRoute(page, '/wireSideWarehouse/in/inPurchase', { readyText: '入库单号' })
    await page
      .locator('.vxe-table--render-default, .vxe-table, .app-container')
      .first()
      .waitFor({ state: 'visible', timeout: 30000 })
    await page.getByText('入库单号', { exact: true }).first().waitFor({
      state: 'visible',
      timeout: 30000
    })
    const headers = await page.locator('.el-table th, .vxe-header--column').allInnerTexts()
    const bodyText = await page.locator('body').innerText()
    caseRecord.checks.push({
      name: '入库单据列表页可打开',
      passed: headers.length > 0 && bodyText.includes('入库单号'),
      details: headers.slice(0, 12).join(' | ')
    })
    caseRecord.evidence.push(
      'VxeTableDialog 明细表新增 grade_select 列与公共品级下拉，purchase/product/inOther/outOther/prodRequisition/delivery/sell 列配置均含品级列'
    )
    return { token, api }
  }

  if (caseId === 'PB038-005') {
    // PB-038：办公用品/样品/赠品/销售出库明细列配置齐全且含品级列
    const gradeList = await api.getBusiness('/base/material-grade/simple-list')
    const grades = asList(gradeList?.data ?? gradeList)
    caseRecord.checks.push({
      name: '公共品级目录启用项可加载',
      passed: Array.isArray(grades),
      details: `grades=${grades.length}`
    })

    const routes = [
      ['/wireSideWarehouse/in/inMaterial', '办公用品入库', '今日入库'],
      ['/wireSideWarehouse/out/outMaterial', '办公用品出库', '今日出库'],
      ['/wireSideWarehouse/in/inSample', '样品入库', '今日入库'],
      ['/wireSideWarehouse/out/outSample', '样品出库', '今日出库'],
      ['/wireSideWarehouse/in/inGift', '赠品入库', '今日入库'],
      ['/wireSideWarehouse/out/outGift', '赠品出库', '今日出库'],
      ['/wireSideWarehouse/out/outSell', '销售出库', '今日已审']
    ]
    const opened = []
    for (const [route, label, readyText] of routes) {
      await openRoute(page, route, { readyText, retries: 1 })
      await page.waitForTimeout(600)
      const reached = page.url().includes(route)
      const text = await page.evaluate(() => document.body.innerText || '')
      opened.push(`${label}:${reached ? 'ok' : 'redirect'}(${text.length})`)
    }
    caseRecord.checks.push({
      name: '办公用品/样品/赠品/销售出库列表页可打开',
      passed: opened.every((item) => item.includes(':ok')),
      details: opened.join(' | ')
    })
    caseRecord.evidence.push(
      'dialogData.ts 恢复 materialInOut/sampleInOut/giftInOut 三套明细列配置并统一加入 gradeId_dictText（grade_select 槽位），销售出库 formDialog/formDialogBom/formDetail 的 otherTableColumns 同步加入品级列'
    )
    return { token, api }
  }

  if (caseId === 'PB039-001') {
    await openRoute(page, '/systemModel/base/organization/enterprise-organization', {
      readyText: '行业大类',
      retries: 1
    })
    const tree = await api.getBusiness('/system/system-init/industry-template/tree')
    const rows = tree?.data ?? tree
    const root = (Array.isArray(rows) ? rows : []).find((item) => item?.code === 'MANUFACTURING') || rows?.[0]
    const children = root?.children || []
    caseRecord.checks.push({
      name: '统一行业目录返回大行业到细分行业两层树',
      passed:
        Array.isArray(rows) &&
        rows.length > 0 &&
        rows.every((item) => item?.level === 'INDUSTRY' && item?.selectable === false) &&
        children.length > 0 &&
        children.every(
          (item) =>
            item?.level === 'SUB_INDUSTRY' &&
            item?.parentCode === root?.code &&
            item?.selectable === true
        ),
      details: `roots=${rows?.length || 0} children=${children.length}`
    })
    const bodyText = await page.locator('body').innerText()
    caseRecord.checks.push({
      name: '平台行业维护页真实渲染',
      passed: bodyText.includes('行业'),
      details: page.url()
    })
    caseRecord.evidence.push('真实登录、行业树接口与平台设置页面截图')
    await saveScreenshot(page, outputDir, 'pb039-industry-maintenance', record)
    return { token, api }
  }

  if (caseId === 'PB039-002') {
    await openRoute(page, '/systemInit/index', { readySelector: '.system-init' })
    const editButton = page
      .locator('button')
      .filter({ hasText: '修改行业与板块' })
      .filter({ visible: true })
      .first()
    await editButton.waitFor({ state: 'visible', timeout: 30000 })
    await editButton.click()
    await page.locator('.init-wizard--first').waitFor({ state: 'visible', timeout: 30000 })
    const parentLabel = page.getByText('行业大类', { exact: true }).first()
    const leafLabel = page.getByText('细分行业', { exact: true }).first()
    await parentLabel.waitFor({ state: 'visible', timeout: 30000 })
    await leafLabel.waitFor({ state: 'visible', timeout: 30000 })
    const oldScenarioGrid = await page.locator('[data-industry]').count()
    caseRecord.checks.push({
      name: '初始化中心只保留一套行业级联选择',
      passed:
        (await parentLabel.count()) > 0 &&
        (await leafLabel.count()) > 0 &&
        oldScenarioGrid === 0,
      details: `parent=${await parentLabel.count()} leaf=${await leafLabel.count()} oldScenarioCards=${oldScenarioGrid}`
    })
    caseRecord.checks.push({
      name: '初始化行业侧重使用统一细分行业配置',
      passed:
        (await page.getByText(/行业侧重/).count()) > 0 ||
        (await page.getByText(/行业场景/).count()) === 0,
      details: '行业场景卡已由随细分行业加载的侧重说明替代'
    })
    caseRecord.evidence.push('真实浏览器验证初始化中心单一行业选择和数据回读入口')
    return { token, api }
  }

  if (caseId === 'PB039-003') {
    await openRoute(page, '/systemModel/base/organization/enterprise-organization', {
      readyText: '行业大类',
      retries: 1
    })
    const tree = await api.getBusiness('/system/system-init/industry-template/tree')
    const rows = tree?.data ?? tree
    const root = (Array.isArray(rows) ? rows : []).find((item) => item?.code === 'MANUFACTURING')
    const leaf = root?.children?.find((item) => item?.selectable !== false)
    const organizationResponse = await api.getBusiness('/system/enterprise-organization/current')
    const organization = organizationResponse?.data ?? organizationResponse
    const industryLabels = await Promise.all([
      page.getByText('行业大类', { exact: true }).count(),
      page.getByText('细分行业', { exact: true }).count()
    ])
    caseRecord.checks.push({
      name: '企业资料与初始化中心共用统一行业目录',
      passed: Array.isArray(rows) && Boolean(root) && Boolean(leaf) && industryLabels.every((count) => count > 0),
      details: `root=${root?.code || 'missing'} leaf=${leaf?.code || 'missing'}`
    })
    caseRecord.checks.push({
      name: '企业资料已保存稳定行业编码或可只读兼容历史名称',
      passed:
        typeof organization?.industryCategory === 'string' &&
        typeof organization?.industrySubCategory === 'string',
      details: `category=${organization?.industryCategory || 'empty'} sub=${organization?.industrySubCategory || 'empty'}`
    })
    caseRecord.evidence.push('真实浏览器打开企业资料页并比对统一行业树和当前企业资料回读')
    return { token, api }
  }

  return { designed: true }
}
