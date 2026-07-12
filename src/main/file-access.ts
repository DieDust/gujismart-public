import { existsSync, realpathSync, statSync } from 'fs'
import { isAbsolute, relative, resolve, sep } from 'path'
import { getDataDir } from './database'
import { getPdfRepositoryPaths } from './pdf-assets'
import { inspectManagedStorageRoot } from './managed-path-boundary'

const runtimeAllowedFiles = new Set<string>()
const runtimeAllowedRoots = new Set<string>()

function normalizeExistingPath(filePath: string): string {
  const absolute = resolve(String(filePath || '').trim())
  if (!absolute) return ''
  try {
    return realpathSync(absolute)
  } catch {
    return absolute
  }
}

function isInsidePath(candidate: string, root: string): boolean {
  const normalizedCandidate = normalizeExistingPath(candidate)
  const normalizedRoot = normalizeExistingPath(root)
  if (!normalizedCandidate || !normalizedRoot) return false
  const relativePath = relative(normalizedRoot, normalizedCandidate)
  return relativePath === ''
    || (!isAbsolute(relativePath) && relativePath !== '..' && !relativePath.startsWith(`..${sep}`))
}

function getManagedStorageRoot(): string | null {
  const decision = inspectManagedStorageRoot(getDataDir())
  return decision.allowed && decision.canonicalRoot ? decision.canonicalRoot : null
}

function pathFromLocalResourceUrl(value: string): string {
  const urlObj = new URL(value)
  if (urlObj.hostname === 'file') {
    return decodeURIComponent(urlObj.pathname.replace(/^\/+/, ''))
  }

  let filePath = decodeURIComponent(urlObj.pathname)
  if (filePath.length > 2 && filePath[0] === '/' && filePath[2] === ':') {
    filePath = filePath.substring(1)
  }
  return filePath
}

export function allowFileAccessPath(filePath: string): void {
  const normalized = normalizeExistingPath(filePath)
  if (!normalized) return
  if (existsSync(normalized) && statSync(normalized).isDirectory()) {
    runtimeAllowedRoots.add(normalized)
    return
  }
  runtimeAllowedFiles.add(normalized)
}

export function allowFileAccessPaths(paths: string[]): void {
  for (const filePath of paths || []) allowFileAccessPath(filePath)
}

export function allowManagedFileAccessPath(filePath: string): void {
  const normalized = normalizeExistingPath(filePath)
  const managedStorageRoot = getManagedStorageRoot()
  if (!normalized
    || !managedStorageRoot
    || !existsSync(normalized)
    || !isInsidePath(normalized, managedStorageRoot)) return
  if (statSync(normalized).isFile()) runtimeAllowedFiles.add(normalized)
}

export function allowManagedFileAccessPaths(paths: string[]): void {
  for (const filePath of paths || []) allowManagedFileAccessPath(filePath)
}

export function assertHttpUrl(rawUrl: string): string {
  const url = new URL(String(rawUrl || '').trim())
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('只允许打开 http/https 链接')
  }
  return url.href
}

export function assertAllowedLocalFilePath(filePath: string): string {
  const normalized = normalizeExistingPath(filePath)
  if (!normalized || !existsSync(normalized)) {
    throw new Error('文件不存在')
  }
  if (runtimeAllowedFiles.has(normalized)) return normalized

  const allowedRoots = [
    getManagedStorageRoot(),
    ...getPdfRepositoryPaths(),
    ...runtimeAllowedRoots,
  ].filter((root): root is string => Boolean(root))

  if (!allowedRoots.some((root) => isInsidePath(normalized, root))) {
    throw new Error('该文件不在文献管理授权访问范围内')
  }
  return normalized
}

export function assertAllowedLocalResourceUrl(url: string): string {
  if (!String(url || '').startsWith('local-resource://')) {
    throw new Error('不支持的本地资源协议')
  }
  const normalized = normalizeExistingPath(pathFromLocalResourceUrl(url))
  if (!normalized || !existsSync(normalized)) {
    throw new Error('文件不存在')
  }
  const managedStorageRoot = getManagedStorageRoot()
  if (!runtimeAllowedFiles.has(normalized)
    && (!managedStorageRoot || !isInsidePath(normalized, managedStorageRoot))) {
    throw new Error('该文件不在文献管理授权访问范围内')
  }
  return normalized
}
