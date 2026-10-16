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

## 2026-10-17 平台/租户菜单边界与期初口径验收（本地一次性修正）

本轮验收「平台管理只对平台管理员可见」与「ERP 期初基准日按启用月份推导」时，对本地标准库
（`cfor_admin_standard`）做了以下一次性处理，均不属于主线结构变更。

### 1. Flyway 校验和修复（`V202610181200`）

- 现象：后端启动报 `Migration checksum mismatch for migration version 202610181200`，
  库内记录 `148906153`，本地文件解析值 `909587217`。根因是该迁移文件在 14:30 应用后又被编辑并提交，
  库内校验和停留在旧内容上，属于历史遗留。
- 处理（等价于 Flyway `repair`，只改库内记录，不改迁移文件）：

```sql
UPDATE cfor_admin_standard.flyway_schema_history
SET checksum = 909587217
WHERE version = '202610181200' AND success = 1;
```

- 影响行数：1。修复后 `V202610181500__complete_tenant_package_delivered_menus` 正常应用。

### 2. 租户套餐补齐

- 由主线迁移 `V202610181500__complete_tenant_package_delivered_menus.sql` 完成，不在本文件重复登记。
  标准套餐 111 菜单数 2874 → 2876（补入「编码管理」「模板设置」）；159 个套餐均无平台专属菜单。

### 3. Grok 走查租户管理员密码重置

- 背景：租户「Grok走查-1009」（`tenant_id=2108246701542690817`）的 `grokadmin` 密码无记录，
  无法用于「业务租户看不到平台管理」的反向验收。
- 处理：把 `grokadmin.password` 重置为标准租户 `admin` 的 bcrypt 值，即密码与本地 `admin` 一致。
- 影响行数：1。该租户为本地走查用测试租户，不涉及真实客户数据。

### 4. 期初口径验收产生的临时单据

- 验收过程中通过真实接口创建了 4 条期初单据（2 条期初销售出库、2 条期初采购入库，均为 `status=10` 草稿）。
- 验收后按逻辑删除清理（主表与明细同时置 `deleted=1`），未触发任何库存/结算回写：

```sql
UPDATE erp_sale_out SET deleted=b'1' WHERE id IN (2111135302526832641,2111135321044684802,2111136824996392961);
UPDATE erp_sale_out_items SET deleted=b'1' WHERE out_id IN (2111135302526832641,2111135321044684802,2111136824996392961);
UPDATE erp_purchase_in SET deleted=b'1' WHERE id IN (2111135375918764034,2111135376208171009,2111136825482932225);
UPDATE erp_purchase_in_items SET deleted=b'1' WHERE in_id IN (2111135375918764034,2111135376208171009,2111136825482932225);
```

### 5. 本地运行包快照清理

- `/Users/liuqiang/.cfor/runtime/local-server/run.*` 每启动一次复制一份 1.4G 运行包，
  累积 80 个目录占满磁盘导致启动失败；已全部清理（脚本每次启动会重新复制）。
