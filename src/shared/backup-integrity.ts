export type BackupIntegrityStatus = 'ok' | 'warning' | 'error'
export type BackupIntegritySeverity = 'warning' | 'error'

export interface BackupIntegrityIssue {
  code: string
  severity: BackupIntegritySeverity
  message: string
  recoverable: boolean
  action_hint?: string
}

export interface BackupIntegrityMetrics {
  db_present: boolean
  storage_present: boolean
  includes_storage: boolean
  includes_page_payloads: boolean
  db_file_count: number
  db_total_bytes: number
  storage_file_count: number
  storage_total_bytes: number
  page_payload_file_count: number
  page_payload_total_bytes: number
  page_payload_ref_count: number
  missing_page_payload_ref_count: number
}

export interface BackupIntegrityReport {
  status: BackupIntegrityStatus
  issue_count: number
  error_count: number
  warning_count: number
  issues: BackupIntegrityIssue[]
  metrics: BackupIntegrityMetrics
  generated_at: string
}

function finiteCount(value: unknown): number {
  const count = Number(value)
  if (!Number.isFinite(count)) return 0
  return Math.max(0, Math.floor(count))
}

function normalizeMetrics(input: Partial<BackupIntegrityMetrics>): BackupIntegrityMetrics {
  return {
    db_present: Boolean(input.db_present),
    storage_present: Boolean(input.storage_present),
    includes_storage: Boolean(input.includes_storage),
    includes_page_payloads: Boolean(input.includes_page_payloads),
    db_file_count: finiteCount(input.db_file_count),
    db_total_bytes: finiteCount(input.db_total_bytes),
    storage_file_count: finiteCount(input.storage_file_count),
    storage_total_bytes: finiteCount(input.storage_total_bytes),
    page_payload_file_count: finiteCount(input.page_payload_file_count),
    page_payload_total_bytes: finiteCount(input.page_payload_total_bytes),
    page_payload_ref_count: finiteCount(input.page_payload_ref_count),
    missing_page_payload_ref_count: finiteCount(input.missing_page_payload_ref_count),
  }
}

function makeIssue(
  code: string,
  severity: BackupIntegritySeverity,
  message: string,
  recoverable = true,
  actionHint?: string,
): BackupIntegrityIssue {
  return {
    code,
    severity,
    message,
    recoverable,
    ...(actionHint ? { action_hint: actionHint } : {}),
  }
}

function reportFromIssues(
  metrics: BackupIntegrityMetrics,
  issues: BackupIntegrityIssue[],
  generatedAt: string,
): BackupIntegrityReport {
  const errorCount = issues.filter((issue) => issue.severity === 'error').length
  const warningCount = issues.filter((issue) => issue.severity === 'warning').length
  return {
    status: errorCount > 0 ? 'error' : warningCount > 0 ? 'warning' : 'ok',
    issue_count: issues.length,
    error_count: errorCount,
    warning_count: warningCount,
    issues,
    metrics,
    generated_at: generatedAt,
  }
}

export function buildBackupIntegrityReport(
  input: Partial<BackupIntegrityMetrics>,
  generatedAt = new Date().toISOString(),
): BackupIntegrityReport {
  const metrics = normalizeMetrics(input)
  const issues: BackupIntegrityIssue[] = []

  if (!metrics.db_present) {
    issues.push(makeIssue('backup_database_missing', 'error', 'Backup database files are missing.', false))
  }
  if (metrics.includes_storage && !metrics.storage_present) {
    issues.push(makeIssue('backup_storage_missing', 'error', 'Backup manifest expects storage files, but storage is missing.', true, 'use_complete_backup_package'))
  }
  if (metrics.page_payload_ref_count > 0 && !metrics.includes_page_payloads) {
    issues.push(makeIssue('backup_page_payloads_missing', 'error', 'Database references external page payloads, but page payload files are missing.', true, 'use_complete_backup_package'))
  }
  if (metrics.missing_page_payload_ref_count > 0) {
    issues.push(makeIssue('backup_page_payload_refs_missing', 'error', 'Some external page payload references are missing files.', true, 'use_complete_backup_package'))
  }
  if (metrics.db_present && metrics.db_file_count <= 0) {
    issues.push(makeIssue('backup_database_file_count_empty', 'warning', 'Backup database directory is present but file count is zero.'))
  }

  return reportFromIssues(metrics, issues, generatedAt)
}

export function compareBackupIntegrityReports(
  expected: BackupIntegrityReport,
  actual: BackupIntegrityReport,
  generatedAt = new Date().toISOString(),
): BackupIntegrityReport {
  const metrics = actual.metrics
  const issues: BackupIntegrityIssue[] = [...actual.issues]
  const expectedMetrics = expected.metrics

  if (expectedMetrics.db_present !== metrics.db_present) {
    issues.push(makeIssue('restored_database_presence_mismatch', 'error', 'Restored database presence does not match the backup manifest.', false))
  }
  if (expectedMetrics.db_file_count !== metrics.db_file_count || expectedMetrics.db_total_bytes !== metrics.db_total_bytes) {
    issues.push(makeIssue('restored_database_size_mismatch', 'error', 'Restored database file summary does not match the backup manifest.', false))
  }
  if (expectedMetrics.includes_storage && !metrics.storage_present) {
    issues.push(makeIssue('restored_storage_missing', 'error', 'Restored data is missing storage files required by the backup manifest.', true, 'restore_from_safety_backup'))
  }
  if (expectedMetrics.storage_file_count !== metrics.storage_file_count || expectedMetrics.storage_total_bytes !== metrics.storage_total_bytes) {
    issues.push(makeIssue('restored_storage_size_mismatch', 'error', 'Restored storage file summary does not match the backup manifest.', true, 'restore_from_safety_backup'))
  }
  if (expectedMetrics.page_payload_ref_count !== metrics.page_payload_ref_count) {
    issues.push(makeIssue('restored_payload_ref_count_mismatch', 'error', 'Restored page payload reference count does not match the backup manifest.', true, 'restore_from_safety_backup'))
  }
  if (expectedMetrics.missing_page_payload_ref_count === 0 && metrics.missing_page_payload_ref_count > 0) {
    issues.push(makeIssue('restored_payload_refs_missing', 'error', 'Restored data has missing external page payload files.', true, 'restore_from_safety_backup'))
  }

  return reportFromIssues(metrics, issues, generatedAt)
}
