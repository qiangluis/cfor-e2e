import assert from 'node:assert/strict'
import test from 'node:test'
import { ApsSchedulingFixture } from '../fixtures/mes-aps-write.mjs'

test('APS fixture preserves Snowflake version IDs in the calculate request', async () => {
  const requests = []
  const api = {
    async getBusiness(path) {
      requests.push({ path })
      if (path === '/mes/aps/scheduling/get?id=2108247197519138818') {
        return { code: 0, data: { id: '2108247197519138818' } }
      }
      throw new Error(`unexpected GET path: ${path}`)
    },
    async postBusiness(path, body) {
      requests.push({ path, body })
      if (path === '/mes/aps/scheduling/create') {
        return { code: 0, data: '2108247197519138818' }
      }
      if (path === '/mes/aps/scheduling/calculate') {
        return { code: 0, data: { versionId: body.versionId } }
      }
      throw new Error(`unexpected API path: ${path}`)
    }
  }
  const fixture = new ApsSchedulingFixture(api, {}, 'MES-APS-001')
  fixture.execution = {
    async setup() {
      fixture.execution.works = [{ id: '2108247196818690049' }]
      fixture.execution.route = { id: '2108247194591514626', identity: 'AUTOTEST-ROUTE' }
    },
    works: [],
    route: {}
  }

  await fixture.setup({ notes: [] })

  const calculate = requests.find((request) =>
    request.path === '/mes/aps/scheduling/calculate')
  assert.equal(calculate.body.versionId, '2108247197519138818')
  assert.equal(typeof calculate.body.versionId, 'string')
})
