const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { buildSync } = require('esbuild')

const root = path.resolve(__dirname, '..')
const fixtures = JSON.parse(fs.readFileSync(
  path.join(root, 'scripts', 'fixtures', 'ocr-ir-benchmark.json'),
  'utf8',
))
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gujismart-ocr-benchmark-'))
const bundlePath = path.join(tempRoot, 'ocr-ir.cjs')

try {
  buildSync({
    entryPoints: [path.join(root, 'src', 'shared', 'ocr-ir.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundlePath,
    logLevel: 'silent',
  })
  const ocrIr = require(bundlePath)
  const summaries = fixtures.map((fixture) => {
    assert.ok(!fixture.result.gujismart_ir, `${fixture.name}: fixture must exercise lazy conversion`)
    const envelope = ocrIr.getOrBuildOcrPageIr(fixture.result, fixture.options)
    assert.ok(envelope, `${fixture.name}: expected lazy IR`)
    assert.strictEqual(envelope.pipelineVersion, ocrIr.OCR_IR_PIPELINE_VERSION, `${fixture.name}: pipeline version`)
    const readingBlocks = ocrIr.deriveOcrReadingBlocksFromIr(envelope)
    const text = ocrIr.deriveOcrTextFromIr(envelope)
    const firstTextBlock = envelope.page.blocks.find((block) => block.text)

    assert.strictEqual(firstTextBlock?.source.engine, fixture.expected.engine, `${fixture.name}: engine`)
    assert.strictEqual(envelope.page.paragraphs.length, fixture.expected.paragraphCount, `${fixture.name}: paragraphs`)
    assert.strictEqual(readingBlocks.length, fixture.expected.readingBlockCount, `${fixture.name}: reading blocks`)
    assert.strictEqual(envelope.page.discardedBlocks.length, fixture.expected.discardedBlockCount, `${fixture.name}: discarded blocks`)
    if (fixture.expected.text) assert.strictEqual(text, fixture.expected.text, `${fixture.name}: text`)
    for (const expectedText of fixture.expected.textIncludes || []) {
      assert.ok(text.includes(expectedText), `${fixture.name}: missing ${expectedText}`)
    }
    if (fixture.expected.captionHasParent) {
      const caption = envelope.page.blocks.find((block) => block.type === 'caption')
      assert.ok(caption?.parentBlockId, `${fixture.name}: caption parent`)
    }
    return {
      name: fixture.name,
      score: Number(envelope.page.quality.score.toFixed(3)),
      paragraphs: envelope.page.paragraphs.length,
      readingBlocks: readingBlocks.length,
    }
  })

  console.log(`OCR pipeline benchmark passed: ${JSON.stringify(summaries)}`)
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
