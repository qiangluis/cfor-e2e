const stringValue = (value) => value == null ? null : String(value)

const parseSnapshot = (value) => {
  if (typeof value !== 'string' || value.length === 0) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

const sameIdentity = (left, right) =>
  left != null && right != null && stringValue(left) === stringValue(right)

const taskAssignmentId = (task) => task?.assignmentId ?? task?.sourceAssignmentId

const sourcePlanId = (artifact) => artifact?.sourcePlanId ?? artifact?.maintenancePlanId

const sourceVersion = (artifact) => artifact?.sourcePlanVersion ?? artifact?.maintenancePlanVersion

const snapshotFields = ['configSnapshot', 'cycleRuleSnapshot', 'deviceSnapshot']

/**
 * Validate a generated inspection task against the runtime plan that produced it.
 * This deliberately checks the stored JSON rather than only the display version.
 */
export const hasMaintenanceTaskVersionSnapshot = ({
  task,
  runtime,
  device,
  version,
  assignmentId,
  standard,
  cycleValue
} = {}) => {
  const config = parseSnapshot(task?.configSnapshot)
  const cycle = parseSnapshot(task?.cycleRuleSnapshot)
  const devices = parseSnapshot(task?.deviceSnapshot)
  if (!task || !runtime || !config || !cycle || !Array.isArray(devices) || devices.length === 0) {
    return false
  }
  const expectedVersion = Number(version)
  const expectedAssignment = assignmentId ?? runtime.assignmentId
  const expectedStandard = standard == null ? null : String(standard)
  return sameIdentity(task.planId, runtime.id) &&
    sameIdentity(task.sourcePlanId, runtime.sourcePlanId) &&
    Number(task.sourcePlanVersion) === expectedVersion &&
    sameIdentity(taskAssignmentId(task), expectedAssignment) &&
    task.configSnapshot === runtime.configSnapshot &&
    task.cycleRuleSnapshot === runtime.cycleRuleSnapshot &&
    Number(config.version) === expectedVersion &&
    (expectedStandard == null || String(config.items?.[0]?.standard) === expectedStandard) &&
    (cycleValue == null || Number(cycle.cycleValue) === Number(cycleValue)) &&
    devices.some((item) => sameIdentity(item.id, device?.id) &&
      (device?.deviceName == null || item.deviceName === device.deviceName) &&
      (device?.productId == null || sameIdentity(item.productId, device.productId)))
}

/**
 * Validate a repair order generated from a maintenance assignment.
 */
export const hasMaintenanceRepairOrderSnapshot = ({
  order,
  planId,
  version,
  assignmentId,
  deviceId,
  requireIdempotentKey = true
} = {}) => {
  const cycle = parseSnapshot(order?.cycleRuleSnapshot)
  const device = parseSnapshot(order?.deviceSnapshot)
  return Boolean(order) &&
    sameIdentity(sourcePlanId(order), planId) &&
    Number(sourceVersion(order)) === Number(version) &&
    sameIdentity(order.sourceAssignmentId, assignmentId) &&
    sameIdentity(order.deviceId, deviceId) &&
    cycle != null &&
    device != null &&
    sameIdentity(device.deviceId, deviceId) &&
    (!requireIdempotentKey || typeof order.idempotentKey === 'string' && order.idempotentKey.length > 0)
}

/**
 * A historical task/order must retain every source snapshot after a later publish.
 */
export const hasImmutableMaintenanceSnapshot = (before, after, fields = [
  'sourcePlanId', 'sourcePlanVersion', 'assignmentId', 'sourceAssignmentId',
  'configSnapshot', 'cycleRuleSnapshot', 'deviceSnapshot', 'idempotentKey'
]) => Boolean(before && after) && fields.every((field) => {
  if (!(field in before)) return true
  return after[field] === before[field]
})

/**
 * Validate the version rows returned by the read-only version-table probe.
 * Rows may be JDBC arrays or objects from a test double.
 */
export const hasPublishedMaintenanceVersions = (rows, expectedVersions = [1, 2]) => {
  if (!Array.isArray(rows) || rows.length !== expectedVersions.length) return false
  return expectedVersions.every((version, index) => {
    const row = rows[index]
    const actual = Array.isArray(row) ? row[1] : row?.version
    const snapshot = Array.isArray(row) ? row[2] : row?.snapshot_json ?? row?.snapshotJson
    return Number(actual) === Number(version) &&
      typeof snapshot === 'string' && snapshot.length > 0
  })
}

export const hasNoNewMaintenanceArtifacts = (before, after) => {
  if (!Array.isArray(before) || !Array.isArray(after) || before.length !== after.length) return false
  const beforeIds = new Set(before.map((item) => stringValue(item?.id)).filter(Boolean))
  const afterIds = new Set(after.map((item) => stringValue(item?.id)).filter(Boolean))
  return beforeIds.size === before.length && afterIds.size === after.length &&
    beforeIds.size === afterIds.size && [...beforeIds].every((id) => afterIds.has(id))
}

export const hasAssignmentDrivenArtifact = ({
  artifact,
  planId,
  runtimeId,
  version,
  assignmentId,
  deviceId
} = {}) => {
  const artifactPlanId = artifact?.planId
  const matchesRuntime = runtimeId == null || sameIdentity(artifactPlanId, runtimeId)
  return Boolean(artifact) &&
    matchesRuntime &&
    sameIdentity(sourcePlanId(artifact), planId) &&
    Number(sourceVersion(artifact)) === Number(version) &&
    sameIdentity(taskAssignmentId(artifact), assignmentId) &&
    (deviceId == null || sameIdentity(artifact.deviceId, deviceId) ||
      parseSnapshot(artifact.deviceSnapshot)?.some?.((item) => sameIdentity(item.id, deviceId)))
}

/**
 * Build an exact assertion-to-check mapping without changing the frozen catalog.
 * A catalog assertion is VERIFIED only when it has named checks and every named
 * check passed. Callers may force a GAP when runtime evidence cannot prove the
 * business source (for example, manually-created state events).
 */
export const buildMaintenanceCatalogEvidence = ({ definition, checks = [], evidence = {} } = {}) => {
  const assertions = definition?.assertions
  if (!Array.isArray(assertions) || assertions.length === 0) {
    throw new Error(`Missing catalog assertions for ${definition?.id || 'maintenance case'}`)
  }
  const byName = new Map(checks.map((check) => [check.name, check]))
  const catalogAssertions = assertions.map((assertion, index) => {
    const mapping = evidence[assertion] || evidence[index] || {}
    const evidenceChecks = Array.isArray(mapping.checks) ? mapping.checks : []
    const resolved = evidenceChecks.map((name) => byName.get(name))
    const verified = mapping.verified !== false && evidenceChecks.length > 0 &&
      resolved.every((check) => check?.passed === true)
    return {
      index,
      assertion,
      status: verified ? 'VERIFIED' : 'GAP',
      evidenceChecks,
      details: verified
        ? resolved.map((check) => `${check.name}: ${check.details || ''}`).join('; ')
        : (mapping.gap || resolved.find((check) => check?.passed === false)?.details ||
          '本轮未形成完整真实来源证据')
    }
  })
  const remainingAssertions = catalogAssertions
    .filter((item) => item.status !== 'VERIFIED')
    .map((item) => item.assertion)
  const failed = checks.some((check) => check?.passed === false)
  return {
    catalogAssertions,
    remainingAssertions,
    passCandidate: !failed && remainingAssertions.length === 0
  }
}

export const maintenanceSnapshotFields = Object.freeze([...snapshotFields])
