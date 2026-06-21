import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { dirname, join, normalize, resolve } from 'path'
import { gunzipSync, gzipSync } from 'zlib'

const PAYLOAD_ROOT_NAME = 'page-payloads'
const LEGACY_REF_PREFIX = 'page-payload:v1:'
const REF_PREFIX = 'page-payload:v2:'
let payloadDataDirOverride: string | null = null

export interface PagePayloadFileScan {
  fileCount: number
  bytes: number
  refs: string[]
}

export interface PagePayloadCleanupResult {
  scannedFiles: number
  deletedFiles: number
  deletedBytes: number
}

export function setPayloadDataDir(dataDir: string): void {
  payloadDataDirOverride = resolve(dataDir)
}

function getStableAppRoot(): string {
  const exePath = process.execPath || ''
  if (exePath && !/[\\/]node(?:\.exe)?$/i.test(exePath) && !/[\\/]electron(?:\.exe)?$/i.test(exePath)) {
    return join(dirname(exePath), 'data')
  }
  return resolve(process.cwd(), 'data')
}

export function resolvePayloadDataDir(): string {
  if (payloadDataDirOverride) {
    return payloadDataDirOverride
  }
  if (process.env.GUJISMART_DATA_DIR) {
    return resolve(process.env.GUJISMART_DATA_DIR)
  }
  return getStableAppRoot()
}

export function getPayloadRootDir(): string {
  return join(resolvePayloadDataDir(), 'storage', PAYLOAD_ROOT_NAME)
}

function normalizeRefPath(ref: string): string | null {
  const relative = ref.startsWith(REF_PREFIX)
    ? ref.slice(REF_PREFIX.length)
    : ref.startsWith(LEGACY_REF_PREFIX)
      ? ref.slice(LEGACY_REF_PREFIX.length)
      : ref
  if (!relative || relative.includes('..')) return null
  return relative
}

export function canonicalizePagePayloadRef(ref: string | null | undefined): string | null {
  if (!ref) return null
  const relative = normalizeRefPath(ref)
  return relative ? `${REF_PREFIX}${relative}` : null
}

function resolvePayloadPath(ref: string): string | null {
  const relative = normalizeRefPath(ref)
  if (!relative) return null
  const root = normalize(getPayloadRootDir())
  const target = normalize(join(root, ...relative.split('/')))
  if (!target.toLowerCase().startsWith(root.toLowerCase())) return null
  return target
}

export function pagePayloadRefExists(ref: string | null | undefined): boolean {
  if (!ref) return false
  const absolutePath = resolvePayloadPath(ref)
  return !!absolutePath && existsSync(absolutePath)
}

export function buildPagePayloadRef(docId: string, pageId: string, field: string, value: string): string {
  const hash = createHash('sha256').update(value).digest('hex')
  const prefix = hash.slice(0, 2)
  return `${REF_PREFIX}${['objects', prefix, `${hash}.json.gz`].join('/')}`
}

export function writePagePayloadRef(docId: string, pageId: string, field: string, value: string): string {
  const ref = buildPagePayloadRef(docId, pageId, field, value)
  const absolutePath = resolvePayloadPath(ref)
  if (!absolutePath) throw new Error('Invalid page payload path')
  mkdirSync(dirname(absolutePath), { recursive: true })
  if (!existsSync(absolutePath)) {
    writeFileSync(absolutePath, gzipSync(JSON.stringify({
      version: 2,
      docId,
      pageId,
      field,
      sha256: createHash('sha256').update(value).digest('hex'),
      createdAt: new Date().toISOString(),
      value,
    })))
  }
  return ref
}

export function readPagePayloadValue(ref: string | null | undefined): string | null {
  if (!ref) return null
  const absolutePath = resolvePayloadPath(ref)
  if (!absolutePath || !existsSync(absolutePath)) return null
  try {
    const parsed = JSON.parse(gunzipSync(readFileSync(absolutePath)).toString('utf-8')) as { value?: unknown }
    return typeof parsed.value === 'string' ? parsed.value : null
  } catch {
    return null
  }
}

function buildRefFromPayloadPath(root: string, entryPath: string): string {
  const relative = normalize(entryPath).slice(root.length).replace(/^[/\\]+/, '').split(/[/\\]+/).join('/')
  return `${REF_PREFIX}${relative}`
}

export function scanPayloadDirectory(): PagePayloadFileScan {
  const root = getPayloadRootDir()
  if (!existsSync(root)) return { fileCount: 0, bytes: 0, refs: [] }
  let fileCount = 0
  let bytes = 0
  const refs: string[] = []
  const normalizedRoot = normalize(root)
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop() as string
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(entryPath)
      } else {
        fileCount += 1
        bytes += statSync(entryPath).size
        if (entry.name.endsWith('.json.gz')) {
          refs.push(buildRefFromPayloadPath(normalizedRoot, entryPath))
        }
      }
    }
  }
  return { fileCount, bytes, refs }
}

export function deleteUnreferencedPayloadFiles(referencedRefs: Set<string>): PagePayloadCleanupResult {
  const root = getPayloadRootDir()
  if (!existsSync(root)) return { scannedFiles: 0, deletedFiles: 0, deletedBytes: 0 }
  let scannedFiles = 0
  let deletedFiles = 0
  let deletedBytes = 0
  const normalizedRoot = normalize(root)
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop() as string
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(entryPath)
        continue
      }
      scannedFiles += 1
      if (!entry.name.endsWith('.json.gz')) continue
      const ref = buildRefFromPayloadPath(normalizedRoot, entryPath)
      const legacyRef = `${LEGACY_REF_PREFIX}${ref.slice(REF_PREFIX.length)}`
      if (referencedRefs.has(ref) || referencedRefs.has(legacyRef)) continue
      const size = statSync(entryPath).size
      rmSync(entryPath, { force: true })
      deletedFiles += 1
      deletedBytes += size
    }
  }
  return { scannedFiles, deletedFiles, deletedBytes }
}
