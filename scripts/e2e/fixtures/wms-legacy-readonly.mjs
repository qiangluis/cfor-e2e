import { config } from '../config/index.mjs'
import { assertLocalWriteSafety, runLocalFixtureSql, runReadOnlySql } from '../lib/db.mjs'
import { assertLocalWmsWriteTarget, dataOf, isWmsWriteEnabled } from '../lib/wms-fixtures.mjs'

export const mirrorKey = 'wms.erp-warehouse-mirror.preset'

export const warehouseSnapshotSql = `
  SELECT 'warehouse', id, name, ware_address, mark, charge_id,
    CASE WHEN is_enabled=b'1' THEN 0 ELSE 1 END, deleted+0, tenant_id
  FROM mes_wms_ware_house WHERE tenant_id=1 ORDER BY id;
  SELECT 'sale', id, out_id, warehouse_id, \`count\`, deleted+0, tenant_id
  FROM erp_sale_out_items WHERE tenant_id=1 ORDER BY id;
  SELECT 'purchase', id, in_id, warehouse_id, \`count\`, deleted+0, tenant_id
  FROM erp_purchase_in_items WHERE tenant_id=1 ORDER BY id;
  SELECT 'sale-header', id, total_count, deleted+0
  FROM erp_sale_out WHERE tenant_id=1 ORDER BY id;
  SELECT 'purchase-header', id, total_count, deleted+0
  FROM erp_purchase_in WHERE tenant_id=1 ORDER BY id
`

export const warehouseViewSql = `
  SELECT 'table', TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('mes_wms_ware_house','erp_warehouse');
  SELECT 'view', IS_UPDATABLE, VIEW_DEFINITION FROM information_schema.VIEWS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='erp_warehouse';
  SELECT 'projection', COUNT(*), SUM(w.is_enabled=b'1'), SUM(w.is_enabled=b'0'),
    SUM(v.id IS NULL OR NOT (
      v.name <=> w.name AND v.address <=> w.ware_address AND v.remark <=> w.mark
      AND v.principal <=> w.charge_id AND v.deleted <=> w.deleted
      AND v.status <=> CASE WHEN w.is_enabled=b'1' THEN 0 ELSE 1 END
      AND v.sort=0 AND v.default_status=0
      AND v.warehouse_price IS NULL AND v.truckage_price IS NULL))
  FROM mes_wms_ware_house w LEFT JOIN erp_warehouse v
    ON w.id=v.id AND w.tenant_id=v.tenant_id WHERE w.tenant_id=1;
  SELECT 'view-count', COUNT(*) FROM erp_warehouse WHERE tenant_id=1;
  SELECT 'sale-reference', COUNT(*), SUM(e.\`count\`), SUM(w.id IS NOT NULL),
    SUM(v.id IS NOT NULL AND v.id=w.id AND v.name=w.name)
  FROM erp_sale_out_items e JOIN erp_sale_out h
    ON e.out_id=h.id AND e.tenant_id=h.tenant_id AND h.deleted=0
  LEFT JOIN mes_wms_ware_house w ON CAST(e.warehouse_id AS CHAR)=w.id AND e.tenant_id=w.tenant_id
  LEFT JOIN erp_warehouse v ON CAST(e.warehouse_id AS CHAR)=v.id AND e.tenant_id=v.tenant_id
  WHERE e.tenant_id=1 AND e.deleted=0;
  SELECT 'purchase-reference', COUNT(*), SUM(e.\`count\`), SUM(w.id IS NOT NULL),
    SUM(v.id IS NOT NULL AND v.id=w.id AND v.name=w.name)
  FROM erp_purchase_in_items e JOIN erp_purchase_in h
    ON e.in_id=h.id AND e.tenant_id=h.tenant_id AND h.deleted=0
  LEFT JOIN mes_wms_ware_house w ON CAST(e.warehouse_id AS CHAR)=w.id AND e.tenant_id=w.tenant_id
  LEFT JOIN erp_warehouse v ON CAST(e.warehouse_id AS CHAR)=v.id AND e.tenant_id=v.tenant_id
  WHERE e.tenant_id=1 AND e.deleted=0
`

// Each statement has an empty selection, even if a regression makes the view writable.
export const viewWriteProbes = Object.freeze([
  ['INSERT', "INSERT INTO erp_warehouse (id,name,tenant_id) SELECT 'E2E-QC010-NO-ROW','E2E-QC010',1 WHERE 1=0", 1471],
  ['UPDATE', 'UPDATE erp_warehouse SET name=name WHERE 1=0', 1288],
  ['DELETE', 'DELETE FROM erp_warehouse WHERE 1=0', 1288]
])

const add = (record, name, passed, details = '') => {
  record.checks.push({ name, passed: Boolean(passed), details })
}
const count = (value) => /^\d+$/.test(String(value)) ? Number(value) : NaN

export const isReadonlyViewRejection = (error, code) =>
  new RegExp(`^ERROR ${code} \\(HY000\\).*erp_warehouse.*not (?:updatable|insertable)`, 's')
    .test(String(error?.message || ''))

export const verifyLegacyWarehouse = async ({
  api, caseRecord, pageResponse, dependencies = {}
}) => {
  const read = dependencies.runReadOnlySql || runReadOnlySql
  const write = dependencies.runLocalFixtureSql || runLocalFixtureSql
  const safety = dependencies.assertLocalWriteSafety || assertLocalWriteSafety
  const enabled = dependencies.writeEnabled ?? isWmsWriteEnabled()
  const before = await read(warehouseSnapshotSql)
  const facts = await read(warehouseViewSql)
  if (!before.available || !facts.available) {
    caseRecord.notes.push('WMS-QC-010 缺本地数据库证据，不以分页或四个退役码代替视图只读闭环。')
    return { covered: false }
  }
  caseRecord.database = [...(caseRecord.database || []),
    { stage: 'warehouse-view-facts', ...facts }]
  const tagged = (tag) => facts.rows.find((row) => row[0] === tag)
  const type = (name) => facts.rows.find((row) => row[0] === 'table' && row[1] === name)?.[2]
  const view = tagged('view')
  add(caseRecord, '数据库确认公共仓库为表且旧 ERP 仓库为不可更新视图',
    type('mes_wms_ware_house') === 'BASE TABLE' && type('erp_warehouse') === 'VIEW' &&
      view?.[1] === 'NO' && /from\s+.*`mes_wms_ware_house`/i.test(view?.[2] || ''),
    `wms=${type('mes_wms_ware_house')}; erp=${type('erp_warehouse')}; IS_UPDATABLE=${view?.[1]}`)

  const projection = tagged('projection')
  const total = count(projection?.[1])
  const matched = total > 0 && count(tagged('view-count')?.[1]) === total &&
    count(projection?.[4]) === 0
  add(caseRecord, '视图与公共仓库主键和租户逐项同源',
    matched, `warehouseRows=${total}; viewRows=${tagged('view-count')?.[1]}; mismatches=${projection?.[4]}`)
  add(caseRecord, '启停状态及费用排序默认标记投影逐项核对',
    matched && count(projection?.[2]) > 0 && count(projection?.[3]) > 0,
    `enabled=${projection?.[2]}; disabled=${projection?.[3]}; mismatches=${projection?.[4]}`)

  const warehouses = new Map(before.rows.filter((row) => row[0] === 'warehouse')
    .map((row) => [String(row[1]), row]))
  const rows = pageResponse?.data?.list
  add(caseRecord, '旧仓库非空分页逐项对应本租户公共仓库',
    pageResponse?.code === 0 && Array.isArray(rows) && rows.length > 0 &&
      rows.length <= 100 && Number(pageResponse.data.total) ===
        before.rows.filter((row) => row[0] === 'warehouse' && row[7] === '0').length &&
      rows.every((row) => {
        const source = warehouses.get(String(row.id))
        return source && row.name === source[2] && String(row.status) === source[6] &&
          source[7] === '0' && source[8] === '1' && String(row.sort) === '0' &&
          row.defaultStatus === false && row.warehousePrice == null && row.truckagePrice == null
      }),
    `pageRows=${Array.isArray(rows) ? rows.length : 'invalid'}; total=${pageResponse?.data?.total}`)

  for (const [tag, label] of [['sale-reference', '销售出库'], ['purchase-reference', '采购入库']]) {
    const fact = tagged(tag)
    const n = count(fact?.[1])
    add(caseRecord, `${label}历史非空明细的仓库 ID 与数量同源对账`,
      n > 0 && Number(fact?.[2]) > 0 && count(fact?.[3]) === n && count(fact?.[4]) === n,
      `rows=${fact?.[1]}; qty=${fact?.[2]}; wmsMatches=${fact?.[3]}; viewMatches=${fact?.[4]}`)
  }

  if (!enabled) {
    caseRecord.notes.push('未开启本地写侧门禁，未执行无数据写入拒绝探针和镜像项定向 apply。')
    return { covered: false }
  }
  assertLocalWmsWriteTarget(dependencies.config || config)
  await safety(caseRecord)
  for (const [operation, sql, code] of viewWriteProbes) {
    let error
    try {
      await write(`START TRANSACTION; ${sql}; ROLLBACK;`)
    } catch (caught) {
      error = caught
    }
    add(caseRecord, `数据库拒绝旧仓库视图 ${operation}`,
      isReadonlyViewRejection(error, code), error?.message || 'SQL unexpectedly succeeded')
  }

  const request = { modules: ['wms'], keys: [mirrorKey], firstRun: false }
  const preview = dataOf(await api.postBusiness('/system/system-init/preset/preview', request))
  const applied = dataOf(await api.postBusiness('/system/system-init/preset/apply', request))
  const onlyMirror = (response) => response?.contributions?.length === 1 &&
    response.contributions[0].key === mirrorKey &&
    response.contributions[0].status === 'READY' &&
    response.contributions[0].added === 0 && response.contributions[0].modified === 0 &&
    response.contributions[0].conflicts === 0 &&
    response.contributions[0].skipped > 0 && response.added === 0 && response.modified === 0 &&
    response.conflicts === 0
  add(caseRecord, '定向镜像预览与 apply 仅返回只读对账结果',
    preview?.applied === false && applied?.applied === true &&
      onlyMirror(preview) && onlyMirror(applied) && preview.skipped === applied.skipped,
    JSON.stringify({ preview, applied }))

  const after = await read(warehouseSnapshotSql)
  const unchanged = after.available && JSON.stringify(before.rows) === JSON.stringify(after.rows)
  add(caseRecord, '拒绝探针和镜像对账前后仓库及历史单据明细完全不变',
    unchanged, `beforeRows=${before.rows.length}; afterRows=${after.rows?.length}; unchanged=${unchanged}`)
  caseRecord.database.push({ stage: 'legacy-warehouse-unchanged',
    beforeRows: before.rows.length, afterRows: after.rows?.length, unchanged })
  return { covered: caseRecord.checks.every((check) => check.passed !== false) }
}
