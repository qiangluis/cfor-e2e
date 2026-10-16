import assert from 'node:assert/strict'

export const PROJECT_MENU_ROOT_IDS = [29612002, 265880, 29612007, 29612023, 29612025]
export const PROJECT_BUSINESS_MENU_NAMES = Object.freeze({
  29612007: [
    '项目交接', '框架基线与建档', '框架调研', '详细调研', '解决方案与需求确认',
    '里程碑与计划', '任务执行', '风险问题与变更', '日报与周报', '发布与上线切换',
    '上线跟踪', '验收、复盘与售后移交'
  ],
  29612023: ['研发计划', '研发任务', '测试验证', '发布与上线切换', '研发交付'],
  29612025: [
    '项目总览', '项目进度', '任务执行报表', '研发进度与效率', '调研报表',
    '风险问题与缺陷', '计划变更', '发布报表', '上线问题', '验收整改',
    '项目复盘', '售后移交', '项目结项', '绩效与风险趋势'
  ]
})

export function assertProjectBusinessMenus (rows) {
  for (const [parentId, names] of Object.entries(PROJECT_BUSINESS_MENU_NAMES)) {
    const visible = rows.filter((row) => row[0] === parentId && row[4] === '1')
    assert.deepEqual(visible.map((row) => row[2]), names, `项目业务子菜单不完整：${parentId}`)
    assert.equal(new Set(visible.map((row) => row[3])).size, names.length, '可见子菜单地址重复')
    assert.ok(visible.every((row) => row[5] && row[5] !== 'NULL'), '可见入口没有页面组件')
  }
}

export async function verifyProjectBusinessMenuInBrowser (page, rows) {
  const sidebar = page.locator('[id$="-menu"]:not([id$="-top-menu"])')
  await sidebar.waitFor({ state: 'visible' })
  const evidence = []
  for (const [id, prefix] of [
    [29612007, '/project/execution'],
    [29612023, '/project/rd'],
    [29612025, '/project/reporting']
  ]) {
    const group = sidebar.locator(`[data-submenu-index="${prefix}"]`)
    assert.equal(await group.count(), 1, `浏览器缺少唯一项目目录：${prefix}`)
    if (!(await group.getAttribute('class')).includes('is-opened')) {
      await group.locator(':scope > .el-sub-menu__title').click()
    }
    const expected = rows.filter((row) => row[0] === String(id) && row[4] === '1')
    for (const row of expected) {
      const pathname = row[3].startsWith('/') ? row[3] : `${prefix}/${row[3]}`
      const label = sidebar.locator(`span.v-menu__title[data-menu-path="${pathname}"]`)
      assert.equal(await label.count(), 1, `浏览器菜单入口缺失或重复：${pathname}`)
      await label.scrollIntoViewIfNeeded()
      assert.equal(await label.isVisible(), true, `浏览器菜单不可见：${pathname}`)
      assert.equal((await label.innerText()).trim(), row[2])
      evidence.push({ pathname, title: row[2] })
    }
  }
  return evidence
}
