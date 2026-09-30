// CFOR E2E 统一入口。修复 v1 的五个问题：
//  1. caseId 必传给 suite.runCase（v1 漏传导致 SMOKE/FMS 分支走错）；
//  2. checkpoint 只写不读 → 现在 --resume 默认读断点跳过已通过用例；
//  3. --reuse-session 只解析不实现 → 现在经 storageState 真正复用登录态；
//  4. PARTIAL 空桩被记 PASS → 未实现的用例只记 PARTIAL/SKIP，绝不伪造 PASS；
//  5. CFOR_API_BASE 语义混乱 → config.apiUrl 已含 /admin-api 前缀，lib 不再拼接。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from './config/index.mjs'
import { launchBrowser, restoreSession, saveScreenshot } from './lib/browser.mjs'
import { checklist } from './lib/assert.mjs'
import { newRun, recordCase, writeReport, loadCheckpoint, saveCheckpoint, clearCheckpoint, ensureDir } from './lib/report.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const catalog = JSON.parse(fs.readFileSync(path.join(here, 'cases/catalog.json'), 'utf8'))

const SUITE_FILE = {
  smoke: 'smoke.mjs',
  fms: 'fms.mjs'
}
const suiteFile = (id) => SUITE_FILE[id] || 'stub.mjs'

function parseArgs (argv) {
  const a = { suite: 'all', case: '', list: false, resume: true, reuseSession: config.reuseSession, evidenceDir: config.evidenceDir }
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]
    if (t === '--list') a.list = true
    else if (t === '--suite') a.suite = argv[++i]
    else if (t === '--case') a.case = argv[++i]
    else if (t === '--resume') a.resume = true
    else if (t === '--no-resume' || t === '--fresh') a.resume = false
    else if (t === '--reuse-session') a.reuseSession = true
    else if (t === '--no-reuse-session') a.reuseSession = false
    else if (t === '--evidence-dir') a.evidenceDir = argv[++i]
    else if (t === '--headless') process.env.CFOR_HEADLESS = 'true'
    else if (t === '--no-headless') process.env.CFOR_HEADLESS = 'false'
  }
  return a
}

/** 按 dependsOn 拓扑排序 */
function orderedSuites (suites) {
  const byId = new Map(suites.map((s) => [s.id, s]))
  const seen = new Set()
  const out = []
  const visit = (s) => {
    if (seen.has(s.id)) return
    seen.add(s.id)
    for (const d of s.dependsOn || []) if (byId.has(d)) visit(byId.get(d))
    out.push(s)
  }
  suites.forEach(visit)
  return out
}

function printList () {
  console.log('caseId | suite | status | title')
  for (const s of catalog.suites) {
    for (const c of s.cases) {
      console.log(`${c.id} | ${s.id} | ${c.status} | ${c.title}`)
    }
  }
}

async function main () {
  const args = parseArgs(process.argv.slice(2))
  if (args.list) return printList()

  let suites = catalog.suites
  if (args.suite !== 'all') suites = suites.filter((s) => s.id === args.suite)
  if (!suites.length) throw new Error(`未知 suite：${args.suite}`)
  if (args.case) {
    suites = suites.map((s) => ({ ...s, cases: s.cases.filter((c) => c.id === args.case) })).filter((s) => s.cases.length)
    if (!suites.length) throw new Error(`未知 case：${args.case}`)
  }
  suites = orderedSuites(suites)

  const evidenceDir = ensureDir(args.evidenceDir)
  const runId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const run = newRun(evidenceDir, runId)
  console.log(`[e2e] target=${config.target} web=${config.webUrl} api=${config.apiUrl}`)
  console.log(`[e2e] 证据目录：${run.dir}`)

  const ckptBase = evidenceDir // 断点放在 evidence 根，跨 run 生效
  if (!args.resume) clearCheckpoint(ckptBase)
  const passedCkpt = args.resume ? loadCheckpoint(ckptBase) : []
  if (passedCkpt.length) console.log(`[e2e] 断点续跑：跳过已通过 ${passedCkpt.length} 个用例`)

  const sessionFile = path.join(evidenceDir, 'session.json')
  const browser = await launchBrowser()
  const newContext = async () => browser.newContext(
    args.reuseSession && fs.existsSync(sessionFile) ? { storageState: sessionFile } : {}
  )
  // 跨 case 共享的会话上下文（token 复用 = 登录一次）
  const sharedCtx = { browser, context: await newContext(), token: '', tenantId: '', api: null }

  if (args.reuseSession && fs.existsSync(sessionFile)) {
    const p = await sharedCtx.context.newPage()
    try {
      const restored = await restoreSession(p, sharedCtx)
      if (restored) {
        Object.assign(sharedCtx, restored)
        console.log('[e2e] 已复用上次登录态，跳过重复登录')
      } else {
        fs.unlinkSync(sessionFile)
      }
    } catch { try { fs.unlinkSync(sessionFile) } catch {} }
    await p.close()
  }

  const findCase = (id) => { for (const s of catalog.suites) { const c = s.cases.find((x) => x.id === id); if (c) return { suite: s, ...c } } return null }

  for (const suite of suites) {
    const module = await import(`./suites/${suiteFile(suite.id)}`)
    for (const c of suite.cases) {
      const meta = findCase(c.id)
      const status = meta.status
      const rec = { caseId: c.id, suite: suite.id, title: meta.title, status: '', durationMs: 0, steps: [], note: '', error: '' }

      if (status === 'DESIGNED' || status === 'BLOCKED') {
        rec.status = 'SKIP'; rec.note = `${status}：步骤未实现或被阻塞，未执行`
        recordCase(run, rec); console.log(`[SKIP] ${c.id}（${status}）`)
        continue
      }
      if (args.resume && passedCkpt.includes(c.id)) {
        rec.status = 'SKIP'; rec.note = '断点续跑：此前已通过'
        recordCase(run, rec); console.log(`[SKIP] ${c.id}（断点已通过）`)
        continue
      }

      // --no-reuse-session：每个用例全新上下文 + 重新登录
      const ctx = args.reuseSession ? sharedCtx : { browser, context: await newContext(), token: '', tenantId: '', api: null }
      const page = await ctx.context.newPage()
      const check = checklist()
      const t0 = Date.now()
      console.log(`[RUN ] ${c.id} ${meta.title}`)
      try {
        // caseId 必传——v1 的教训
        const result = await module.runCase({ caseId: c.id, suiteId: suite.id, page, check, shotDir: run.shotDir, ctx })
        rec.steps = result?.steps || check.steps
        if (result?.notImplemented) {
          rec.status = status === 'PARTIAL' ? 'PARTIAL' : 'SKIP'
          rec.note = result.note || '步骤尚未实现，未执行'
          console.log(`[${rec.status}] ${c.id}（未实现，未伪造通过）`)
        } else {
          rec.status = 'PASS'
          saveCheckpoint(ckptBase, c.id)
          // 登录态落盘，供下次 --reuse-session 使用
          if (args.reuseSession && ctx.token && !fs.existsSync(sessionFile)) {
            await ctx.context.storageState({ path: sessionFile })
          }
          console.log(`[PASS] ${c.id}`)
        }
      } catch (e) {
        rec.status = 'FAIL'
        rec.error = String(e.message || e).slice(0, 500)
        rec.steps = check.steps
        try { await saveScreenshot(page, run.shotDir, `${c.id}-FAIL`) } catch {}
        console.log(`[FAIL] ${c.id} ${rec.error}`)
      } finally {
        rec.durationMs = Date.now() - t0
        await page.close().catch(() => {})
        if (!args.reuseSession) await ctx.context.close().catch(() => {})
        recordCase(run, rec)
      }
    }
  }

  await sharedCtx.context.close().catch(() => {})
  await browser.close().catch(() => {})
  const summary = writeReport(run)
  console.log(`\n[e2e] 完成：共 ${summary.total}，通过 ${summary.passed}，失败 ${summary.failed}，跳过/未实现 ${summary.skipped}`)
  console.log(`[e2e] 报告：${path.join(run.dir, 'summary.md')}`)
  process.exit(summary.failed > 0 ? 1 : 0)
}

main().catch((e) => { console.error('[e2e] 致命错误：', e.message); process.exit(2) })
