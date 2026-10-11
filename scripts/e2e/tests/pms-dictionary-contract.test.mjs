import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const backend = new URL('../../../../cfor/cfor-admin/', import.meta.url)
const frontend = new URL('../../../../cfor/cfor-admin-vue3/', import.meta.url)
const migration = readFileSync(new URL(
  'cfor-server/src/main/resources/db/migration/V202610111910__seed_pms_collaboration_dicts.sql', backend
), 'utf8')
const dict = readFileSync(new URL('src/utils/dict.ts', frontend), 'utf8')
const enums = [
  ['PMS_PROJECT_TYPE', 'pms_project_type', 'project/PmsProjectTypeEnum.java'],
  ['PMS_PROJECT_MEMBER_LEVEL', 'pms_project_member_level', 'project/PmsProjectMemberLevelEnum.java'],
  ['PMS_WORK_ITEM_TYPE', 'pms_work_item_type', 'workitem/PmsWorkItemTypeEnum.java'],
  ['PMS_WORK_ITEM_PRIORITY', 'pms_work_item_priority', 'workitem/PmsWorkItemPriorityEnum.java'],
  ['PMS_WORK_ITEM_STATUS_TYPE', 'pms_work_item_status_type', 'workitem/PmsWorkItemStatusTypeEnum.java'],
  ['PMS_WORK_ITEM_DEFECT_TYPE', 'pms_work_item_defect_type', 'workitem/PmsWorkItemDefectTypeEnum.java'],
  ['PMS_ITERATION_STATUS', 'pms_iteration_status', 'iteration/PmsIterationStatusEnum.java']
]

for (const [constant, type, path] of enums) {
  test(`PMS dictionary ${type} preserves the backend fixed enum codes and labels`, () => {
    assert.match(dict, new RegExp(`${constant} = '${type}'`))
    const source = readFileSync(new URL(
      `cfor-module-pms/cfor-module-pms-biz/src/main/java/tech/cfor17/module/pms/enums/pm/${path}`, backend
    ), 'utf8')
    const values = [...source.matchAll(/^\s+[A-Z_]+\((\d+), "([^"]+)"\)/gm)]
    assert.ok(values.length > 1)
    for (const [, value, label] of values) {
      assert.ok(migration.includes(`'${label}'`) && migration.includes(`'${value}'`))
    }
  })
}

test('PMS dictionary migration only inserts absent platform templates without IDs or updates', () => {
  assert.doesNotMatch(migration, /\b(?:UPDATE|DELETE|ALTER|DROP|REPLACE)\b/i)
  assert.equal([...migration.matchAll(/WHERE NOT EXISTS/g)].length, 2)
  assert.equal([...migration.matchAll(/existing\.tenant_id = 0/g)].length, 2)
  assert.match(migration, /existing\.dict_type = item\.dict_type\s+AND existing\.value = item\.value/)
  assert.doesNotMatch(migration, /\(id,/i)
})
