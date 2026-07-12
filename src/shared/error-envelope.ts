import type { ErrorEnvelope } from './types'

const CODE_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/

export function redactErrorMessage(value: unknown): string {
  return String(value || '')
    .replace(/\b(?:sk|key|token)-[a-z0-9._-]{6,}\b/gi, '[REDACTED]')
    .replace(/\b[A-Za-z]:\\[^\r\n,;]+/g, '[PATH]')
    .replace(/(^|\s)\/(?:Users|home|var|tmp|opt)\/[^\r\n,;]+/g, '$1[PATH]')
    .slice(0, 1000)
}

export function validateErrorEnvelope(value: ErrorEnvelope | Record<string, unknown>): ErrorEnvelope {
  const code = String(value.code || '').trim()
  if (!CODE_PATTERN.test(code)) throw new Error('error_code_invalid')
  const recoveryAction = value.recoveryAction === undefined ? undefined : String(value.recoveryAction).trim()
  if (recoveryAction && !CODE_PATTERN.test(recoveryAction)) throw new Error('recovery_action_invalid')
  if (typeof value.recoverable !== 'boolean') throw new Error('error_recoverable_invalid')
  return {
    code,
    message: redactErrorMessage(value.message),
    recoverable: value.recoverable,
    ...(recoveryAction ? { recoveryAction } : {}),
    ...(value.details && typeof value.details === 'object' && !Array.isArray(value.details)
      ? { details: value.details as ErrorEnvelope['details'] }
      : {}),
  }
}

export function createErrorEnvelope(value: ErrorEnvelope): ErrorEnvelope {
  return validateErrorEnvelope(value)
}
