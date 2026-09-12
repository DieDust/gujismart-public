import { randomUUID } from 'crypto'
import { mkdirSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'

export function assertDirectoryWritable(directory: string): void {
  mkdirSync(directory, { recursive: true })
  const probe = join(directory, `.write-test-${process.pid}-${randomUUID()}`)
  // Exclusive, per-call probes never overwrite or remove another process's file.
  writeFileSync(probe, 'ok', { flag: 'wx', mode: 0o600 })
  try {
    unlinkSync(probe)
  } catch (error) {
    // A successful write proves writability; cleanup races are not permission errors.
    const code = error instanceof Error && 'code' in error ? String(error.code) : ''
    if (code !== 'ENOENT') console.warn('[DirectoryAccess] Probe cleanup failed', probe, error)
  }
}

export function describeDirectoryAccessFailure(directory: string, error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'UNKNOWN'
  const reason = code === 'EACCES' || code === 'EPERM'
    ? '目录访问被拒绝。请检查目录权限或安全软件是否阻止了访问。'
    : code === 'ENOSPC' || code === 'EDQUOT'
      ? '磁盘可用空间或配额不足。请释放空间后重试。'
      : code === 'ENOTDIR' || code === 'EEXIST'
        ? '目录路径被同名文件占用。请检查该路径。'
        : code === 'EBUSY'
          ? '目录或文件暂时被其他程序占用。请稍后重试。'
          : '无法完成目录访问检查。请根据错误代码检查存储设备和目录状态后重试。'
  return `${reason}\n\n实际目录：${directory}\n错误代码：${code}\n\n现有文献数据未被移动或删除。`
}

export function shouldShowDirectoryFailureDialog(isMcp: boolean, environment: NodeJS.ProcessEnv): boolean {
  return !isMcp && environment.GUJISMART_HEADLESS !== '1' && environment.GUJISMART_SMOKE !== '1'
}
