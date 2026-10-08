# CFOR 5.0.1 E2E 本地受控数据修正记录

本文件只记录标准租户（`cfor_admin_standard`，tenant_id=1）本地验收环境中的一次性数据修正。
这些不是主线结构变更，因此不新增 Flyway；生产环境不得照抄执行。

## 2026-10-08 商机执行状态历史空值

- 背景：`crm_business.execution_status` 允许为空。旧后端创建的 4 条 `E2E-SALES-*` 商机在服务端补默认值逻辑生效前落库为 NULL，
  导致 CRM-BASE-001「商机阶段、执行编码与终态保持独立字段」断言失败。
- 代码侧修复：`CrmBusinessServiceImpl#createBusiness` 在 `executionStatus` 为空时写入 `PENDING`（待推进）。
- 历史数据修正：

```sql
UPDATE crm_business
SET execution_status = 'PENDING'
WHERE deleted = 0 AND tenant_id = 1 AND execution_status IS NULL;
```

- 影响行数：4；执行后 `execution_status IS NULL` 计数为 0。
- 遗留建议：如需彻底防呆，应单独评估把该列改为 `NOT NULL DEFAULT 'PENDING'` 的结构变更，本次未擅自改动。
- 口径澄清（同日追加）：CRM-BASE-001 catalog 明确“赢单/战败只保存到 `end_status`，不写入 `execution_status`”，
  因此终态商机（`end_status IS NOT NULL`）的 `execution_status` 允许为空。原 E2E 断言对所有商机强制要求字符串，
  属于测试断言过严，已在 `scripts/e2e/suites/crm.mjs` 改为：未结束商机必须有稳定执行编码，终态商机允许为空。
  因此上面回填的终态行数据不改回，仅代表本地历史数据一致化。

## 2026-10-08 商机执行状态（前一轮）回填

```sql
UPDATE cfor_admin_standard.crm_business
SET execution_status = 'PENDING'
WHERE deleted = 0 AND execution_status IS NULL AND name LIKE 'E2E-SALES-%';
```

- 影响行数：8；执行后标准租户内 `E2E-SALES-%` 的 NULL 计数为 0。
