const assert = require('assert')
const fs = require('fs')
const path = require('path')
const ts = require('typescript')

const root = path.resolve(__dirname, '..')
const helperPath = path.join(root, 'src/shared/vision-ocr-response.ts')
const helperSource = fs.readFileSync(helperPath, 'utf8')
const transpiled = ts.transpileModule(helperSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText
const helperModule = { exports: {} }
new Function('exports', 'module', 'require', transpiled)(helperModule.exports, helperModule, require)

const {
  getVisionMessageOutput,
  isUnsupportedVisionRequestField,
  normalizeVisionFallbackText,
  shouldDisableVisionThinking,
} = helperModule.exports

const reasoningOnly = getVisionMessageOutput({
  choices: [{
    finish_reason: '',
    message: {
      content: '',
      reasoning_content: 'I am still analyzing the page and have not emitted the final answer.',
    },
  }],
})
assert.strictEqual(reasoningOnly.content, '', 'reasoning_content must never be treated as OCR text')
assert.ok(reasoningOnly.reasoningContent.length > 0, 'reasoning-only responses must be detectable for retry and diagnostics')

const arrayContent = getVisionMessageOutput({
  choices: [{ message: { content: [{ type: 'output_text', text: '{"text":"正文"}' }] } }],
})
assert.strictEqual(arrayContent.content, '{"text":"正文"}', 'OpenAI-compatible array content must be joined into final content')

assert.ok(
  shouldDisableVisionThinking('https://ark.cn-beijing.volces.com/api/v3', 'doubao-seed-2-0-mini-260428'),
  'VolcEngine Doubao Seed visual OCR must disable thinking so reasoning cannot consume the OCR output budget',
)
assert.ok(
  !shouldDisableVisionThinking('https://api.openai.com/v1', 'gpt-4.1-mini'),
  'provider-specific thinking controls must not leak into unrelated OpenAI-compatible endpoints',
)
assert.ok(
  isUnsupportedVisionRequestField('Invalid extra field: thinking', 'thinking'),
  'unsupported thinking parameters must trigger a compatibility retry without that field',
)
assert.ok(
  isUnsupportedVisionRequestField('response_format json_object is not supported', 'response_format'),
  'unsupported JSON mode must trigger a plain response retry',
)
assert.strictEqual(
  normalizeVisionFallbackText('```text\n甲乙丙\n```'),
  '甲乙丙',
  'plain-text fallback must remove fences without changing OCR text',
)

const visionOcrSource = fs.readFileSync(path.join(root, 'src/main/vision-ocr.ts'), 'utf8')
assert.ok(visionOcrSource.includes("let usedJsonMode = mode !== 'fallback_text'"), 'fallback_text must be a real non-JSON request')
assert.ok(visionOcrSource.includes("thinking: { type: 'disabled' }"), 'vision requests must be able to disable provider reasoning')
assert.ok(visionOcrSource.includes("errorStage: 'empty_final_content'"), 'reasoning-only responses need an explicit diagnostic stage')
assert.ok(visionOcrSource.includes("warnings: ['视觉模型结构化 JSON 输出失败，本页已使用纯文本 OCR 降级结果。']"), 'plain final text must be normalized into a saveable OCR result')
assert.ok(!visionOcrSource.includes('content = reasoningContent'), 'reasoning text must never be stored as OCR output')

console.log('Vision OCR final-content regression passed.')
