import { existsSync, realpathSync, statSync } from 'fs'
import { resolve } from 'path'
import { getDataDir } from './database'
import { getPdfRepositoryPaths } from './pdf-assets'

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
  const normalizedCandidate = normalizeExistingPath(candidate).toLowerCase()
  const normalizedRoot = normalizeExistingPath(root).toLowerCase()
  return normalizedCandidate === normalizedRoot
    || normalizedCandidate.startsWith(`${normalizedRoot}\\`)
    || normalizedCandidate.startsWith(`${normalizedRoot}/`)
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
    getDataDir(),
    ...getPdfRepositoryPaths(),
    ...runtimeAllowedRoots,
  ].filter(Boolean)

  if (!allowedRoots.some((root) => isInsidePath(normalized, root))) {
    throw new Error('该文件不在文献管理授权访问范围内')
  }
  return normalized
}

export function assertAllowedLocalResourceUrl(url: string): string {
  if (!String(url || '').startsWith('local-resource://')) {
    throw new Error('不支持的本地资源协议')
  }
  return assertAllowedLocalFilePath(pathFromLocalResourceUrl(url))
}
