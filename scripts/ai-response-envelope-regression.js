const assert = require('assert')
const { mkdtempSync, rmSync } = require('fs')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { buildSync } = require('esbuild')

const root = path.resolve(__dirname, '..')
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'gujismart-ai-response-envelope-'))
const bundlePath = path.join(tempRoot, 'ai-response-envelope.cjs')

try {
  buildSync({
    entryPoints: [path.join(root, 'src', 'shared', 'ai-response-envelope.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundlePath,
    logLevel: 'silent',
  })

  const aiEnvelope = require(bundlePath)
  const completed = aiEnvelope.buildAiResponseEnvelope({
    taskType: 'library_qa',
    promptHash: 'prompt-hash',
    resultText: 'answer',
    provider: 'TestProvider',
    model: 'test-model',
    sources: [
      {
        doc_id: 'doc_a',
        doc_title: 'A',
        page_num: 1,
        snippet: 'source text',
        source_hash: 'hash-a',
        locator: {
          docId: 'doc_a',
          segmentId: 'seg_a',
          segmentOrdinal: 0,
          charStart: 0,
          charEnd: 4,
          matchText: 'text',
          queryTerm: 'text',
          occurrenceIndex: 0,
        },
      },
      {
        doc_id: 'doc_b',
        doc_title: 'B',
        page_num: null,
        snippet: 'missing trace fields',
      },
    ],
    warnings: ['low evidence'],
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:00:01.000Z',
    elapsedMs: 1000,
  })

  assert.strictEqual(completed.status, 'completed')
  assert.strictEqual(completed.task_type, 'library_qa')
  assert.strictEqual(completed.prompt_hash, 'prompt-hash')
  assert.strictEqual(completed.source_summary.total, 2)
  assert.strictEqual(completed.source_summary.with_locator, 1)
  assert.strictEqual(completed.source_summary.missing_locator, 1)
  assert.strictEqual(completed.source_summary.with_source_hash, 1)
  assert.strictEqual(completed.source_summary.missing_source_hash, 1)
  assert.deepStrictEqual(completed.source_summary.doc_ids, ['doc_a', 'doc_b'])
  assert.strictEqual(completed.warning_count, 1)
  assert.strictEqual(completed.elapsed_ms, 1000)
  assert.ok(completed.confidence > 0 && completed.confidence <= 0.98)
  assert.strictEqual(aiEnvelope.hashAiEnvelopeText('answer'), completed.result_hash)

  const failed = aiEnvelope.buildAiResponseEnvelope({
    taskType: 'document_qa',
    errorMessage: 'failed',
    errorCode: 'Provider Timeout',
    completedAt: '2026-01-01T00:00:00.000Z',
  })
  assert.strictEqual(failed.status, 'error')
  assert.strictEqual(failed.confidence, 0)
  assert.strictEqual(failed.error_code, 'provider_timeout')

  const typesSource = fs.readFileSync(path.join(root, 'src', 'shared', 'types.ts'), 'utf8')
  const aiIpcSource = fs.readFileSync(path.join(root, 'src', 'main', 'ipc', 'ai.ts'), 'utf8')

  assert.ok(typesSource.includes('aiResponseEnvelope?: AiResponseEnvelope'), 'AI response types should expose optional response envelopes')
  assert.ok(typesSource.includes("from './ai-response-envelope'"), 'shared types should re-export AI response envelope contracts')
  assert.ok(aiIpcSource.includes('withAiResponseEnvelope'), 'AI IPC should centralize response envelope attachment')
  assert.ok(aiIpcSource.includes('aiResponseEnvelope: response.aiResponseEnvelope || null'), 'chat turn metadata should persist AI response envelopes')
  assert.ok(aiIpcSource.includes("emitAiStream(event, requestId, 'done', { ...responseWithEnvelope, session, turn })"), 'streaming AI done events should include response envelopes')
  assert.ok(aiIpcSource.includes("taskType: 'summary'"), 'selection summaries should include response envelopes')
  assert.ok(aiIpcSource.includes("taskType: 'synthesis'"), 'AI synthesis should include response envelopes')

  console.log('AI response envelope regression checks passed.')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}
