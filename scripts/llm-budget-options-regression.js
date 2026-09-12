const assert = require('node:assert/strict')
const path = require('node:path')
const vm = require('node:vm')
const { build } = require('esbuild')

const root = path.resolve(__dirname, '..')
const messages = [{ role: 'user', content: 'Test prompt' }]
const defaultConfig = { provider: 'AI', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' }
const openAiUsage = {
  prompt_tokens: 40,
  completion_tokens: 12,
  total_tokens: 52,
  prompt_tokens_details: { cached_tokens: 15 },
}
const normalizedUsage = { inputTokens: 40, outputTokens: 12, cachedInputTokens: 15, totalTokens: 52 }
const plain = (value) => JSON.parse(JSON.stringify(value))
const completion = (extra = {}) => ({ choices: [{ message: { content: 'answer' }, finish_reason: 'stop' }], ...extra })

async function main() {
  const state = {}
  const reset = () => Object.assign(state, {
    settings: {}, secretReads: 0, key: 'test-secret', fetches: [], replies: [],
    events: [], usage: [], timeouts: [], activeTimers: new Set(), abortImmediately: false,
  })
  reset()
  const stubs = {
    './database': `
      export function queryOne(sql) {
        const match = /WHERE key = '([^']+)'/.exec(sql)
        if (!match || !['llm_provider', 'llm_base_url', 'llm_model'].includes(match[1])) {
          throw new Error('Unexpected database read: ' + sql)
        }
        const value = globalThis.testState.settings[match[1]]
        return value === undefined ? undefined : { value }
      }
      export const queryAll = () => { throw new Error('Unexpected queryAll') }
      export const run = () => { throw new Error('Unexpected database write') }
      export const saveDatabase = run
      export const transaction = run
    `,
    './settings-security': `
      export function readProtectedSetting(key) {
        if (key !== 'llm_api_key') throw new Error('Unexpected secret read')
        globalThis.testState.secretReads++
        return globalThis.testState.key
      }
    `,
    './glossary-service': 'export const getActiveTranslationGlossary = () => []',
    './metadata-tags': `
      export const collectMetadataTagValues = () => []
      export const FIELD_TAG_COLORS = {}
      export const syncDocumentMetadataTags = () => {}
    `,
    './canonical-content': 'export const listCanonicalPageContents = () => ({ items: [], nextCursor: null })',
  }
  const bundle = await build({
    entryPoints: [path.join(root, 'src/main/ai.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    logLevel: 'silent',
    plugins: [{
      name: 'llm-budget-mocks',
      setup(context) {
        context.onResolve({ filter: /^\.\// }, (args) => args.path in stubs
          ? { path: args.path, namespace: 'llm-budget-mock' }
          : null)
        context.onLoad({ filter: /.*/, namespace: 'llm-budget-mock' }, (args) => ({
          contents: stubs[args.path], loader: 'js',
        }))
      },
    }],
  })
  const module = { exports: {} }
  vm.runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports, require, console, AbortController,
    testState: state,
    setTimeout(callback, delay) {
      state.timeouts.push(delay)
      const timer = setTimeout(callback, delay)
      state.activeTimers.add(timer)
      if (state.abortImmediately) queueMicrotask(callback)
      return timer
    },
    clearTimeout(timer) {
      state.activeTimers.delete(timer)
      clearTimeout(timer)
    },
    async fetch(url, init) {
      state.events.push('fetch')
      state.fetches.push({ url, ...init, body: JSON.parse(init.body) })
      const reply = state.replies.shift()
      assert.ok(reply, 'All requests must have a mocked response')
      if (reply.networkError) throw reply.networkError
      if (reply.waitForAbort) {
        return new Promise((resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
        })
      }
      return new Response(reply.raw ?? JSON.stringify(reply.data), { status: reply.status ?? 200 })
    },
  }, { filename: 'llm-budget-options.cjs' })
  const { callLLM, getLlmConfigIdentity, LlmRequestError } = module.exports
  const onUsage = (usage) => {
    state.events.push('usage')
    state.usage.push(plain(usage))
  }
  const onRequest = () => state.events.push('reserve')

  assert.deepEqual(plain(getLlmConfigIdentity()), defaultConfig)
  assert.equal(state.secretReads, 0, 'Identity must not access credentials')
  state.replies.push({ data: completion() })
  assert.equal(await callLLM(messages), 'answer')
  assert.deepEqual(state.fetches[0].body, { model: 'deepseek-chat', messages, temperature: 0.1 })
  assert.equal(state.fetches[0].url, `${defaultConfig.baseUrl}/chat/completions`)
  assert.equal(state.fetches[0].headers.Authorization, 'Bearer test-secret')
  assert.deepEqual(state.timeouts, [120000])
  assert.equal(state.activeTimers.size, 0)

  reset()
  state.settings = { llm_provider: ' Kimi ', llm_base_url: ' https://example.test/v1/// ', llm_model: ' kimi-model ' }
  const identity = getLlmConfigIdentity()
  assert.deepEqual(plain(identity), { provider: 'Kimi', baseUrl: 'https://example.test/v1', model: 'kimi-model' })
  assert.equal(state.secretReads, 0)
  state.replies.push({ data: completion({ usage: openAiUsage }) })
  assert.equal(await callLLM(messages, {
    expectedConfig: { provider: ' Kimi ', baseUrl: 'https://example.test/v1/', model: ' kimi-model ' },
    maxOutputTokens: 80, onUsage, onRequest,
  }), 'answer')
  assert.deepEqual(state.events, ['reserve', 'fetch', 'usage'])
  assert.deepEqual(state.usage, [normalizedUsage])
  assert.equal(state.fetches[0].body.max_tokens, 80)
  assert.equal(state.fetches[0].body.temperature, 1)
  assert.equal(state.fetches[0].url, 'https://example.test/v1/chat/completions')
  assert.deepEqual(Object.keys(identity).sort(), ['baseUrl', 'model', 'provider'])

  for (const field of ['provider', 'baseUrl', 'model']) {
    reset()
    const expectedConfig = getLlmConfigIdentity()
    state.settings[{ provider: 'llm_provider', baseUrl: 'llm_base_url', model: 'llm_model' }[field]] = 'changed'
    await assert.rejects(callLLM(messages, { expectedConfig, onRequest }), (error) => {
      assert.ok(error instanceof LlmRequestError)
      assert.equal(error.retryable, false)
      assert.match(error.message, /configuration mismatch/)
      assert.ok(!error.message.includes(state.key))
      return true
    })
    assert.equal(state.fetches.length, 0)
    assert.equal(state.secretReads, 0)
    assert.deepEqual(state.events, [])
  }

  reset()
  state.replies.push(
    { status: 400, data: { error: { message: 'Unsupported parameter: temperature' }, usage: openAiUsage } },
    { data: completion({ usage: { prompt_tokens: 30, completion_tokens: 5, prompt_cache_hit_tokens: 20 } }) },
  )
  await callLLM(messages, { maxOutputTokens: 90, onRequest, onUsage })
  assert.deepEqual(state.events, ['reserve', 'fetch', 'usage', 'reserve', 'fetch', 'usage'])
  assert.deepEqual(state.usage, [normalizedUsage, { inputTokens: 30, outputTokens: 5, cachedInputTokens: 20, totalTokens: 35 }])
  assert.equal(state.fetches[1].body.max_tokens, 90, 'Retry must retain the output cap')
  assert.ok(!('temperature' in state.fetches[1].body))

  for (const blockedRequest of [1, 2]) {
    reset()
    state.replies.push({ status: 400, data: { error: { message: 'temperature not supported' }, usage: openAiUsage } })
    const budgetError = new Error('Budget exhausted')
    let reservations = 0
    await assert.rejects(callLLM(messages, {
      onUsage,
      onRequest() {
        if (++reservations === blockedRequest) throw budgetError
      },
    }), (error) => error === budgetError)
    assert.equal(reservations, blockedRequest)
    assert.equal(state.fetches.length, blockedRequest - 1)
    assert.equal(state.usage.length, blockedRequest - 1)
    assert.equal(state.activeTimers.size, 0)
  }

  for (const rejectTruncated of [undefined, false, true]) {
    reset()
    state.replies.push({ data: completion({
      choices: [{ message: { content: 'partial' }, finish_reason: 'length' }], usage: openAiUsage,
    }) })
    const result = callLLM(messages, { rejectTruncated, onUsage, onRequest })
    if (rejectTruncated) {
      await assert.rejects(result, (error) => error instanceof LlmRequestError
        && !error.retryable && /truncated.*maxOutputTokens/.test(error.message))
    } else {
      assert.equal(await result, 'partial')
    }
    assert.deepEqual(state.usage, [normalizedUsage])
    assert.deepEqual(state.events, ['reserve', 'fetch', 'usage'])
  }

  reset()
  state.replies.push({ status: 429, data: { error: { message: 'Rate limited' }, usage: openAiUsage } })
  await assert.rejects(callLLM(messages, { onUsage, onRequest }), (error) => error.retryable && /HTTP 429/.test(error.message))
  assert.deepEqual(state.usage, [normalizedUsage])
  assert.deepEqual(state.events, ['reserve', 'fetch', 'usage'])

  for (const usage of [undefined, null, {}, [], 'invalid', { prompt_tokens: '3', completion_tokens: 2 }, { prompt_tokens: -1, completion_tokens: 2 }]) {
    reset()
    state.replies.push({ data: completion({ usage }) })
    await callLLM(messages, { onUsage })
    assert.deepEqual(state.usage, [], 'Absent or malformed usage must not become measured zeros')
  }
  reset()
  state.replies.push({ data: completion({ usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }) })
  await callLLM(messages, { onUsage })
  assert.deepEqual(state.usage, [{ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 }])

  for (const maxOutputTokens of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    reset()
    await assert.rejects(callLLM(messages, { maxOutputTokens, onRequest }), /maxOutputTokens/)
    assert.equal(state.fetches.length, 0)
    assert.deepEqual(state.events, [])
  }

  for (const [timeoutMs, expected] of [[42, 1000], [2500, 2500], [900000, 600000], [NaN, 120000]]) {
    reset()
    state.replies.push({ data: completion() })
    await callLLM(messages, { timeoutMs })
    assert.deepEqual(state.timeouts, [expected])
    assert.equal(state.activeTimers.size, 0)
  }
  reset()
  state.abortImmediately = true
  state.replies.push({ waitForAbort: true })
  await assert.rejects(callLLM(messages, { timeoutMs: 2500, onUsage, onRequest }), (error) => error instanceof LlmRequestError && error.retryable)
  assert.deepEqual(state.events, ['reserve', 'fetch'])
  assert.deepEqual(state.usage, [])
  assert.equal(state.activeTimers.size, 0)

  reset()
  const networkError = new Error('Connection reset')
  state.replies.push({ networkError })
  await assert.rejects(callLLM(messages, { onRequest, onUsage }), (error) => error === networkError)
  assert.deepEqual(state.events, ['reserve', 'fetch'])
  assert.deepEqual(state.usage, [])
  assert.equal(state.activeTimers.size, 0)

  reset()
  state.key = ''
  await assert.rejects(callLLM(messages, { onRequest }), /API Key/)
  assert.deepEqual(state.events, [])

  reset()
  state.replies.push({ status: 502, raw: 'Bad gateway' })
  await assert.rejects(callLLM(messages, { onUsage }), /Bad gateway/)
  assert.deepEqual(state.usage, [])
  assert.equal(state.activeTimers.size, 0)
  console.log('LLM budget options regression checks passed.')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
