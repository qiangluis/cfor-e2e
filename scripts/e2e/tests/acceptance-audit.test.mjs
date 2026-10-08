import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

// Freeze the pre-audit working-tree text, including uncommitted assertions.
// Keep this baseline independent of catalog data and executable suites.
const auditBaseline = [
  {
    id: 'PB034-002',
    title: '统一公共客商档案单表页面与角色开关',
    assertions: [
      '设置 - 业务设置 - ERP 下的客商档案页面可进入',
      '同一客商可同时启用客户、供应商、承运商角色开关',
      '角色筛选按 customerEnabled/supplierEnabled/carrierEnabled 过滤同一主表',
      '列表回读稳定客商编码、税号与角色标识',
      '分页返回 base_partner 单表记录，不出现第二套客户/供应商主档',
      'CRM 创建客户时在 base_partner 建立客户角色并通过 crm_customer.partner_id 关联，不再新建 erp_customer'
    ]
  },
  {
    id: 'CRM-BASE-001',
    title: '销售基础字典与商机执行状态口径',
    assertions: [
      '销售类型、销售计划类型、意向级别和商机执行状态使用 system_dict_type/system_dict_data',
      '商机阶段仍使用 crm_business_status* 物理表并显示为商机阶段',
      '赢单和战败只保存到 end_status，不写入 execution_status',
      '停用字典值不能用于新建业务，历史记录仍可查询'
    ]
  },
  {
    id: 'CRM-BASE-003',
    title: '客户标签定义、关系和变更审计',
    assertions: [
      '标签为多值关系，定义保存在 crm_customer_tag_definition',
      '关系保存来源、规则版本和依据，重复添加幂等',
      '变更写入 crm_customer_tag_change_log，含动作、来源和操作人',
      '系统标签不能由人工入口添加或移除',
      '已有引用的标签禁止删除，只能停用',
      '设置 - 业务设置 - CRM 下可见客户标签定义页面，可维护人工标签编码/名称/颜色/状态',
      '标签编码创建后不可修改，系统标签在定义页禁用删除入口'
    ]
  },
  {
    id: 'ERP-SALES-007',
    title: '销售类型与销售计划类型正式单据快照',
    assertions: [
      '销售订单保存 sale_type_code 稳定编码；停用的 erp_sale_type 字典值不能用于新建订单',
      'CRM 销售计划保存 plan_type_code 稳定编码并校验字典 crm_sales_plan_type 启用状态',
      '停用字典值后历史订单/计划仍可查询，快照不回溯改写'
    ]
  },
  {
    id: 'WMS-QC-004',
    title: '库区库位归属、唯一与删除保护',
    assertions: [
      '库区编码在租户和仓库范围内唯一',
      '库位编码在租户和仓库范围内唯一',
      '库位必须归属启用库位的仓库且库区属于同一仓库',
      '库位已有库存、未完成装箱任务或未完成出入库单时，删除或调整仓库/库区被后端拒绝',
      '未启用库区或库位的仓库不能创建对应层级档案'
    ]
  },
  {
    id: 'WMS-QC-008',
    title: '仓库库区与库位启用开关约束',
    assertions: [
      '仓库主档显式维护是否启用库区、库位，不能以是否存在子记录代替配置',
      '启用库位时必须同时启用库区，违反时前端联动与后端校验均拒绝',
      '关闭库区时库位开关自动关闭，避免出现无库区的库位',
      '新增仓库默认关闭库区与库位'
    ]
  },
  {
    id: 'WMS-QC-009',
    title: '企业自定义出入库类型直接接入出入库写侧',
    assertions: [
      '企业自定义出入库类型可直接在字典新增，不强制要求配置映射规则',
      '未配置映射规则时仅快照企业业务类型名称，核心出入库类型与库存方向沿用表单选择',
      '企业业务类型编码必须来自字典 wms_business_io_type，非字典编码被后端拒绝',
      '已配置启用状态的映射规则时，核心库存类型收敛到规则值并做方向一致性校验'
    ]
  },
  {
    id: 'WMS-QC-010',
    title: '旧 ERP 仓库映射表退役为只读兼容视图',
    assertions: [
      '仓库主档唯一事实源为 mes_wms_ware_house，旧 erp_warehouse 已停写并退役为只读视图',
      '旧 erp_warehouse 视图主键与 mes_wms_ware_house.id 同源，ERP 单据既有仓库 ID 语义不变',
      '视图 status 按 is_enabled 投影为 0/1，仓储费/搬运费/排序/默认标记投影为默认值',
      '镜像补齐任务改为只读对账，不再向旧表写入',
      '旧 erp_warehouse 分页读侧仍返回公共仓库数据',
      '新增/更新/删除/切换默认状态四个旧写接口统一返回退役错误码 1030400002，而不是底层视图不可更新的 500'
    ]
  },
  {
    id: 'IOT-004',
    title: '对接类型复用 IoT 产品设备形态，协议目录来自代码注册',
    assertions: [
      '对接类型复用 IoT 产品设备形态，不新建独立对接类型主档',
      '协议目录来自代码注册，包含 OPC_UA 与 modbus_tcp_client',
      '设备形态目录来自代码注册且不少于 3 种',
      '未注册协议不会出现在能力目录'
    ]
  },
  {
    id: 'IOT-006',
    title: '设备状态三层：连接/资产/运行核心状态固定，企业只映射子状态',
    assertions: [
      '运行/资产/连接三层核心状态固定，企业只能映射子状态',
      '专属子状态映射到固定核心状态并回读成功',
      '非平台固定核心状态被拒绝',
      '连接/资产/运行三层状态事件可并存且互不覆盖',
      '设备维保设置页真实渲染并承载状态映射/维保类型/项目/方案/分配页签'
    ]
  },
  {
    id: 'MAINT-001',
    title: '维保类型子类型必须映射维修/保养/巡检固定核心域',
    assertions: [
      '保养子类型映射固定核心域 UPKEEP',
      '非固定核心维保域被拒绝'
    ]
  },
  {
    id: 'MAINT-002',
    title: '维保/巡检项目主档与三类不可删除根分类',
    assertions: [
      '三类固定根分类自动就绪',
      '可在固定根分类下创建维保项目'
    ]
  },
  {
    id: 'MAINT-003',
    title: '维保方案草稿/发布/停用版本治理',
    assertions: [
      '维保方案发布后记录已发布版本',
      '已发布方案禁止删除'
    ]
  },
  {
    id: 'MAINT-004',
    title: '方案三级分配命中优先级 单设备 > 产品型号 > 设备类型',
    assertions: [
      '单设备分配优先于产品型号和设备类型',
      '停用单设备分配后回退到产品型号分配',
      '停用单设备和产品型号分配后回退到设备类型分配'
    ]
  },
  {
    id: 'MAINT-005',
    title: '巡检方案发布后生成 inspection_plan 运行计划并保存分配/方案版本/周期快照',
    assertions: [
      '巡检方案发布后生成 inspection_plan 运行计划并保存分配与方案版本快照'
    ]
  },
  {
    id: 'PB111-001',
    title: '项目建模复用设置主菜单入口，不新建平行建模页面',
    assertions: [
      '项目建模配置沿用设置主菜单下的项目建模入口',
      '项目建模树形条目和分类来自真实配置接口',
      '项目基础建模工作区真实渲染，不新建平行页面',
      '模块定义写入后可回读分类、版本和启用状态',
      '模块定义停用后回读为 DISABLED'
    ]
  },
  {
    id: 'PB112-001',
    title: '人员能力标签引用 HRM 员工并维护技能历史',
    assertions: [
      '人员能力标签引用 HRM 员工并维护技能历史',
      '派研保存 HRM 员工有效能力标签快照并可回读'
    ]
  },
  {
    id: 'PB113-001',
    title: '日报周报版本化，退回形成修订版本，任务状态只建议',
    assertions: [
      '日报只读来源按项目带出任务/风险/里程碑',
      '日报填报人使用当前登录用户，不伪造固定用户编号',
      '日报来源快照由服务端按事实源生成，忽略客户端伪造值',
      '退回后生成新的修订版本，任务状态只作建议',
      '退回版本不把任务状态建议反写到任务事实源'
    ]
  },
  {
    id: 'PB114-001',
    title: '项目预警规则/事件只生成待办通知，不改项目状态',
    assertions: [
      '预警规则求值命中并保存规则版本、指标与证据',
      '预警求值只落事件和待办，不修改项目状态与计划日期',
      '同一规则与触发窗口重复求值保持幂等'
    ]
  },
  {
    id: 'PB115-001',
    title: '里程碑模板复用项目建模配置并记录版本号',
    assertions: [
      '里程碑模板复用项目建模配置且不另建主档',
      '里程碑模板保留版本号以支持发布后新版本变更',
      '里程碑模板返回完整阶段快照供工作台回读',
      '启用里程碑模板前阻断缺少必经阶段交付物',
      '草稿经启用接口发布仍执行里程碑门禁，不能绕过保存校验',
      '里程碑模板创建并发布 V1 后回读版本号',
      '同编码发布新版本后版本号递增且旧版本自动停用'
    ]
  },
  {
    id: 'PB116-001',
    title: '任务库复用建模配置键 taskLibrary/taskCategory 与引用计数',
    assertions: [
      '任务库复用建模配置键 taskLibrary/taskCategory 并返回引用计数',
      '任务库真实条目保存标准工时、产出物、验收标准和前置关系',
      '启用任务库前阻断前置任务循环依赖',
      '草稿经启用接口发布仍执行任务库门禁，不能绕过验收标准校验'
    ]
  },
  {
    id: 'PB117-001',
    title: '项目类型发布依赖门禁、模板停用保护与建项关联配置快照',
    assertions: [
      '发布项目类型时拒绝未启用的必填依赖',
      '项目类型草稿经状态接口启用不能绕过依赖校验',
      '项目主档切换项目类型时固化服务端依赖配置快照'
    ]
  },
  {
    id: 'PB118-001',
    title: '项目核心状态固定、健康状态与状态解耦',
    assertions: [
      '交付项目分页可读',
      '非法健康状态被拒绝，核心状态与健康状态解耦',
      '健康状态可独立切换为 DELAYED 且核心状态不变'
    ]
  },
  {
    id: 'PB119-001',
    title: '售后设置复用现有建模页读取 SLA/提醒/评价，不建平行主档',
    assertions: [
      '售后设置复用现有建模页读取 SLA/提醒/评价，不建平行主档',
      'SLA 策略写入后回读分类、响应/解决时限和暂停口径',
      'SLA 策略停用后回读为 DISABLED',
      '售后设置页可进入且复用页面内维护 SLA/提醒/评价'
    ]
  },
  {
    id: 'PB120-001',
    title: '售后问题分类适用范围，与 CRM 问题标签分离',
    assertions: [
      '分类主档写入后回读产品类型/资产类型/服务状态适用范围',
      '售后问题分类与 CRM 客户标签是相互独立的事实源',
      '售后问题分类停用后回读为 DISABLED',
      '售后设置页全部建模数据均从正式接口读取',
      '售后设置页已接入真实数据且不再展示虚拟数据标识'
    ]
  },
  {
    id: 'PB121-001',
    title: 'SLA暂停规则分客户侧与内部责任计时，等待研发不得暂停内部计时',
    assertions: [
      '暂停规则可分别控制客户侧SLA与内部责任计时',
      '等待研发原因禁止暂停内部责任计时',
      '暂停规则停用后回读为 DISABLED，停止参与 SLA 暂停计算'
    ]
  },
  {
    id: 'PB122-001',
    title: '售后巡检项目/方案版本/资产分配配置层',
    assertions: [
      '售后巡检方案发布记录版本',
      '被方案引用的巡检项目禁止删除',
      '巡检方案可分配到在保客户资产并作为任务快照来源'
    ]
  },
  {
    id: 'PB125-001',
    title: '客户资产独立于存货，服务期/责任人/状态统一回读',
    assertions: [
      '手工客户资产可在分页中按 assetNo 独立检索',
      '客户资产详情统一回读服务期、责任人和存货档案引用',
      '客户资产不是存货余额载体，不含库存数量字段',
      '资产退役后状态回读为 RETIRED，不改动存货档案'
    ]
  },
  {
    id: 'PB126-001',
    title: '小序AI接待策略：置信度、敏感转人工、AI不自动受理/关闭/改写事实',
    assertions: [
      'AI不得自动受理/关闭/改写客户事实',
      '置信度阈值越界被拒绝'
    ]
  },
  {
    id: 'PB127-001',
    title: '客户资产服务状态与来源项目/验收引用可查询',
    assertions: [
      '客户资产来源类型与来源项目/验收引用可回读',
      '服务期来源关联项目验收单且资产处于在保状态',
      '来源验收单真实存在且状态为 APPROVED',
      '项目验收资产退役后仍保留来源引用'
    ]
  },
  {
    id: 'PB128-001',
    title: '评价项目主档复用售后建模并保持稳定编码',
    assertions: [
      '评价项目主档写入后回读稳定编码与分类引用',
      '评价项目停用后回读为 DISABLED 且编码不变'
    ]
  },
  {
    id: 'PB129-001',
    title: '评价模板返回项目快照，历史模板不随主档漂移',
    assertions: [
      '评价模板启用后回读项目快照与总分',
      '已启用模板保留创建时快照，不随评价项目主档漂移'
    ]
  },
  {
    id: 'PB130-001',
    title: '值班事实源为 HRM/OA 排班，清除非服务时段外的硬编码人员',
    assertions: [
      'HRM 提供值班角色目录，售后不做角色主档',
      '值班名册人员来自 HRM/OA 排班，电话来自售后转接规则',
      '值班设置页不再出现示例人员与固定日期'
    ]
  }
]

const catalog = JSON.parse(fs.readFileSync(
  new URL('../cases/catalog.json', import.meta.url), 'utf8'
))
const cases = catalog.suites.flatMap((suite) => suite.cases)
const auditedIds = new Set(auditBaseline.map((item) => item.id))

test('acceptance audit contains exactly 33 unique target cases, excluding PB123/PB124', () => {
  assert.equal(auditBaseline.length, 33, 'actual audit manifest count')
  assert.equal(auditedIds.size, 33, 'unique audit manifest count')
  assert.equal(auditedIds.has('PB123-001'), false)
  assert.equal(auditedIds.has('PB124-001'), false)
  assert.equal(cases.filter((item) => auditedIds.has(item.id)).length, 33,
    'actual catalog target count')
})

for (const baseline of auditBaseline) {
  test(`${baseline.id} remains PARTIAL with explicit gaps and unchanged acceptance text`, () => {
    const matches = cases.filter((item) => item.id === baseline.id)
    assert.equal(matches.length, 1, `${baseline.id}: catalog occurrence count`)
    const item = matches[0]
    assert.equal(item.status, 'PARTIAL', `${baseline.id}: incomplete original acceptance`)
    assert.ok(Array.isArray(item.acceptanceGaps) && item.acceptanceGaps.length > 0,
      `${baseline.id}: acceptanceGaps must be a non-empty array`)
    for (const gap of item.acceptanceGaps) {
      assert.ok(typeof gap === 'string' && gap.trim().length > 0,
        `${baseline.id}: each acceptance gap must be non-blank text`)
    }
    assert.equal(new Set(item.acceptanceGaps.map((gap) => gap.trim())).size,
      item.acceptanceGaps.length, `${baseline.id}: acceptance gaps must not be duplicates`)
    assert.equal(item.title, baseline.title, `${baseline.id}: original title`)
    assert.deepEqual(item.assertions, baseline.assertions,
      `${baseline.id}: preserve every original assertion, its text and order`)
  })
}
