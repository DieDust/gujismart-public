import { lstatSync, realpathSync } from 'fs'
import { isAbsolute, relative, resolve, sep } from 'path'

export type PathContainment = 'same' | 'descendant' | 'outside'
export type ManagedDeleteKind = 'document-root' | 'document-asset'
export type ManagedDeleteRejection =
  | 'invalid-document-id'
  | 'storage-root-missing'
  | 'storage-root-is-symlink'
  | 'target-missing'
  | 'target-is-symlink'
  | 'document-root-outside-storage'
  | 'target-outside-document'
  | 'target-kind-mismatch'

export interface ManagedDeleteDecision {
  allowed: boolean
  canonicalTarget?: string
  reason?: ManagedDeleteRejection
}

export interface ManagedStorageRootDecision {
  allowed: boolean
  canonicalRoot?: string
  reason?: 'storage-root-missing' | 'storage-root-is-symlink'
}

export function classifyPathContainment(rootPath: string, candidatePath: string): PathContainment {
  if (!rootPath || !candidatePath) return 'outside'
  const relativePath = relative(resolve(rootPath), resolve(candidatePath))
  if (relativePath === '') return 'same'
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) return 'outside'
  return 'descendant'
}

function reject(reason: ManagedDeleteRejection): ManagedDeleteDecision {
  return { allowed: false, reason }
}

function isValidDocumentId(docId: string): boolean {
  return Boolean(docId)
    && docId !== '.'
    && docId !== '..'
    && !docId.includes('\0')
    && !isAbsolute(docId)
    && !docId.includes('/')
    && !docId.includes('\\')
}

export function inspectManagedStorageRoot(dataDir: string): ManagedStorageRootDecision {
  const storageRoot = resolve(dataDir, 'storage')
  try {
    const initialStats = lstatSync(storageRoot)
    if (initialStats.isSymbolicLink()) return { allowed: false, reason: 'storage-root-is-symlink' }
    if (!initialStats.isDirectory()) return { allowed: false, reason: 'storage-root-missing' }
    const canonicalRoot = realpathSync(storageRoot)
    const finalStats = lstatSync(storageRoot)
    if (finalStats.isSymbolicLink()) return { allowed: false, reason: 'storage-root-is-symlink' }
    if (!finalStats.isDirectory()
      || String(finalStats.dev) !== String(initialStats.dev)
      || String(finalStats.ino) !== String(initialStats.ino)) {
      return { allowed: false, reason: 'storage-root-missing' }
    }
    return { allowed: true, canonicalRoot }
  } catch {
    return { allowed: false, reason: 'storage-root-missing' }
  }
}

export function inspectManagedDeleteTarget(input: {
  dataDir: string
  docId: string
  targetPath: string
  kind: ManagedDeleteKind
}): ManagedDeleteDecision {
  if (!isValidDocumentId(input.docId)) return reject('invalid-document-id')
  if (input.kind !== 'document-root' && input.kind !== 'document-asset') return reject('target-kind-mismatch')

  const storageRoot = resolve(input.dataDir, 'storage')
  const documentRoot = resolve(storageRoot, input.docId)
  if (classifyPathContainment(storageRoot, documentRoot) !== 'descendant') return reject('document-root-outside-storage')

  const storageDecision = inspectManagedStorageRoot(input.dataDir)
  if (!storageDecision.allowed || !storageDecision.canonicalRoot) {
    return reject(storageDecision.reason || 'storage-root-missing')
  }
  const canonicalStorageRoot = storageDecision.canonicalRoot

  let canonicalDocumentRoot: string
  try {
    const stats = lstatSync(documentRoot)
    if (stats.isSymbolicLink()) return reject('target-is-symlink')
    if (!stats.isDirectory()) return reject('target-kind-mismatch')
    canonicalDocumentRoot = realpathSync(documentRoot)
  } catch {
    return reject('target-missing')
  }
  if (classifyPathContainment(canonicalStorageRoot, canonicalDocumentRoot) !== 'descendant') {
    return reject('document-root-outside-storage')
  }

  try {
    const targetStats = lstatSync(input.targetPath)
    if (targetStats.isSymbolicLink()) return reject('target-is-symlink')
    const canonicalTarget = realpathSync(input.targetPath)
    const containment = classifyPathContainment(canonicalDocumentRoot, canonicalTarget)
    if (input.kind === 'document-root') {
      if (containment !== 'same') return reject('target-outside-document')
      if (!targetStats.isDirectory()) return reject('target-kind-mismatch')
    } else {
      if (containment !== 'descendant') return reject('target-outside-document')
      if (!targetStats.isFile()) return reject('target-kind-mismatch')
    }
    return { allowed: true, canonicalTarget }
  } catch {
    return reject('target-missing')
  }
}
