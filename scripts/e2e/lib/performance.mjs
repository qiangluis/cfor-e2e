import { resourceUrl } from './redact.mjs'

export function summarizePagePerformance (snapshot, renderMs, budgetMs = 5000) {
  if (!Number.isFinite(renderMs) || renderMs < 0 ||
      !Number.isFinite(budgetMs) || budgetMs <= 0) {
    throw new Error('Invalid page performance measurement or budget')
  }
  return {
    renderMs,
    budgetMs,
    withinBudget: renderMs <= budgetMs,
    navigation: snapshot.navigation || null,
    slowResources: (snapshot.resources || [])
      .filter((item) => Number.isFinite(item.durationMs) && item.durationMs >= 100)
      .sort((left, right) => right.durationMs - left.durationMs)
      .slice(0, 10)
      .map((item) => ({
        url: resourceUrl(item.url),
        initiatorType: item.initiatorType,
        durationMs: Math.round(item.durationMs),
        waitMs: Number.isFinite(item.waitMs) ? Math.round(item.waitMs) : null
      }))
  }
}

export async function collectPagePerformance (page, renderMs, budgetMs = 5000) {
  const snapshot = await page.evaluate(() => {
    const navigation = performance.getEntriesByType('navigation')[0]
    return {
      navigation: navigation ? {
        type: navigation.type,
        responseMs: Math.round(navigation.responseEnd),
        domContentLoadedMs: Math.round(navigation.domContentLoadedEventEnd),
        loadMs: Math.round(navigation.loadEventEnd)
      } : null,
      resources: performance.getEntriesByType('resource').map((item) => ({
        url: item.name,
        initiatorType: item.initiatorType,
        durationMs: item.duration,
        waitMs: item.responseStart > 0 ? item.responseStart - item.requestStart : null
      }))
    }
  })
  return summarizePagePerformance(snapshot, renderMs, budgetMs)
}
