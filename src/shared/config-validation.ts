export type ConfigValidationSeverity = 'info' | 'warning' | 'error'
export type ConfigValidationStatus = 'ok' | 'warning' | 'error'

export interface ConfigValidationIssue {
  code: string
  severity: ConfigValidationSeverity
  message: string
  field?: string
  recoverable: boolean
  action_hint?: string
}

export interface ConfigValidationReport {
  target: string
  status: ConfigValidationStatus
  usable: boolean
  recoverable: boolean
  checked_at: string
  issues: ConfigValidationIssue[]
  issue_count: number
  error_count: number
  warning_count: number
  info_count: number
}

export interface ProviderProfileConfigInput {
  target?: string
  provider?: unknown
  name?: unknown
  baseUrl?: unknown
  apiKey?: unknown
  model?: unknown
  apiKeyRequired?: boolean
  checkedAt?: string
}

export interface PaddleOcrConfigInput {
  apiKey?: unknown
  model?: unknown
  checkedAt?: string
}

export interface TypesetEnvironmentConfigInput {
  luatexAvailable?: boolean
  luatexPath?: unknown
  luatexCnInstalled?: boolean
  checkedAt?: string
}

export interface BackupSettingsConfigInput {
  enabled?: boolean
  intervalHours?: unknown
  slotCount?: unknown
  autoBackupRoot?: unknown
  checkedAt?: string
}

function toTrimmedString(value: unknown): string {
  return String(value ?? '').trim()
}

function normalizeIssueCode(value: string): string {
  return toTrimmedString(value).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'config_issue'
}

function hasHttpProtocol(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export function normalizeProviderBaseUrl(value: unknown): string {
  return toTrimmedString(value).replace(/\/+$/, '')
}

export function buildConfigValidationReport(payload: {
  target: string
  issues?: ConfigValidationIssue[]
  checkedAt?: string
}): ConfigValidationReport {
  const issues = [...(payload.issues || [])].map((issue) => ({
    ...issue,
    code: normalizeIssueCode(issue.code),
    message: toTrimmedString(issue.message),
    recoverable: issue.recoverable,
    ...(issue.action_hint ? { action_hint: normalizeIssueCode(issue.action_hint) } : {}),
  }))
  const errorCount = issues.filter((issue) => issue.severity === 'error').length
  const warningCount = issues.filter((issue) => issue.severity === 'warning').length
  const infoCount = issues.filter((issue) => issue.severity === 'info').length
  return {
    target: toTrimmedString(payload.target) || 'config',
    status: errorCount > 0 ? 'error' : warningCount > 0 ? 'warning' : 'ok',
    usable: errorCount === 0,
    recoverable: issues.every((issue) => issue.recoverable !== false),
    checked_at: payload.checkedAt || new Date().toISOString(),
    issues,
    issue_count: issues.length,
    error_count: errorCount,
    warning_count: warningCount,
    info_count: infoCount,
  }
}

function requiredStringIssue(field: string, label: string, actionHint = 'fill_required_config'): ConfigValidationIssue {
  return {
    code: `missing_${field}`,
    severity: 'error',
    field,
    message: `${label} is required.`,
    recoverable: true,
    action_hint: actionHint,
  }
}

function warningIssue(field: string, code: string, message: string, actionHint = 'review_config'): ConfigValidationIssue {
  return {
    code,
    severity: 'warning',
    field,
    message,
    recoverable: true,
    action_hint: actionHint,
  }
}

export function validateProviderProfileConfig(input: ProviderProfileConfigInput): ConfigValidationReport {
  const provider = toTrimmedString(input.provider || input.name)
  const baseUrl = normalizeProviderBaseUrl(input.baseUrl)
  const apiKey = toTrimmedString(input.apiKey).replace(/^Bearer\s+/i, '')
  const model = toTrimmedString(input.model)
  const issues: ConfigValidationIssue[] = []

  if (!provider) issues.push(requiredStringIssue('provider', 'Provider name'))
  if (!baseUrl) {
    issues.push(requiredStringIssue('baseUrl', 'Base URL'))
  } else if (!hasHttpProtocol(baseUrl)) {
    issues.push(warningIssue('baseUrl', 'base_url_not_http', 'Base URL should start with http:// or https://.'))
  }
  if (!model) issues.push(requiredStringIssue('model', 'Model'))
  if (!apiKey) {
    issues.push({
      code: 'missing_api_key',
      severity: input.apiKeyRequired ? 'error' : 'warning',
      field: 'apiKey',
      message: 'API key is empty.',
      recoverable: true,
      action_hint: 'fill_api_key',
    })
  }

  return buildConfigValidationReport({
    target: input.target || 'provider_profile',
    checkedAt: input.checkedAt,
    issues,
  })
}

export function validateLlmProfileConfig(input: ProviderProfileConfigInput): ConfigValidationReport {
  return validateProviderProfileConfig({ ...input, target: input.target || 'llm_profile' })
}

export function validateVisionOcrProfileConfig(input: ProviderProfileConfigInput): ConfigValidationReport {
  return validateProviderProfileConfig({ ...input, target: input.target || 'vision_ocr_profile' })
}

export function validatePaddleOcrConfig(input: PaddleOcrConfigInput): ConfigValidationReport {
  const issues: ConfigValidationIssue[] = []
  if (!toTrimmedString(input.apiKey).replace(/^Bearer\s+/i, '')) {
    issues.push(requiredStringIssue('apiKey', 'PaddleOCR API key', 'fill_paddleocr_api_key'))
  }
  if (!toTrimmedString(input.model)) {
    issues.push(warningIssue('model', 'missing_paddleocr_model', 'PaddleOCR model is empty.', 'choose_paddleocr_model'))
  }
  return buildConfigValidationReport({
    target: 'paddle_ocr',
    checkedAt: input.checkedAt,
    issues,
  })
}

export function validateTypesetEnvironmentConfig(input: TypesetEnvironmentConfigInput): ConfigValidationReport {
  const issues: ConfigValidationIssue[] = []
  if (!input.luatexAvailable) {
    issues.push({
      code: 'missing_luatex',
      severity: 'error',
      field: 'luatex',
      message: 'LuaLaTeX is not available.',
      recoverable: true,
      action_hint: 'install_luatex',
    })
  }
  if (input.luatexAvailable && !toTrimmedString(input.luatexPath)) {
    issues.push(warningIssue('luatexPath', 'missing_luatex_path', 'LuaLaTeX path is empty.'))
  }
  if (!input.luatexCnInstalled) {
    issues.push({
      code: 'missing_luatex_cn',
      severity: 'warning',
      field: 'luatexCn',
      message: 'luatex-cn package is not installed.',
      recoverable: true,
      action_hint: 'install_luatex_cn',
    })
  }
  return buildConfigValidationReport({
    target: 'typeset_environment',
    checkedAt: input.checkedAt,
    issues,
  })
}

export function validateBackupSettingsConfig(input: BackupSettingsConfigInput): ConfigValidationReport {
  const issues: ConfigValidationIssue[] = []
  const intervalHours = Number(input.intervalHours)
  const slotCount = Number(input.slotCount)
  if (!toTrimmedString(input.autoBackupRoot)) {
    issues.push(requiredStringIssue('autoBackupRoot', 'Auto-backup root', 'review_backup_directory'))
  }
  if (!Number.isFinite(intervalHours) || intervalHours < 1) {
    issues.push(requiredStringIssue('intervalHours', 'Auto-backup interval', 'set_backup_interval'))
  }
  if (!Number.isFinite(slotCount) || slotCount < 1) {
    issues.push(requiredStringIssue('slotCount', 'Auto-backup slot count', 'set_backup_slot_count'))
  }
  if (input.enabled === false && issues.length === 0) {
    issues.push({
      code: 'auto_backup_disabled',
      severity: 'info',
      field: 'enabled',
      message: 'Auto-backup is disabled.',
      recoverable: true,
      action_hint: 'enable_auto_backup',
    })
  }
  return buildConfigValidationReport({
    target: 'backup_settings',
    checkedAt: input.checkedAt,
    issues,
  })
}
