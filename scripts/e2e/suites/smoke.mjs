import { checkHealth, createApiClient } from '../lib/api.mjs'
import { login, openRoute, saveScreenshot } from '../lib/browser.mjs'
import { config } from '../config/index.mjs'

export const runCase = async ({ caseId, page, record, caseRecord, outputDir }) => {
  const { response, body } = await checkHealth()
  caseRecord.checks.push({
    name: '后端健康检查',
    passed: response ? response.ok && body?.status === 'UP' : true,
    details: response
      ? `${config.apiHealthUrl}`
      : '生产环境未暴露 actuator，改由真实登录和业务 API 验证'
  })

  const token = await login(page)
  const api = createApiClient({ token, record })
  const permission = await api.getPermissionInfo()
  if (permission?.code !== 0) throw new Error(`权限回读失败：code=${permission?.code}`)
  caseRecord.checks.push({
    name: '真实登录成功',
    passed: Boolean(token) && permission?.code === 0 &&
      String(permission?.data?.user?.username || '') === config.username,
    details: `tenant=${config.tenantId}`
  })
  caseRecord.checks.push({
    name: '当前租户具有真实菜单权限',
    passed: Array.isArray(permission?.data?.menus) && permission.data.menus.length > 0,
    details: `菜单数=${permission?.data?.menus?.length || 0}`
  })

  if (caseId === 'SMOKE-001') {
    const onboardingRequired = Boolean(permission.data.onboardingRequired)
    const expectedPath = onboardingRequired ? '/systemInit/index' : '/index'
    await page.locator(onboardingRequired ? '.system-init .init-wizard' : '.todo-panel')
      .first().waitFor({ state: 'visible' })
    caseRecord.checks.push({
      name: '登录后按真实初始化状态进入引导中心或普通工作台',
      passed:
        !new URL(page.url()).pathname.startsWith('/login') &&
        new URL(page.url()).pathname === expectedPath &&
        new URL(page.url()).searchParams.get('mode') !== 'collaboration',
      details: `onboardingRequired=${onboardingRequired}，${page.url()}`
    })
    if (!onboardingRequired) {
      const inactiveHomes = [
        '/src/views/mes/workbench/portal.vue',
        '/src/views/erp/home/index.vue',
        '/src/views/iot/home/index.vue',
        '/src/views/plm/workbench/dashboard/index.vue',
        '/src/views/quality/workbench/index.vue',
        '/src/views/project-management/workbench/index.vue'
      ]
      const requestedHomes = await page.evaluate((paths) =>
        performance.getEntriesByType('resource')
          .map((entry) => new URL(entry.name).pathname)
          .filter((pathname) => paths.includes(pathname)),
      inactiveHomes)
      caseRecord.checks.push({
        name: '普通工作台不提前加载未访问的六个业务域首页',
        passed: requestedHomes.length === 0,
        details: JSON.stringify(requestedHomes)
      })
    }
    await saveScreenshot(page, outputDir, 'smoke-login', record)
  } else {
    await openRoute(page, '/index')
    await page.locator('.todo-panel').first().waitFor({ state: 'visible' })
    caseRecord.checks.push({
      name: '顶部工作台入口对应普通工作台',
      passed: new URL(page.url()).pathname === '/index' &&
        new URL(page.url()).searchParams.get('mode') !== 'governance',
      details: page.url()
    })
    await openRoute(page, '/system/tenant-workbench')
    await page.locator('.personal-workbench .todo-panel').waitFor()
    caseRecord.checks.push({
      name: '旧租户管理入口归并到统一工作台，不渲染第二套首页',
      passed: new URL(page.url()).pathname === '/index' &&
        await page.locator('.personal-workbench').isVisible() &&
        await page.locator('.tenant-workbench').count() === 0,
      details: page.url()
    })
    const quickLabels = await page.locator('.quick-actions-strip .quick-action-label')
      .allTextContents()
    caseRecord.checks.push({
      name: '快捷栏同一入口不重复展示',
      passed: quickLabels.length > 0 && new Set(quickLabels).size === quickLabels.length,
      details: quickLabels.join(' / ')
    })
    await saveScreenshot(page, outputDir, 'smoke-workbench', record)
    await page.locator('[class*="-setting"].fixed').click()
    const settings = page.locator('.el-drawer:visible').filter({ hasText: '项目配置' })
    await settings.locator('[class*="-layout-radio-picker__classic"]').waitFor({ state: 'visible' })
    await settings.locator('[class*="-interface-display"] .el-switch').first()
      .waitFor({ state: 'visible' })
    await settings.locator('[class*="-color-radio-picker"]').first().waitFor({ state: 'visible' })
    caseRecord.checks.push({
      name: '首次打开设置抽屉，异步布局、颜色与界面控件可用',
      passed: true,
      details: '只打开并关闭，不修改用户设置'
    })
    await saveScreenshot(page, outputDir, 'smoke-settings-first-open', record)
    await settings.getByRole('button', { name: /关闭此对话框|Close this dialog/ }).click()
    await settings.waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: '唤醒企业 AI 助手', exact: true }).click()
    const assistant = page.getByRole('complementary', { name: '企业 AI 助手' })
    await assistant.waitFor({ state: 'visible' })
    await assistant.locator('.chroma-key-video canvas').waitFor({ state: 'visible' })
    await page.waitForFunction(() => {
      const root = document.querySelector('aside[aria-label="企业 AI 助手"]')
      const video = root?.querySelector('video')
      const canvas = root?.querySelector('canvas')
      if (!video || !canvas || video.readyState < 2 || video.paused) return false
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
      let visiblePixels = 0
      for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index + 3] > 128 &&
          Math.min(pixels[index], pixels[index + 1], pixels[index + 2]) < 240) visiblePixels++
      }
      return visiblePixels > 100
    })
    const playbackStartedAt = await assistant.locator('video').evaluate((video) => video.currentTime)
    await page.waitForFunction((startedAt) => {
      const video = document.querySelector('aside[aria-label="企业 AI 助手"] video')
      return video && !video.paused && Math.abs(video.currentTime - startedAt) > 0.125
    }, playbackStartedAt)
    caseRecord.checks.push({
      name: 'AI 助手首次打开，人物 canvas 非空、视频播放推进且输入框可用',
      passed: await assistant.locator('textarea').isVisible(),
      details: '不发送 AI 查询或业务动作，不代表模型及 AI 业务验收'
    })
    await saveScreenshot(page, outputDir, 'smoke-assistant-first-open', record)
    await assistant.getByRole('button', { name: '缩起', exact: true }).click()
    await assistant.waitFor({ state: 'hidden' })
    await openRoute(page, '/systemInit/index')
    await page.locator('.system-init .init-wizard').first().waitFor({ state: 'visible' })
    caseRecord.checks.push({
      name: '引导中心真实加载且保留在二级入口',
      passed: new URL(page.url()).pathname.startsWith('/systemInit') &&
        await page.locator('.system-init .init-wizard').first().isVisible(),
      details: page.url()
    })
    await saveScreenshot(page, outputDir, 'smoke-guide', record)
  }
  caseRecord.evidence.push('真实登录、健康检查、路由和截图')
  return { token, api }
}

export const cases = ['SMOKE-001', 'SMOKE-002']
