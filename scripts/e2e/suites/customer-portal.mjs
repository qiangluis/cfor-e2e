import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const cases = [
  'CP-158-001',
  'CP-160-161-001',
  'CP-162-164-001',
  'CP-165-166-167-168-169-001',
  'CP-164-168-002'
]

// 客户门户是独立构建与独立登录态，公共 runner 通过独立 smoke 脚本复用同一套
// 路由桩：只要一次 smoke 通过，就说明 PB-158~169 的端到端链路在当前构建下可用。
let smokeResult

const runSmoke = () =>
  new Promise((resolve) => {
    if (smokeResult) return resolve(smokeResult)
    const script = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      'customer-portal-smoke.mjs'
    )
    const child = spawn(process.execPath, [script], { stdio: 'pipe' })
    let output = ''
    child.stdout.on('data', (chunk) => (output += chunk))
    child.stderr.on('data', (chunk) => (output += chunk))
    child.on('close', (code) => {
      smokeResult = { code, output }
      resolve(smokeResult)
    })
  })

export const runCase = async () => {
  const result = await runSmoke()
  if (result.code !== 0) {
    throw new Error(`customer portal smoke failed:\n${result.output}`)
  }
}
