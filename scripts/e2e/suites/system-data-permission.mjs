import { createApiClient } from '../lib/api.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'

export const cases = ['AUTH-DATA-003', 'AUTH-DATA-005', 'AUTH-DATA-006', 'PB006-001']

const DEPT_CUSTOM = 2
const dataOf = (response) => response?.data ?? response

export const runCase = async ({ caseId, page, record, caseRecord, outputDir }) => {
  const token = await login(page)
  const api = createApiClient({ token, record })

  if (caseId === 'AUTH-DATA-003') {
    const deptList = dataOf(await api.getBusiness('/system/dept/list'))
    const depts = Array.isArray(deptList) ? deptList : []
    caseRecord.checks.push({
      name: '当前租户部门清单可读取',
      passed: depts.length > 0,
      details: `deptCount=${depts.length}`
    })

    const roleCode = `E2E_PB006_${Date.now()}`
    const roleId = dataOf(await api.postBusiness('/system/role/create', {
      name: `PB006 E2E 数据权限角色 ${Date.now()}`,
      code: roleCode,
      sort: 99,
      status: 0,
      remark: 'PB-006 自定义部门校验用例，用例末尾删除'
    }))
    caseRecord.checks.push({
      name: '用例角色创建成功',
      passed: Boolean(roleId),
      details: `roleId=${roleId}`
    })

    // 不存在的部门编号必须被拒绝
    const bogusDeptAttempt = await api.post('/system/permission/assign-role-data-scope', {
      roleId,
      dataScope: DEPT_CUSTOM,
      dataScopeDeptIds: [999999999]
    })
    caseRecord.checks.push({
      name: '不存在或跨租户部门提交被拒绝',
      passed: bogusDeptAttempt?.code !== 0,
      details: `code=${bogusDeptAttempt?.code} msg=${bogusDeptAttempt?.msg || 'n/a'}`
    })

    const validDept = depts[0]
    await api.postBusiness('/system/permission/assign-role-data-scope', {
      roleId,
      dataScope: DEPT_CUSTOM,
      dataScopeDeptIds: [validDept?.id]
    })
    const rolePage = dataOf(await api.getBusiness('/system/role/page?pageNo=1&pageSize=100'))
    const persisted = (rolePage?.list || []).find((item) => item?.id === roleId)
    caseRecord.checks.push({
      name: '当前租户有效部门可保存为自定义数据范围',
      passed: persisted?.dataScope === DEPT_CUSTOM,
      details: `dataScope=${persisted?.dataScope}`
    })

    await api.delete(`/system/role/delete?id=${roleId}`)
    caseRecord.evidence.push(
      '真实接口：创建用例角色 -> 非法部门被拒 -> 合法部门保存 -> 回读自定义范围 -> 删除用例角色'
    )
    return { token, api }
  }

  if (caseId === 'AUTH-DATA-005' || caseId === 'AUTH-DATA-006') {
    const menuTree = dataOf(await api.getBusiness('/system/menu/list'))
    const flatMenus = []
    const walk = (nodes) => {
      ;(Array.isArray(nodes) ? nodes : []).forEach((node) => {
        flatMenus.push(node)
        walk(node?.children)
      })
    }
    walk(menuTree)
    const sensitiveMenu = flatMenus.find((item) => item?.permission === 'sensitive:amount:view')
    caseRecord.checks.push({
      name: '敏感金额权限节点 sensitive:amount:view 已注册',
      passed: sensitiveMenu != null,
      details: JSON.stringify(sensitiveMenu || {})
    })

    const roleCode = `E2E_PB006_AMT_${Date.now()}`
    const roleId = dataOf(await api.postBusiness('/system/role/create', {
      name: `PB006 E2E 金额权限角色 ${Date.now()}`,
      code: roleCode,
      sort: 99,
      status: 0,
      remark: 'PB-006 敏感金额权限用例，用例末尾删除'
    }))
    const roleMenus = dataOf(await api.getBusiness(`/system/permission/list-role-menus?roleId=${roleId}`))
    const grantedMenuIds = Array.isArray(roleMenus) ? roleMenus : []
    caseRecord.checks.push({
      name: '新建角色默认不包含敏感金额权限',
      passed: sensitiveMenu == null || !grantedMenuIds.includes(sensitiveMenu.id),
      details: `roleId=${roleId} granted=${grantedMenuIds.length}`
    })

    if (sensitiveMenu != null) {
      await api.postBusiness('/system/permission/assign-role-menu', {
        roleId,
        menuIds: [...grantedMenuIds, sensitiveMenu.id]
      })
      const afterGrant = dataOf(await api.getBusiness(`/system/permission/list-role-menus?roleId=${roleId}`))
      caseRecord.checks.push({
        name: '授予敏感金额权限后角色菜单可回读',
        passed: (Array.isArray(afterGrant) ? afterGrant : []).includes(sensitiveMenu.id),
        details: `roleId=${roleId}`
      })
      await api.postBusiness('/system/permission/assign-role-menu', {
        roleId,
        menuIds: grantedMenuIds.filter((id) => id !== sensitiveMenu.id)
      })
      const afterRevoke = dataOf(await api.getBusiness(`/system/permission/list-role-menus?roleId=${roleId}`))
      caseRecord.checks.push({
        name: '撤回敏感金额权限后角色菜单立即失效',
        passed: !(Array.isArray(afterRevoke) ? afterRevoke : []).includes(sensitiveMenu.id),
        details: `roleId=${roleId}`
      })
    }

    if (caseId === 'AUTH-DATA-005') {
      const orderPage = dataOf(await api.getBusiness('/erp/sale-order/page?pageNo=1&pageSize=10'))
      const rows = Array.isArray(orderPage?.list) ? orderPage.list : []
      const amountRows = rows.filter((item) => item?.totalPrice != null)
      caseRecord.checks.push({
        name: '有权限账号读取订单金额为真实数值（脱敏由 @SensitiveAmount 统一判定）',
        passed: rows.length === 0 || amountRows.every((item) => typeof item.totalPrice === 'number'),
        details: `rows=${rows.length} amountRows=${amountRows.length}`
      })
      const receivableStatistics = dataOf(await api.getBusiness(
        '/finance/finReceivable/getReceivablesStatistics?pageNo=1&pageSize=10'
      ))
      const statisticsRows = Array.isArray(receivableStatistics?.list)
        ? receivableStatistics.list
        : []
      const statisticsAmountFields = ['receivableAmount', 'receivedAmount', 'unReceivedAmount']
      const invalidStatisticsRows = statisticsRows.filter((row) =>
        statisticsAmountFields.some((field) => row?.[field] != null && typeof row[field] !== 'number')
      )
      caseRecord.checks.push({
        name: '有权限账号读取应收统计报表金额为数值或空（报表 VO 已纳入敏感字段目录）',
        passed: invalidStatisticsRows.length === 0,
        details: `rows=${statisticsRows.length} invalidRows=${invalidStatisticsRows.length}`
      })
      await openRoute(page, '/system/role')
      await saveScreenshot(page, outputDir, 'auth-data-sensitive-amount', record)
    }

    await api.delete(`/system/role/delete?id=${roleId}`)
    caseRecord.evidence.push(
      `PB-006 敏感金额权限节点 ${sensitiveMenu?.id} 安全默认值/授予/撤回链路校验，自建角色 ${roleId} 已删除`
    )
    return { token, api }
  }

  if (caseId === 'PB006-001') {
    const coverageResponse = await api.getBusiness('/system/data-permission/coverage')
    const summaryResponse = await api.getBusiness('/system/data-permission/coverage/summary')
    const items = Array.isArray(coverageResponse?.data) ? coverageResponse.data : []
    const summary = summaryResponse?.data || {}

    caseRecord.checks.push({
      name: '数据权限业务表覆盖清单可读取',
      passed: items.length > 0,
      details: `itemCount=${items.length}`
    })

    const registeredTables = items
      .filter((item) => item?.status === 'REGISTERED')
      .map((item) => item?.tableName)
    caseRecord.checks.push({
      name: 'system 用户与部门表已登记到通用数据权限规则',
      passed: registeredTables.includes('system_users') && registeredTables.includes('system_dept'),
      details: `registered=${registeredTables.join(',')}`
    })

    const stockItem = items.find((item) => item?.tableName === 'mes_stk_inventory')
    caseRecord.checks.push({
      name: '库存唯一事实源明确不挂通用行级规则',
      passed: stockItem?.status === 'NOT_APPLICABLE' && Boolean(stockItem?.ownerRule),
      details: `status=${stockItem?.status} ownerRule=${stockItem?.ownerRule || 'n/a'}`
    })

    // PB-006：HRM 员工档案按 dept_id、PMS 知识库成员按 dept_id 行级接入；
    // pms_project_group 实际无 dept_id，只能按负责人 user_id 收敛
    const hrmEmployee = items.find((item) => item?.tableName === 'hrm_employee')
    const kbMember = items.find((item) => item?.tableName === 'pms_knowledge_library_member')
    const projectGroup = items.find((item) => item?.tableName === 'pms_project_group')
    caseRecord.checks.push({
      name: 'HRM/PMS 行级数据权限已注册且归属列正确',
      passed:
        hrmEmployee?.status === 'REGISTERED' &&
        hrmEmployee?.deptColumn === 'dept_id' &&
        kbMember?.status === 'REGISTERED' &&
        kbMember?.deptColumn === 'dept_id' &&
        projectGroup?.status === 'REGISTERED' &&
        String(projectGroup?.deptColumn || '') === '' &&
        projectGroup?.userColumn === 'user_id',
      details:
        `hrm_employee=${hrmEmployee?.status}/${hrmEmployee?.deptColumn}, ` +
        `pms_knowledge_library_member=${kbMember?.status}/${kbMember?.deptColumn}, ` +
        `pms_project_group=${projectGroup?.status}/dept=${projectGroup?.deptColumn || 'null'}/user=${projectGroup?.userColumn}`
    })

    caseRecord.checks.push({
      name: '覆盖汇总口径与清单一致且无计划风险项',
      passed:
        summary?.total === items.length &&
        summary?.registered === registeredTables.length &&
        (summary?.riskCount ?? -1) === 0,
      details: `total=${summary?.total} registered=${summary?.registered} planned=${summary?.planned} risk=${summary?.riskCount}`
    })

    await openRoute(page, '/system/role')
    const bodyText = await page.locator('body').innerText()
    caseRecord.checks.push({
      name: '角色管理页可进入（数据权限配置主体）',
      passed: bodyText.includes('角色') || bodyText.includes('数据范围'),
      details: page.url()
    })

    await saveScreenshot(page, outputDir, 'pb006-data-permission', record)
    caseRecord.evidence.push(
      '数据权限覆盖清单、已注册表、NOT_APPLICABLE 归属与汇总口径只读回读'
    )
    return { token, api }
  }
}
