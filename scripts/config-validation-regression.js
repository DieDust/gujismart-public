const assert = require('assert')
const { mkdtempSync, rmSync } = require('fs')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { buildSync } = require('esbuild')

const root = path.resolve(__dirname, '..')
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'gujismart-config-validation-'))
const bundlePath = path.join(tempRoot, 'config-validation.cjs')
const checkedAt = '2026-01-01T00:00:00.000Z'

try {
  buildSync({
    entryPoints: [path.join(root, 'src', 'shared', 'config-validation.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundlePath,
    logLevel: 'silent',
  })

  const configValidation = require(bundlePath)

  assert.deepStrictEqual(
    configValidation.validateLlmProfileConfig({
      provider: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1/',
      apiKey: '',
      model: 'deepseek-chat',
      checkedAt,
    }),
    {
      target: 'llm_profile',
      status: 'warning',
      usable: true,
      recoverable: true,
      checked_at: checkedAt,
      issues: [
        {
          code: 'missing_api_key',
          severity: 'warning',
          field: 'apiKey',
          message: 'API key is empty.',
          recoverable: true,
          action_hint: 'fill_api_key',
        },
      ],
      issue_count: 1,
      error_count: 0,
      warning_count: 1,
      info_count: 0,
    },
  )

  const incompleteLlm = configValidation.validateLlmProfileConfig({ checkedAt })
  assert.strictEqual(incompleteLlm.status, 'error')
  assert.strictEqual(incompleteLlm.usable, false)
  assert.strictEqual(incompleteLlm.error_count, 3)
  assert.ok(incompleteLlm.issues.some((issue) => issue.code === 'missing_provider'), 'provider should be required')
  assert.ok(incompleteLlm.issues.some((issue) => issue.code === 'missing_baseurl'), 'baseUrl should be required')
  assert.ok(incompleteLlm.issues.some((issue) => issue.code === 'missing_model'), 'model should be required')

  const invalidVisionBaseUrl = configValidation.validateVisionOcrProfileConfig({
    provider: 'Vision OCR',
    baseUrl: 'ark.cn-beijing.volces.com/api/v3',
    apiKey: 'token',
    model: 'vision-model',
    checkedAt,
  })
  assert.strictEqual(invalidVisionBaseUrl.status, 'warning')
  assert.strictEqual(invalidVisionBaseUrl.usable, true)
  assert.ok(invalidVisionBaseUrl.issues.some((issue) => issue.code === 'base_url_not_http'), 'baseUrl warnings should be structured')

  const paddle = configValidation.validatePaddleOcrConfig({ checkedAt })
  assert.strictEqual(paddle.target, 'paddle_ocr')
  assert.strictEqual(paddle.status, 'error')
  assert.strictEqual(paddle.error_count, 1)
  assert.strictEqual(paddle.warning_count, 1)

  assert.deepStrictEqual(
    configValidation.validateTypesetEnvironmentConfig({
      luatexAvailable: true,
      luatexPath: 'lualatex',
      luatexCnInstalled: true,
      checkedAt,
    }).status,
    'ok',
  )
  const typeset = configValidation.validateTypesetEnvironmentConfig({ checkedAt })
  assert.strictEqual(typeset.status, 'error')
  assert.ok(typeset.issues.some((issue) => issue.code === 'missing_luatex'), 'LuaLaTeX availability should be reported')
  assert.ok(typeset.issues.some((issue) => issue.code === 'missing_luatex_cn'), 'luatex-cn availability should be reported')

  const disabledBackup = configValidation.validateBackupSettingsConfig({
    enabled: false,
    intervalHours: 24,
    slotCount: 3,
    autoBackupRoot: path.join(tempRoot, 'auto-backups'),
    checkedAt,
  })
  assert.strictEqual(disabledBackup.status, 'ok')
  assert.strictEqual(disabledBackup.info_count, 1)
  assert.ok(disabledBackup.issues.some((issue) => issue.code === 'auto_backup_disabled'), 'disabled backups should be an informational issue')

  const typesSource = fs.readFileSync(path.join(root, 'src', 'shared', 'types.ts'), 'utf8')
  const settingsSource = fs.readFileSync(path.join(root, 'src', 'main', 'ipc', 'settings.ts'), 'utf8')
  const backupSource = fs.readFileSync(path.join(root, 'src', 'main', 'backup.ts'), 'utf8')

  assert.ok(typesSource.includes('configValidation?: ConfigValidationReport'), 'shared response types should expose optional config validation reports')
  assert.ok(typesSource.includes("from './config-validation'"), 'shared types should re-export config validation contracts')
  assert.ok(settingsSource.includes('validateLlmProfileConfig'), 'settings IPC should validate LLM provider profiles')
  assert.ok(settingsSource.includes('validateVisionOcrProfileConfig'), 'settings IPC should validate vision OCR provider profiles')
  assert.ok(settingsSource.includes('validateTypesetEnvironmentConfig'), 'typeset environment IPC should return config validation')
  assert.ok(/throw new Error\('AI [^']+'\)/.test(settingsSource), 'existing AI provider error wording should remain compatible')
  assert.ok(/throw new Error\('[^']*OCR [^']+'\)/.test(settingsSource), 'existing vision OCR provider error wording should remain compatible')
  assert.ok(backupSource.includes('validateBackupSettingsConfig'), 'backup status should return config validation')

  console.log('Config validation regression checks passed.')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}
