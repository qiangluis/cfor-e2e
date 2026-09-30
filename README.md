# CFOR E2E v2

playwright-core + 本机 Chrome 的端到端回归。按《CFOR 5.0.1 功能/测试规范》第 12 章方案重写，
用例清单来自 `scripts/e2e/cases/catalog.json`（34 个 case，11 个 suite）。

## 快速开始（在 Mac 上）

```bash
cd cfor-e2e
pnpm install        # 或 npm install
cp .env.example scripts/e2e/.env
# 编辑 scripts/e2e/.env：填 CFOR_PASS（必需），确认 CFOR_CHROME_PATH
pnpm test:e2e:smoke   # 第一步：SMOKE-001 + SMOKE-002
# 想看浏览器实际执行过程（默认 headless 不弹窗口）：
node scripts/e2e/runner.mjs --suite smoke --no-headless
pnpm test:e2e:full    # 全量（未实现的用例会诚实标记，不伪造通过）
```

常用参数：`--list` 列用例；`--suite fms` 只跑某套件；`--case FMS-001` 只跑单个；
`--fresh` 清除断点从头跑（默认断点续跑）；`--no-reuse-session` 每个用例重新登录；
`--no-headless` 有头调试。

## 环境变量

| 变量 | 说明 | 默认 |
|---|---|---|
| CFOR_TARGET | online / local | online |
| CFOR_BASE_URL | online 站点根地址 | https://jixu-ai.com |
| CFOR_API_PREFIX | API 前缀（与前端 public/config.json 的 projectUrl 一致） | /admin-api |
| CFOR_WEB_URL / CFOR_LOCAL_API_URL | local 目标的前后端地址 | 127.0.0.1:9160 / 48083 |
| CFOR_TENANT / CFOR_USER / CFOR_PASS | 登录身份（密码只从环境/.env 读） | 福奇科技 / admin / 必填 |
| CFOR_CHROME_PATH | 本机 Chrome 可执行文件 | 自动探测 |
| CFOR_EVIDENCE_DIR | 证据输出 | /tmp/cfor-e2e |

注意：`CFOR_API_PREFIX` 只在 config 里拼一次，`lib/api.mjs` 不再拼接——
旧版把含 `/admin-api` 的地址又拼一次导致 404 的坑已填。

## 证据输出

```
$CFOR_EVIDENCE_DIR/<runId>/
  result.json      # 机器可读结果
  summary.md       # 人读报告（含分层断言明细）
  screenshots/     # 每个用例截图，失败时额外存 *-FAIL.png
$CFOR_EVIDENCE_DIR/checkpoint.json  # 断点：已通过的 caseId（--fresh 清除）
$CFOR_EVIDENCE_DIR/session.json     # 登录态（--reuse-session 复用）
```

## 定时巡检（GitHub Actions）

`.github/workflows/e2e-nightly.yml`：每天 02:00（北京时间）自动跑冒烟（`--suite smoke --fresh`），
全程 headless。

- 仓库 Settings → Secrets → Actions 里加一个 secret：`CFOR_PASS`（测试账号密码，其它配置已写在 workflow 里）。
- 每次运行的证据包（summary.md + 截图）自动上传为 Artifact，保留 30 天。
- 失败时自动在仓库建 Issue（标签 `e2e-nightly`）并附上 summary；问题没修好之前的新失败会追加评论到同一个 Issue，不刷屏。
- 想手动触发：Actions 页 → "CFOR E2E 定时巡检" → Run workflow，可选 smoke/init/all。

## v1 → v2 修复清单

1. runner 漏传 `caseId` 给 suite（SMOKE/FMS 分支走错）→ 必传。
2. 登录成功判定解析加密响应体 `body.code`（前端实际加密了响应，必失败）→
   改为页面状态判定（离开 /login + 用户标识可见）。
3. checkpoint 只写不读 → 默认读断点续跑。
4. `--reuse-session` 只解析不实现 → storageState 真正复用，默认登录一次。
5. PARTIAL 空桩被记 PASS → 未实现只记 PARTIAL/SKIP。
6. 登录是"租户校验 → 用户名密码"多步流程 → 先填租户名触发校验再填账号。
7. 租户显示名陷阱：登录后右上角显示「乐之木电子科技」而非注册名「福奇科技」→
   租户断言走 API 的 tenantId，不走页面显示名。

## 当前状态

- 已真实实现：SMOKE-001、SMOKE-002、FMS-001、FMS-002。
- 其余 30 个 case 为 DESIGNED/BLOCKED 诚实桩（runner 跳过，不伪造通过）。
- 登录页选择器在 `scripts/e2e/lib/browser.mjs` 顶部 SEL，多候选兜底；
  以浏览器实测为准，若线上 DOM 漂移优先按实测调整。
