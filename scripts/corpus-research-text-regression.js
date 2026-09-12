// Synthetic inputs only: no model calls, credentials, databases, or generated files.
const assert = require('node:assert/strict')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { buildSync } = require('esbuild')
const output = buildSync({ entryPoints: [path.join(__dirname, '../src/main/corpus-research-text.ts')], bundle: true, platform: 'node', format: 'cjs', write: false })
const entry = { exports: {} }
new Function('module', 'exports', 'require', output.outputFiles[0].text)(entry, entry.exports, require)
const { splitCorpusText, corpusTextHash, parseCorpusFindings } = entry.exports

function verifySplit(text, maxBytes = 12000) {
  const units = splitCorpusText(text, maxBytes)
  assert.equal(units.map((unit) => unit.text).join(''), text, 'No lost or duplicated characters')
  assert.deepEqual(units, splitCorpusText(text, maxBytes), 'Stable boundaries')
  let end = 0
  for (const unit of units) {
    assert.equal(unit.start, end, 'Contiguous UTF-16 offsets')
    assert(unit.end > unit.start)
    assert.equal(unit.text, text.slice(unit.start, unit.end))
    assert(Buffer.byteLength(unit.text, 'utf8') <= maxBytes, 'Bounded UTF-8 size')
    const before = text.charCodeAt(unit.end - 1)
    const after = text.charCodeAt(unit.end)
    assert(!(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff), 'Do not split surrogate pairs')
    end = unit.end
  }
  assert.equal(end, text.length)
  return units
}

const finding = (quote, overrides = {}) => ({ claim: 'The source denies the attributed claim.', quote, stance: 'challenge', dimension: 'attribution', uncertainty: 'Reported, not independently verified.', ...overrides })
const response = (findings, extra = {}) => JSON.stringify({ findings, ...extra })

assert.deepEqual(verifySplit(''), [])
for (const budget of [1, 2, 3, 4, 5, 7, 16, 12000]) verifySplit(' \t\r\n \n\nabc\rdef \t\n', budget)
for (const budget of [4, 5, 7, 31, 128, 12000]) {
  verifySplit(('\u6c49\u5b57\u{20000}\u{1f642} e\u0301\r\n \t\r\n').repeat(1500), budget)
  verifySplit('\ud800 x \udc00\r\n'.repeat(20), budget)
}
assert.deepEqual(splitCorpusText('abcdef', 1).map((unit) => unit.text), ['a', 'b', 'c', 'd', 'e', 'f'])
assert.equal(splitCorpusText('a'.repeat(12001))[0].end, 12000)
assert.equal(splitCorpusText('\u6c49'.repeat(4001))[0].end, 4000)
assert.equal(splitCorpusText('\u{20000}'.repeat(3001))[0].end, 6000)
for (const invalid of [0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '12', null]) {
  assert.throws(() => splitCorpusText('abc', invalid), /maxBytes/)
  assert.throws(() => splitCorpusText('', invalid), /maxBytes/)
}
assert.throws(() => splitCorpusText(null), /string/)
assert.throws(() => splitCorpusText('\u{20000}', 3), /cannot fit/)
assert.throws(() => splitCorpusText('abc\u6c49', 2), /cannot fit/)
assert.throws(() => splitCorpusText('\ud800', 2), /cannot fit/)
assert.equal(verifySplit('aa\n\nbbbbbbbbb', 8)[0].text, 'aa\n\n')
assert.equal(verifySplit('aa\r\n \t\r\nbbbbbbbbb', 12)[0].text, 'aa\r\n \t\r\n')
assert.equal(verifySplit('aa\n\nbb\ncccccccc', 10)[0].text, 'aa\n\n', 'Paragraphs precede line fallback')
assert.equal(verifySplit('aa\r\nbbbbbbbb', 8)[0].text, 'aa\r\n', 'CRLF is not a blank line')
assert.equal(verifySplit('aa\r\rbbbbbbbb', 8)[0].text, 'aa\r\r')
assert.equal(verifySplit('aa\u2029bbbbbbbb', 9)[0].text, 'aa\u2029')
assert.equal(verifySplit('aa\u2028bbbbbbbb', 9)[0].text, 'aa\u2028')
assert.equal(splitCorpusText('aa\n\nbb', 7).length, 1, 'Do not split an already fitting input')

const documents = Array.from({ length: 1000 }, (_, index) => {
  const tail = `TAIL_${index}: author ${index} did not confirm the attribution.`
  const text = `DOC_${index}\r\n\r\n` + `\u7532\u4e59\u{20000} synthetic paragraph ${index}.\n\n`.repeat(360 + index % 11) + tail + ' \r\n\t'
  const units = verifySplit(text)
  assert(units.length > 1)
  const tailUnit = units.at(-1)
  const [evidence] = parseCorpusFindings(response([finding(tail)]), tailUnit.text)
  assert.equal(evidence.stance, 'challenge')
  assert.equal(text.slice(tailUnit.start + evidence.start, tailUnit.start + evidence.end), tail)
  assert.equal(tailUnit.start + evidence.start, text.indexOf(tail), 'Tail evidence survives every document')
  return text
})
verifySplit(documents.join('\n\n'))

const source = '\u{20000}\u6c49 prefix \r\n  Author: not established.\t\r\nAuthor: not established.'
const quote = '  Author: not established.\t\r\n'
const input = finding(quote, { claim: '  Keep attribution and negation.  ', uncertainty: '' })
const [parsed] = parseCorpusFindings(response([input]), source)
assert.deepEqual(parsed, { ...input, start: source.indexOf(quote), end: source.indexOf(quote) + quote.length })
assert.equal(source.slice(parsed.start, parsed.end), quote)
assert.equal(parseCorpusFindings(response([finding('Author: not established.')]), source)[0].start, source.indexOf('Author: not established.'), 'First duplicate occurrence is deterministic')
for (const stance of ['support', 'challenge', 'context']) {
  assert.equal(parseCorpusFindings(response([finding('\u{20000}\u6c49', { stance })]), source)[0].end, 3, 'UTF-16, not code point or byte offsets')
}
assert.deepEqual(parseCorpusFindings('{"findings":[],"reviewed":true}', source), [])
for (const raw of ['', 'null', '[]', '{}', '{', '{"findings":null}', '{"findings":{}}', '{"findings":[]}', '{"findings":[],"reviewed":false}', '{"findings":[],"reviewed":"true"}', '{"findings":[],"reviewed":1}', '{"findings":[],"reviewed":true} trailing', '```json\n{"findings":[],"reviewed":true}\n```']) {
  assert.throws(() => parseCorpusFindings(raw, source), undefined, `Invalid response: ${raw}`)
}
assert.throws(() => parseCorpusFindings(null, source), /strings/)
assert.throws(() => parseCorpusFindings(response([]), null), /strings/)
for (const bad of [null, [], 'claim', {}, finding(quote, { stance: 'neutral' }), finding('absent'), finding('author: not established.'), finding('Author: not  established.'), finding('\ud840'), finding(''), finding(' \t')]) {
  assert.throws(() => parseCorpusFindings(response([bad]), source))
}
assert.throws(() => parseCorpusFindings(response([finding('\u00e9')]), 'e\u0301'), /exact substring/, 'No Unicode normalization')
assert.throws(() => parseCorpusFindings(response([input, finding('not in source')]), source), /exact substring/, 'Reject whole response, not just invalid findings')
for (const field of ['claim', 'quote', 'dimension', 'uncertainty']) {
  const missing = { ...input }
  delete missing[field]
  assert.throws(() => parseCorpusFindings(response([missing]), source), /must be/)
  for (const value of [null, 42, {}, []]) {
    assert.throws(() => parseCorpusFindings(response([{ ...input, [field]: value }]), source), /must be/)
  }
}
for (const field of ['claim', 'dimension']) {
  assert.throws(() => parseCorpusFindings(response([{ ...input, [field]: ' \n' }]), source), /nonempty/)
}
for (const [field, limit] of Object.entries({ claim: 4096, quote: 12000, dimension: 1024, uncertainty: 4096 })) {
  const exact = '\u6c49'.repeat(Math.floor(limit / 3)) + 'x'.repeat(limit % 3)
  const unitText = field === 'quote' ? exact + 'x' : source
  assert.equal(parseCorpusFindings(response([{ ...input, [field]: exact }]), unitText)[0][field], exact)
  assert.throws(() => parseCorpusFindings(response([{ ...input, [field]: exact + 'x' }]), unitText), /exceeds/, `Reject, never clip ${field}`)
}
assert.equal(parseCorpusFindings(response(Array.from({ length: 64 }, () => input)), source).length, 64)
assert.throws(() => parseCorpusFindings(response(Array.from({ length: 65 }, () => input)), source), /exceeds 64 findings/)
const emptyReviewed = '{"findings":[],"reviewed":true}'
assert.deepEqual(parseCorpusFindings(emptyReviewed.padEnd(262144, ' '), source), [])
assert.throws(() => parseCorpusFindings(emptyReviewed.padEnd(262145, ' '), source), /Response exceeds/)
assert.throws(() => parseCorpusFindings(response(Array.from({ length: 64 }, () => ({ ...input, claim: 'x'.repeat(4096) }))), source), /Response exceeds/, 'Bound aggregate bytes even with individually valid findings')

assert.equal(corpusTextHash(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
assert.equal(corpusTextHash('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
assert.equal(corpusTextHash(source), createHash('sha256').update(source, 'utf8').digest('hex'))
assert.notEqual(corpusTextHash('text'), corpusTextHash('text '))
assert.notEqual(corpusTextHash('\u00e9'), corpusTextHash('e\u0301'))
console.log('Corpus text regression passed: 1000-document roundtrip and tail evidence, bounded paragraph-aware UTF-8 chunks, UTF-16 offsets, whitespace/surrogates, SHA-256, strict findings and output limits.')
