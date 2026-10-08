import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

const digest = (value) => createHash('sha256').update(value).digest('hex')

export function implementationFingerprint (root) {
  const files = []
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(target)
      else if (entry.isFile() && /\.(mjs|sh)$/.test(entry.name)) files.push(target)
    }
  }
  for (const directory of ['config', 'lib', 'fixtures', 'suites']) {
    visit(path.join(root, directory))
  }
  files.push(path.join(root, 'runner.mjs'))
  return digest(JSON.stringify(files.sort().map((file) => [
    path.relative(root, file), digest(fs.readFileSync(file))
  ])))
}

export function checkpointScope ({ environment, catalog, implementation }) {
  return `v2-${digest(JSON.stringify({ environment, catalog, implementation })).slice(0, 24)}`
}

export function resumableCases (completedCases, definitions) {
  return new Set((Array.isArray(completedCases) ? completedCases : []).filter((id) => {
    const definition = definitions.get(id)
    return definition && (definition.status || 'READY') === 'READY' &&
      !definition.acceptanceGaps?.length
  }))
}
