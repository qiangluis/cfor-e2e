# CFOR E2E

独立自动化仓库，使用 `playwright-core` 和本机真实 Chrome。案例来源为
`scripts/e2e/cases/catalog.json`，当前有 34 个套件、268 个案例。
`READY/PARTIAL/DESIGNED/BLOCKED` 是实现状态，不是验收结果。

## 本地执行

本轮只允许后端 `dev / 48083`、前端 `9151`，数据库只读检查仅允许
`127.0.0.1:3306/cfor_admin_standard`。不要启动其他端口或向生产写测试数据。
启动应用的方法见后端《CFOR-5.0.1重启后全功能测试执行清单-20261001.md》。

```bash
cd /Users/liuqiang/code/cfor-standard/cfor-e2e
npm install
cp scripts/e2e/config/local.env.example scripts/e2e/config/local.env
# 在已忽略的 local.env 中配置测试密码；不要提交密码或数据库凭据。
node scripts/e2e/runner.mjs --list
node scripts/e2e/runner.mjs --suite smoke --headed
node scripts/e2e/runner.mjs --suite workbench --headed
node scripts/e2e/runner.mjs --suite all --headed
# 串行批次：可重复传入 --case；默认遇到 FAIL/BLOCKED 即停止
node scripts/e2e/runner.mjs \
  --case COST-002 --case COST-003 --case COST-005 \
  --continue-on-failure
# 服务只需启动一次；并行批次会独立启动 Chrome、进程和证据目录
CFOR_PASSWORD=admin123 node scripts/e2e/parallel-runner.mjs --workers 2
# 查看并行只读组和后续串行组
node scripts/e2e/parallel-runner.mjs --plan
# 统一重启后只复测上一个批次的失败/部分通过案例
CFOR_PASSWORD=admin123 node scripts/e2e/parallel-runner.mjs \
  --case SMOKE-001 --workers 2 --case-timeout-ms 180000
```

环境变量优先于文件配置。默认目标为 local，旧 `.env` 不会隐式切到生产。
新 Mac 使用本机 Chrome 的原生 ARM64 架构，无需安装 Playwright 浏览器。

| 变量 | 用途 |
| --- | --- |
| `CFOR_WEB_BASE` / `CFOR_API_BASE` | 本地前后端地址，固定回环端口 9151 / 48083 |
| `CFOR_TENANT_ID` / `CFOR_TENANT_NAME` | 本轮 `1 / CFOR 标准平台` |
| `CFOR_USERNAME` / `CFOR_PASSWORD` | 主验收账号 admin，密码从环境或 local.env 注入 |
| `CFOR_PURCHASE_APPROVER_USERNAME` / `CFOR_PURCHASE_APPROVER_PASSWORD` | 请购 BPM 第一段采购负责人账号，默认用户名 `purmgr01`，密码只从环境或 local.env 注入 |
| `CFOR_FINANCE_APPROVER_USERNAME` / `CFOR_FINANCE_APPROVER_PASSWORD` | 请购 BPM 第二段财务复核账号，默认用户名 `finrvw01`，密码只从环境或 local.env 注入 |
| `CFOR_FINAL_APPROVER_USERNAME` / `CFOR_FINAL_APPROVER_PASSWORD` | 请购 BPM 第三段负责人终审账号，默认用户名 `opsmgr01`，密码只从环境或 local.env 注入 |
| `CFOR_CHROME_PATH` | 可选，本机 Chrome 可执行文件 |
| `CFOR_E2E_OUT` | 证据目录，默认 `/tmp/cfor-e2e` |
| `CFOR_E2E_PARALLEL_WORKERS` | 并行 worker 数，默认 3；只用于登记为无共享写状态的案例 |
| `CFOR_E2E_CASE_TIMEOUT_MS` | 单例超时，默认 180000；超时进入失败处理，默认停止，`--continue-on-failure` 时收集后续案例 |
| `CFOR_E2E_REQUEST_TIMEOUT_MS` / `CFOR_E2E_BROWSER_TIMEOUT_MS` | 默认 30000 / 60000 ms |
| `CFOR_DB_HOST/PORT/NAME/USER/PASSWORD` | 写侧案例（例如 PROC-014）必需的本地只读取证配置 |
| `CFOR_API_ENCRYPT_REQUEST_KEY` / `CFOR_API_ENCRYPT_RESPONSE_KEY` | API 加密工具使用的环境参数，必须与目标环境一致，不提交实际值 |
| `CFOR_WEB_ROOT` | Vite 检查专项使用的前端源码目录，默认相邻 `cfor/cfor-admin-vue3` |

## 执行规则

- 默认从头执行；显式 `--resume` 才跳过同环境、租户、账号、数据库、用例目录及脚本指纹此前已完整通过的案例。
- `runner.mjs` 的 `--case WBF-001` 仍执行单例，也支持重复传入
  `--case CASE-A --case CASE-B` 组成串行批次；案例按 suite 依赖和 catalog 顺序执行。
  `--suite smoke` 只执行套件，不自动补建其业务前置。
- smoke 检查普通工作台不提前请求未访问的六个业务域首页，并包含首次打开设置抽屉及 AI 助手控件回归。人物视频检查非空 canvas 像素和播放推进，不只检查挂载；只打开/关闭，不修改设置或发送模型查询，不能代表 AI 模型与业务链路已验收。
- 默认在本轮内复用登录态；`--no-reuse-session` 每例使用新的 Chrome 上下文。
- 默认 `FAIL/BLOCKED` 立即停止；只有显式 `--continue-on-failure` 才会收集后续案例。
  continue 模式会先关闭失败案例的 browser/context，再为下一例创建隔离上下文，避免失败页面、登录态和监听器污染下一例。
  `PARTIAL` 按现有规则继续执行；未实现、`DESIGNED`、`BLOCKED` 不会升级为 PASS。
- `parallel-runner.mjs` 只并行执行已登记为无共享写状态的案例；每个案例独立子进程、
  Chrome 上下文和证据目录，失败不会停止其他案例。输出批次下的
  `parallel-result.json` 和 `parallel-summary.md` 是统一重启/复测清单。涉及单据、审批、
  库存、初始化、Job 或账号权限写入的案例保留到串行阶段。
- 并行批次完成后集中修复；应用代码需要重新加载时统一构建、重启，再使用 `--case`
  重跑失败、部分通过和超时案例。仅改脚本、断言或路由定位时无需重启。
  不要为每个案例单独重启。`runner.mjs` 的多个 `--case` 参数可放在同一条串行命令中；
  `parallel-runner.mjs` 的 `--case` 过滤并行安全白名单，二者不是同一执行模式。
- 控制台、页面、业务 API 和浏览器失败请求均参与失败判定；连接错误不能只记录而仍显示通过。
- 未实现、空断言、缺少前置和仅部分实现不得登记 PASS；包含此类案例的全量报告退出非零。
- 多角色业务流程须先通过真实账号接口/页面创建关联用户，再使用相互隔离的 Chrome 上下文。
- 不以页面打开或 HTTP 200 代表业务通过；检查业务 code、真实状态、来源关联、幂等、反向与权限。
- 接口兼容 `CommonResult(code=0)` 与既有 `Result(code=200, success=true)`；`success=false` 或只有 HTTP 200 不能通过。
- `PROC-014` 通过业务接口创建 `AUTOTEST-PROC-*` 两行请购，在 Chrome 中关闭分录并回读数据库；只操作专用测试单据并保留终态证据。权限、整单及反向未全部补齐时报告仍为 `PARTIAL`，退出非零。
- `PROC-014` 会创建仅有请购查询权限的关联账号，以第二个隔离 Chrome 检查关闭入口和接口越权，结束后停用账号；任何失败断言均优先记 `FAIL`，不被 `PARTIAL` 覆盖。
- `PROC-014` 创建单据前必须确认迁移失败数、开启 Job 数与活动 Quartz 触发器数均为 0；`JobStatusEnum.NORMAL=1`、`STOP=2`，不能用 `status=0` 错算开启数。
- `PROC-015/016/017` 保持 PARTIAL：无供应商详情和入口、空数据防重复扫描、来源标签都不等于真实变更、发票复核或来源生成完成。
- `PROC-018` 使用 admin 与三段关联审批账号的独立 Chrome，验证自动转单、逐行来源、无供应商详情、未收货不能关闭及重复审批阻断。
- `PB150-OUTSOURCE-PORTAL-001` 已有真实鉴权和只读前置步骤：无供应商 token 与管理端 token
  必须被供应商 API 拒绝；独立登录只使用显式供应商账号，不继承 admin 密码。9151 必须挂载
  `#supplier-app`，管理端 SPA 回退不是门户证据；账号、客商映射或委外来源缺失时保留 PARTIAL。
  不创建账号、不接受邀请、不提交进度/异常，旧模拟 smoke 不进入业务验收。
- `WMS-OP-001` 默认只读真实 ASN、采购订单明细及已存在的 101 草稿，空集和页面打开不算 PASS。
  写侧必须显式 `CFOR_WMS_OP_WRITE_FIXTURE=1`，且逐一提供本案例专属 ASN、订单、仓库、物料
  及精确归属证据；仅生成/回读/幂等重试/清理本轮未审核草稿，不审核、不改库存。
  历史组件脚本仍隔离到 `scripts/e2e/legacy/`。
- `CRM-BASE-001` 至 `006`、`PROC-006/008` 已有真实只读契约和菜单页面步骤，正常结果仍为
  PARTIAL；配置写入、正式状态转移、历史快照消费及权限反例没有执行时不得登记完整 PASS。
- `COST-030/031/032` 的配置写入绑定同一 caseId/runId/tenant/org/month 及精确登记的字符串 ID；
  名称前缀或共享列表首行不能授权写入，缺少登记时零写入并保留 PARTIAL。

### runner 与 parallel-runner

| 命令 | 执行模型 | 失败处理 | 适用范围 |
| --- | --- | --- | --- |
| `runner.mjs` | 串行；默认复用一个 browser/context | 默认 fail-stop；`--continue-on-failure` 时失败后销毁当前 browser/context，再隔离启动下一例 | 有顺序依赖、业务写侧、多角色或需要稳定上下文的案例 |
| `parallel-runner.mjs` | 多 worker；每例独立子进程、Chrome、context 和证据目录 | 其他 worker 不受单例失败影响，批次结束统一汇总 | 仅适用于静态 `parallelSafeCases` 白名单；不会自动补 suite 或业务前置 |

`parallel-runner.mjs --plan` 的 `serial` 是“未进入并行白名单”的集合，可能包含
`PARTIAL`；它不是当前可直接执行的串行 READY 清单。

## 请购页面前置

重建库可能缺少 `erp_purchase_request_no`。以下命令仅在本地租户 1 完全没有该规则时，
通过真实新增/发布 API 补入历史定义 `CGSQ + yyMMdd + 3 位流水`；已存在的规则不覆盖，
未生效配置不会自动发布。需要配置本地数据库只读凭据，准备报告与业务验收报告分开。
这只能补测试环境前置，不代表初始化模板完整性已通过。

```bash
node scripts/e2e/prepare-purchase-request-numbering.mjs
npm run test:e2e:request-ui
```

页面回归覆盖 1600/1280/1024px 的固定列、输入框全宽点击、筛选展开/收起、
字段配置定位、分页图例、操作列、首屏延迟资源、首次表单真实取号和来源页签。
请购页面回归现在同时检查首屏不超过 5 秒，并记录导航和最慢资源的脱敏耗时；
布局通过但超时仍为 FAIL。须注明是否为重启后的首次访问，不以热缓存通过覆盖冷加载失败。
该回归不代表完整请购状态机已经验收通过。
打开新增表单会消耗编号，但不保存请购单、不生成来源单、不执行打印。

## 证据与基础测试

每轮输出 `result.json`、`summary.md`、`screenshots/`、`trace/browser.zip`。
断点在 `checkpoints/v2-<环境与实现摘要>.json`，同时绑定环境、完整用例目录和运行脚本指纹。
用例状态、断言、套件或公共辅助代码变化后，旧 PASS 不会被复用；PARTIAL/DESIGNED/BLOCKED
不能被旧断点跳过。旧版断点保留但不再读取，`--fresh` 清除当前范围断点。
API 摘要脱敏；Chrome trace 可能包含真实请求与登录凭据，只保留本机，不提交或公开。

```bash
npm run test:e2e:unit
npm run test:e2e:vite-lint
node scripts/e2e/tests/login-layout.mjs
node scripts/e2e/coverage-report.mjs --out /tmp/cfor-e2e/coverage-latest
```

覆盖报告同时输出 `.json` 和 `.md`，`--out` 是文件前缀。按案例选择最新非 SKIPPED
结果，保留来源与证据路径；DESIGNED/BLOCKED 的跳过记录不算已执行。可用 `--root`
限定证据目录、`--since` 限定观察时间。268 个自动化案例不等于 PB-001 至 PB-443
的每一条需求均已验收；PARTIAL、未执行、前置不足和范围外项必须分别报告。

Vite 专项需要前端依赖已安装；使用隔离缓存与自动清理的测试文件，不启动额外端口。
覆盖内容缓存、异步格式化器诊断、源码变化重新报错、修正恢复、生成子模块跳过重复检查与生产构建范围。

应用验收按执行清单 Wave 顺序推进，并把实际结果、缺陷和复测证据回写后端执行清单及回归矩阵。
