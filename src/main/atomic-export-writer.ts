import { createHash, randomUUID } from 'crypto'
import { createReadStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'fs'
import { basename, dirname, join } from 'path'

export interface AtomicExportResult {
  exportPath: string
  contentHash: string
  byteSize: number
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', resolve)
  })
  return hash.digest('hex')
}

function removeIfPresent(filePath: string): void {
  try { if (existsSync(filePath)) unlinkSync(filePath) } catch { /* best-effort cleanup */ }
}

export async function writeAtomicExport(
  exportPath: string,
  render: (stagingPath: string) => Promise<unknown> | unknown,
  validate?: (stagingPath: string) => Promise<unknown> | unknown,
): Promise<AtomicExportResult> {
  const outputDir = dirname(exportPath)
  mkdirSync(outputDir, { recursive: true })
  const attemptId = randomUUID()
  const stagingPath = join(outputDir, `.${basename(exportPath)}.gujismart-export-${attemptId}.tmp`)
  const backupPath = join(outputDir, `.${basename(exportPath)}.gujismart-export-${attemptId}.bak`)
  let movedOriginal = false
  try {
    await render(stagingPath)
    if (!existsSync(stagingPath) || !statSync(stagingPath).isFile()) throw new Error('export_staging_missing')
    if (validate) await validate(stagingPath)
    const byteSize = statSync(stagingPath).size
    if (byteSize < 1) throw new Error('export_staging_empty')
    const contentHash = await hashFile(stagingPath)

    if (existsSync(exportPath)) {
      renameSync(exportPath, backupPath)
      movedOriginal = true
    }
    try {
      renameSync(stagingPath, exportPath)
    } catch (error) {
      if (movedOriginal && existsSync(backupPath) && !existsSync(exportPath)) {
        renameSync(backupPath, exportPath)
        movedOriginal = false
      }
      throw error
    }
    removeIfPresent(backupPath)
    movedOriginal = false
    return { exportPath, contentHash, byteSize }
  } finally {
    removeIfPresent(stagingPath)
    if (movedOriginal && existsSync(backupPath) && !existsSync(exportPath)) {
      try { renameSync(backupPath, exportPath) } catch { /* preserve recovery artifact */ }
    } else {
      removeIfPresent(backupPath)
    }
  }
}
