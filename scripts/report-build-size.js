const fs = require('fs/promises')
const path = require('path')

const TARGETS = [
  'out',
  'out/main',
  'out/preload',
  'out/renderer',
  'out/renderer/assets',
  'dist',
  'dist/win-unpacked',
  'dist/win-unpacked/resources/app.asar',
]

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`
}

async function statPath(target) {
  try {
    return await fs.stat(target)
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
}

async function measurePath(target) {
  const stat = await statPath(target)
  if (!stat) return { exists: false, files: 0, bytes: 0 }
  if (stat.isFile()) return { exists: true, files: 1, bytes: stat.size }

  let files = 0
  let bytes = 0
  const entries = await fs.readdir(target, { withFileTypes: true })

  for (const entry of entries) {
    const child = path.join(target, entry.name)
    const childStat = await statPath(child)
    if (!childStat) continue
    if (childStat.isDirectory()) {
      const measured = await measurePath(child)
      files += measured.files
      bytes += measured.bytes
    } else if (childStat.isFile()) {
      files += 1
      bytes += childStat.size
    }
  }

  return { exists: true, files, bytes }
}

async function listLargestFiles(target, count) {
  const stat = await statPath(target)
  if (!stat || !stat.isDirectory()) return []

  const files = []
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const child = path.join(dir, entry.name)
      const childStat = await statPath(child)
      if (!childStat) continue
      if (childStat.isDirectory()) {
        await walk(child)
      } else if (childStat.isFile()) {
        files.push({ file: path.relative(process.cwd(), child), bytes: childStat.size })
      }
    }
  }

  await walk(target)
  return files.sort((left, right) => right.bytes - left.bytes).slice(0, count)
}

async function main() {
  console.log('Build size report')
  console.log('=================')

  for (const target of TARGETS) {
    const absoluteTarget = path.resolve(process.cwd(), target)
    const measured = await measurePath(absoluteTarget)
    if (!measured.exists) {
      console.log(`${target.padEnd(42)} missing`)
      continue
    }
    console.log(`${target.padEnd(42)} ${String(measured.files).padStart(5)} files  ${formatBytes(measured.bytes)}`)
  }

  const largestRendererAssets = await listLargestFiles(path.resolve(process.cwd(), 'out/renderer/assets'), 12)
  if (largestRendererAssets.length > 0) {
    console.log('\nLargest renderer assets')
    console.log('-----------------------')
    for (const item of largestRendererAssets) {
      console.log(`${formatBytes(item.bytes).padStart(10)}  ${item.file}`)
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
