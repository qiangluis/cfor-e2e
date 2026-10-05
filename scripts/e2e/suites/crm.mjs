export const cases = [
  'CRM-BASE-001',
  'CRM-BASE-002',
  'CRM-BASE-003',
  'CRM-BASE-004',
  'CRM-BASE-005',
  'CRM-BASE-006',
  'CRM-BASE-007'
]

export const runCase = async ({ caseId, page, record, caseRecord, outputDir }) => {
  if (caseId === 'CRM-BASE-007') {
    const { createApiClient } = await import('../lib/api.mjs')
    const { login, openRoute, saveScreenshot } = await import('../lib/browser.mjs')
    const token = await login(page)
    const api = createApiClient({ token, record })
    const rows = (await api.getBusiness('/crm/follow-up-type-rule/list')) || []
    const ruleRows = Array.isArray(rows) ? rows : rows.list || rows.records || []
    const valid = ruleRows.every(
      (item) =>
        item?.dictValue !== undefined &&
        item?.versionNo !== undefined &&
        (item?.status === 0 || item?.status === 1)
    )
    const uniqueValues = new Set(ruleRows.map((item) => String(item.dictValue)))
    caseRecord.checks.push({
      name: '跟进方式规则接口返回字典值、版本和启用状态',
      passed: valid,
      details: `rows=${ruleRows.length}`
    })
    caseRecord.checks.push({
      name: '每个跟进方式字典值至多一条领域规则',
      passed: uniqueValues.size === ruleRows.length,
      details: `unique=${uniqueValues.size}, rows=${ruleRows.length}`
    })
    await openRoute(page, '/crm/config/followUpTypeRule', { readyText: '跟进方式规则' })
    const bodyText = await page.locator('body').innerText()
    caseRecord.checks.push({
      name: '设置-业务设置-CRM 页面可访问且展示跟进方式规则',
      passed: bodyText.includes('跟进方式规则') && bodyText.includes('允许的附件类型'),
      details: bodyText.includes('跟进方式规则') ? '页面真实渲染' : '页面标题未找到'
    })
    await saveScreenshot(page, outputDir, 'crm-follow-up-type-rule', record)
    caseRecord.evidence.push('CRM-BASE-007 真实登录、规则列表接口和设置页渲染截图')
    return { token, api }
  }

  caseRecord.notes.push(
    '案例已登记销售类型、销售计划类型、意向级别和商机执行状态复用字典主档；' +
      '意向级别规则落 crm_customer_intention_rule，客户保存 intention_level 编码并校验启用状态；' +
      '客户标签为定义/关系/审计三表，系统标签与人工标签互不冒充；' +
      '公海回收写 recycleReason、ruleVersion 和 POOL_PUT 幂等业务键，跟进超期按 WorkingDayApi 工作日计算；' +
      '商机阶段规则用规则头 + 规则项两表表达，进入条件与必填字段在 updateBusinessStatus 内做后端强制校验；' +
      'CRM-BASE-006 锁定执行状态受控变更：update-execution-status 写 crm_business_execution_status_log，' +
      '终态商机禁止直接改执行状态，状态未变化或无效编码被拒绝；' +
      '终态商机重开走独立受控动作 PUT /crm/business/reopen，清空 end_status、回写执行状态并以 change_source=REOPEN 落审计，非终态或未填原因被拒绝；' +
      'CRM-BASE-005 覆盖阶段规则允许动作白名单与适用组织，分页响应返回 items 与 applicableOrgIds；' +
    'CRM-BASE-007 锁定跟进方式复用字典 crm_follow_up_type，领域规则 crm_follow_up_type_rule 承载附件要求；' +
      'CRM-BASE-002 锁定正式跟进记录写 intention_level_code、intention_rule_version 和 planned_follow_date 生成时快照，' +
      '由唤醒任务生成的跟进复制来源任务快照，规则后续调整不回溯历史；' +
      '客户标签在报价/合同创建时写入 customer_tag_snapshot（标签稳定编码口径），后续标签调整不回溯历史单据；' +
      '销售价格中心与期初销售出库开票来源继续按批次执行。'
  )
  return { designed: true }
}
