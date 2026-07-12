import { lstat, opendir, realpath, stat } from 'fs/promises'
import { extname, isAbsolute, relative, resolve } from 'path'

export type ExternalFolderBoundaryErrorCode =
  | 'EXTERNAL_FOLDER_MISSING'
  | 'EXTERNAL_FOLDER_LINK_REJECTED'
  | 'EXTERNAL_FOLDER_NOT_DIRECTORY'
  | 'EXTERNAL_FOLDER_CHANGED'

export class ExternalFolderBoundaryError extends Error {
  readonly code: ExternalFolderBoundaryErrorCode

  constructor(code: ExternalFolderBoundaryErrorCode) {
    super(code)
    this.name = 'ExternalFolderBoundaryError'
    this.code = code
  }
}

export interface CanonicalExternalFolderFile {
  name: string
  path: string
  size: number
  ext: string
}

interface RootIdentity {
  canonicalPath: string
  dev: string
  ino: string
}

function isInside(rootPath: string, candidatePath: string): boolean {
  const rel = relative(rootPath, candidatePath)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

async function inspectRoot(rawPath: string): Promise<RootIdentity> {
  const absolutePath = resolve(String(rawPath || '').trim())
  let linkInfo
  try {
    linkInfo = await lstat(absolutePath)
  } catch {
    throw new ExternalFolderBoundaryError('EXTERNAL_FOLDER_MISSING')
  }
  if (linkInfo.isSymbolicLink()) throw new ExternalFolderBoundaryError('EXTERNAL_FOLDER_LINK_REJECTED')
  const canonicalPath = await realpath(absolutePath)
  const info = await stat(canonicalPath)
  if (!info.isDirectory()) throw new ExternalFolderBoundaryError('EXTERNAL_FOLDER_NOT_DIRECTORY')
  return { canonicalPath, dev: String(info.dev), ino: String(info.ino) }
}

async function assertRootIdentity(identity: RootIdentity): Promise<void> {
  const current = await inspectRoot(identity.canonicalPath)
  if (current.canonicalPath !== identity.canonicalPath || current.dev !== identity.dev || current.ino !== identity.ino) {
    throw new ExternalFolderBoundaryError('EXTERNAL_FOLDER_CHANGED')
  }
}

export async function scanCanonicalExternalFolder(
  rawRootPath: string,
  supportedExtensions: ReadonlySet<string>,
): Promise<CanonicalExternalFolderFile[]> {
  const root = await inspectRoot(rawRootPath)
  const pendingDirectories = [root.canonicalPath]
  const files: CanonicalExternalFolderFile[] = []

  while (pendingDirectories.length > 0) {
    await assertRootIdentity(root)
    const currentDirectory = pendingDirectories.shift()
    if (!currentDirectory) continue
    const handle = await opendir(currentDirectory)
    try {
      while (true) {
        const entry = await handle.read()
        if (!entry) break
        const candidatePath = resolve(currentDirectory, entry.name)
        if (!isInside(root.canonicalPath, candidatePath)) continue
        const linkInfo = await lstat(candidatePath).catch(() => null)
        if (!linkInfo || linkInfo.isSymbolicLink()) continue
        const canonicalPath = await realpath(candidatePath).catch(() => '')
        if (!canonicalPath || !isInside(root.canonicalPath, canonicalPath)) continue
        if (linkInfo.isDirectory()) {
          pendingDirectories.push(canonicalPath)
          continue
        }
        const ext = extname(entry.name).toLowerCase()
        if (!linkInfo.isFile() || !supportedExtensions.has(ext)) continue
        files.push({ name: entry.name, path: canonicalPath, size: Number(linkInfo.size), ext })
      }
    } finally {
      await handle.close().catch(() => undefined)
    }
  }
  await assertRootIdentity(root)
  return files
}
