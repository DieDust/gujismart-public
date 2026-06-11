const fs = require('fs/promises')
const path = require('path')

const ALLOWED_TARGETS = new Set(['out', 'dist'])

function resolveTarget(name) {
  const normalized = String(name || '').trim().replace(/[\\/]+$/g, '')
  if (!ALLOWED_TARGETS.has(normalized)) {
    throw new Error(`Refusing to clean unsupported target: ${name}`)
  }

  const root = process.cwd()
  const target = path.resolve(root, normalized)
  const relative = path.relative(root, target)

  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to clean path outside project: ${target}`)
  }

  return target
}

async function cleanTarget(name) {
  const target = resolveTarget(name)
  await fs.rm(target, { recursive: true, force: true })
  console.log(`cleaned ${path.relative(process.cwd(), target)}`)
}

async function main() {
  const targets = process.argv.slice(2)
  const requestedTargets = targets.length > 0 ? targets : ['out']

  for (const target of requestedTargets) {
    await cleanTarget(target)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
