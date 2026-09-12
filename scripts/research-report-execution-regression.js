// Pure synthetic workloads; no API calls, credentials, or user databases.
const assert = require('node:assert/strict')
const path = require('node:path')
const { buildSync } = require('esbuild')
const result = buildSync({ entryPoints: [path.join(__dirname, '../src/main/research-report-execution.ts')], bundle: true, platform: 'node', format: 'cjs', write: false })
const mod = { exports: {} }
new Function('module', 'exports', result.outputFiles[0].text)(mod, mod.exports)
const { createResearchRequestLane, retryResearchRequest, packResearchText, generateResearchReportBatches, RESEARCH_REPORT_PROMPT_BYTES } = mod.exports

async function run() {
  const unicode = '汉字\ntext\n\u{20000}'.repeat(1000)
  const chunks = packResearchText(unicode, 200)
  assert.equal(chunks.join(''), unicode)
  assert(chunks.every((text) => Buffer.byteLength(text) <= 200 && !text.includes('\ufffd')))
  const lane = createResearchRequestLane()
  let active = 0
  let peak = 0
  const jobs = Array.from({ length: 1000 }, (_, i) => lane(async () => {
    peak = Math.max(peak, ++active)
    await Promise.resolve()
    active--
    if (i === 12) throw new Error('Synthetic failure')
    return i
  }))
  const settled = await Promise.allSettled(jobs)
  assert.equal(peak, 1)
  assert.equal(settled.filter((job) => job.status === 'fulfilled').length, 999)
  let attempts = 0
  let waits = 0
  await assert.rejects(retryResearchRequest(async () => { attempts++; throw new Error('Timeout') }, {
    retryable: () => true, onRetry: () => {}, wait: async () => { waits++ },
  }), /Timeout/)
  assert.equal(attempts, 2)
  assert.equal(waits, 1)
  attempts = 0
  await assert.rejects(retryResearchRequest(async () => { attempts++; throw new Error('Unauthorized') }, {
    retryable: () => false, onRetry: () => assert.fail('Do not retry permanent errors'),
  }), /Unauthorized/)
  assert.equal(attempts, 1)
  const sources = Array.from({ length: 1000 }, (_, i) => ({ id: `fixture-${i}`, text: `UNIQUE_RECORD_${i}_END ${'虚构原文'.repeat(100)}` }))
  const sent = []
  const output = await generateResearchReportBatches({ context: 'Synthetic context', sources, progress: () => {}, generate: async (prompt, label) => {
    assert(Buffer.byteLength(prompt) <= RESEARCH_REPORT_PROMPT_BYTES, `Unbounded ${label}`)
    sent.push({ prompt, label })
    return label === '最终报告' ? 'Synthetic final report' : 'Synthetic summary with source references'
  } })
  assert.equal(output, 'Synthetic final report')
  const finalPrompt = sent.find((item) => item.label === '最终报告').prompt
  assert(finalPrompt.includes('要求短摘要时只交付摘要'), 'Final batch instructions must preserve the requested concise format')
  assert(finalPrompt.includes('引用使用文献名称和原文页码'), 'Reader-facing citations need document names and pages')
  assert(finalPrompt.includes('不向读者显示内部ID'), 'Internal source identifiers must not become report prose')
  assert(finalPrompt.includes('不复述命中统计、分段或压缩机制'), 'Short reports should focus on the research findings, not pipeline metadata')
  assert(!finalPrompt.includes('包含总体判断、时空归类、证据解读与待核查问题'), 'The final batch must not override custom formats with a mandatory outline')
  const firstRound = sent.filter((item) => item.label.startsWith('第 1 轮')).map((item) => item.prompt).join('\n')
  for (let i = 0; i < 1000; i++) assert(firstRound.includes(`UNIQUE_RECORD_${i}_END`), `Lost record ${i}`)
  const longSent = []
  await generateResearchReportBatches({ context: '', sources: [{ id: 'oversized', text: unicode.repeat(8) }], progress: () => {}, generate: async (prompt, label) => {
    assert(Buffer.byteLength(prompt) <= RESEARCH_REPORT_PROMPT_BYTES)
    if (label.startsWith('第 1 轮')) { assert(prompt.includes('来源编号：oversized')); longSent.push(prompt) }
    return 'Synthetic summary'
  } })
  assert(longSent.length > 1)
  await assert.rejects(generateResearchReportBatches({ context: '', sources: sources.slice(0, 1), progress: () => {}, generate: async () => '' }), /空报告/)
  await assert.rejects(generateResearchReportBatches({ context: '', sources, progress: () => {}, generate: async () => 'x'.repeat(24000) }), /摘要过长/)
  console.log('Research report: 1000-record coverage, bounded UTF-8 batches, serial lane and limited retries passed.')
}
run().catch((error) => { console.error(error); process.exitCode = 1 })
