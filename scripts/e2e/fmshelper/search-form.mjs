export async function prepareOpeningBatchFilter (page) {
  const field = page.getByPlaceholder('期初导入批次号', { exact: true })
  const collapsed = page.locator('.search-collapse.is-collapsed').filter({ has: field })
  const count = await collapsed.count()
  if (count > 1) throw new Error('期初批次筛选不能匹配多个折叠表单')
  if (count === 1) await collapsed.locator('.search-collapse__toggle').click()
  await field.waitFor({ state: 'visible' })
  const visible = await field.evaluate((input) => {
    const rect = input.getBoundingClientRect()
    const form = input.closest('form')
    if (!form || rect.width <= 0 || rect.height <= 0) return false
    const bounds = form.getBoundingClientRect()
    return form.scrollTop === 0 &&
      rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1 &&
      rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1
  })
  if (!visible) throw new Error('期初批次筛选被裁切，不能直接填写隐藏控件')
  return field
}
