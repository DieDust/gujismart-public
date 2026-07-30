const assert = require('assert')
const { mkdtempSync, readFileSync, rmSync } = require('fs')
const os = require('os')
const path = require('path')
const { buildSync } = require('esbuild')

const root = path.resolve(__dirname, '..')
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'gujismart-shared-contracts-'))

function bundle(relativePath, outputName) {
  const outfile = path.join(tempRoot, outputName)
  buildSync({
    entryPoints: [path.join(root, relativePath)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    logLevel: 'silent',
  })
  return require(outfile)
}

try {
  const task = bundle('src/shared/task-contract.ts', 'task.cjs')
  assert.deepStrictEqual(task.TASK_STATUSES, ['queued', 'running', 'paused', 'completed', 'error', 'canceled'])
  assert.strictEqual(task.normalizeLegacyTaskStatus('processing'), 'running')
  assert.strictEqual(task.normalizeLegacyTaskStatus('failed'), 'error')
  assert.strictEqual(task.normalizeLegacyTaskStatus('cancelled'), 'canceled')
  assert.deepStrictEqual(
    task.validateTaskStateEnvelope({
      taskId: 'task-1',
      kind: 'ocr',
      status: 'running',
      phase: 'recognize',
      progress: 0.4,
      committedCount: 4,
      totalCount: 10,
      updatedAt: '2026-07-10T00:00:00.000Z',
    }),
    {
      taskId: 'task-1',
      kind: 'ocr',
      status: 'running',
      phase: 'recognize',
      progress: 0.4,
      committedCount: 4,
      totalCount: 10,
      updatedAt: '2026-07-10T00:00:00.000Z',
    },
  )
  assert.throws(() => task.validateTaskStateEnvelope({ taskId: 'x', kind: 'ocr', status: 'processing' }), /task_status_invalid/)
  assert.throws(() => task.validateTaskStateEnvelope({ taskId: 'x', kind: 'ocr', status: 'running', completionKind: 'partial' }), /completion_kind_requires_completed/)
  assert.throws(() => task.validateTaskStateEnvelope({ taskId: 'x', kind: 'ocr', status: 'completed', progress: 2 }), /task_progress_invalid/)
  const legacyError = task.taskStateFromLegacyBackgroundEvent({
    taskId: 'legacy-error',
    kind: 'ocr',
    status: 'failed',
    errorMessage: 'Token sk-background-secret failed at C:\\Users\\person\\trace.log',
  })
  assert.strictEqual(legacyError.status, 'error')
  assert.ok(!legacyError.error.message.includes('sk-background-secret'))
  assert.ok(!legacyError.error.message.includes('C:\\Users'))

  const errors = bundle('src/shared/error-envelope.ts', 'errors.cjs')
  const envelope = errors.createErrorEnvelope({
    code: 'credential_read_failed',
    message: 'Key sk-super-secret failed at C:\\Users\\person\\secret.json',
    recoverable: true,
    recoveryAction: 'reenter_credential',
  })
  assert.strictEqual(envelope.code, 'credential_read_failed')
  assert.strictEqual(envelope.recoverable, true)
  assert.strictEqual(envelope.recoveryAction, 'reenter_credential')
  assert.ok(!envelope.message.includes('sk-super-secret'))
  assert.ok(!envelope.message.includes('C:\\Users'))
  assert.deepStrictEqual(errors.validateErrorEnvelope(envelope), envelope)
  assert.throws(() => errors.validateErrorEnvelope({ code: 'Bad Code', message: 'x', recoverable: false }), /error_code_invalid/)

  const settings = bundle('src/shared/setting-definitions.ts', 'settings.cjs')
  assert.strictEqual(settings.getSettingDefinition('llm_api_key').sensitivity, 'protected')
  assert.strictEqual(settings.getSettingDefinition('theme').rendererVisible, true)
  assert.strictEqual(settings.getSettingDefinition('auto_ai_after_ocr').defaultValue, 'false')
  assert.deepStrictEqual(settings.validateSettingValue('batch_size', '10'), { key: 'batch_size', value: '10', known: true })
  assert.deepStrictEqual(settings.validateSettingValue('ocr_async_pdf_chunk_concurrency', '8'), { key: 'ocr_async_pdf_chunk_concurrency', value: '8', known: true })
  assert.deepStrictEqual(settings.validateSettingValue('ocr_heavy_pdf_document_concurrency', '6'), { key: 'ocr_heavy_pdf_document_concurrency', value: '6', known: true })
  assert.deepStrictEqual(settings.validateSettingValue('auto_ocr_after_import', 'TRUE'), { key: 'auto_ocr_after_import', value: 'true', known: true })
  assert.deepStrictEqual(settings.validateSettingValue('future_compatible_key', 'value'), { key: 'future_compatible_key', value: 'value', known: false })
  assert.throws(() => settings.validateSettingValue('batch_size', '0'), /setting_value_out_of_range/)
  assert.throws(() => settings.validateSettingValue('ocr_async_pdf_chunk_concurrency', '9'), /setting_value_out_of_range/)
  assert.throws(() => settings.validateSettingValue('ocr_heavy_pdf_document_concurrency', '21'), /setting_value_out_of_range/)
  assert.throws(() => settings.validateSettingValue('auto_ocr_after_import', 'yes'), /setting_value_invalid_boolean/)

  const settingsView = readFileSync(path.join(root, 'src/renderer/src/views/SettingsView.tsx'), 'utf8')
  const ocrIpc = readFileSync(path.join(root, 'src/main/ipc/ocr.ts'), 'utf8')
  assert.ok(settingsView.includes('const [autoAi, setAutoAi] = useState(false)'))
  assert.ok(settingsView.includes("setAutoAi(settings.auto_ai_after_ocr === 'true')"))
  assert.ok(ocrIpc.includes("if (autoAi?.value === 'true' && !hasFinalReviewPageFailure && hybridReadyForAutoAi)"))

  console.log('Shared task, error, and setting contract regression checks passed.')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}
