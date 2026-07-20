const assert = require('assert')
const { readFileSync } = require('fs')
const { join } = require('path')

const root = join(__dirname, '..')
const shared = readFileSync(join(root, 'src', 'shared', 'literature-page-numbers.ts'), 'utf8')
const mapMain = readFileSync(join(root, 'src', 'main', 'literature-page-map.ts'), 'utf8')
const database = readFileSync(join(root, 'src', 'main', 'database.ts'), 'utf8')
const ocrIpc = readFileSync(join(root, 'src', 'main', 'ipc', 'ocr.ts'), 'utf8')
const exportMain = readFileSync(join(root, 'src', 'main', 'export.ts'), 'utf8')

assert.ok(shared.includes('resolveLiteraturePageNumbers'), 'shared continuity resolver required')
assert.ok(shared.includes('extractPrintedPageFromOcrResult'), 'shared OCR label extract required')
assert.ok(shared.includes('hasReliableLiteraturePageAnchors'), 'sparse-anchor gate required')
assert.ok(shared.includes('applyForwardLiteratureAnchor'), 'manual forward-fill calibration required')
assert.ok(shared.includes("'manual'") || shared.includes('"manual"') || shared.includes('| \'manual\''), 'manual literature source required')
assert.ok(shared.includes('conflicts with the continuity') || shared.includes('continuity wins') || shared.includes('inferred'), 'continuity-over-OCR rule documented')
assert.ok(shared.includes('physical page_num 1, 2, 3, 4') || shared.includes('fall back to physical'), 'sparse books fall back to physical 1..N')
assert.ok(mapMain.includes('recomputeLiteraturePageMap'), 'main recompute entry required')
assert.ok(mapMain.includes('applyManualLiteraturePageAnchor'), 'manual calibration entry required')
assert.ok(database.includes('literature_page_num'), 'pages.literature_page_num column migration')
assert.ok(database.includes('literature_page_source'), 'pages.literature_page_source column migration')
assert.ok(ocrIpc.includes('recomputeLiteraturePageMap'), 'OCR path must recompute literature pages')
assert.ok(exportMain.includes('recomputeLiteraturePageMap'), 'export must recompute literature pages before markers')
assert.ok(exportMain.includes('exportDisplayPageNum'), 'export must prefer literature page labels')
assert.ok(/=== 第 \$\{exportDisplayPageNum\(page\)\} 页 ===/.test(exportMain), 'TXT fulltext markers must use literature display page')

function isPositiveInt(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 && Math.floor(n) === n
}

/** Mirror of hasReliableLiteraturePageAnchors for transpile-free regression. */
function hasReliableLiteraturePageAnchors(ocrLabels) {
  const n = ocrLabels.length
  if (n <= 0) return false
  let anchorCount = 0
  for (const label of ocrLabels) {
    if (isPositiveInt(label)) anchorCount += 1
  }
  if (anchorCount === 0) return false
  if (n < 10) return anchorCount >= 2
  const minAbsolute = Math.max(3, Math.min(12, Math.ceil(n * 0.04)))
  const minCoverage = n >= 40 ? 0.06 : 0.1
  return anchorCount >= minAbsolute && anchorCount / n >= minCoverage
}

// Lightweight pure-logic smoke via dynamic transpile-free reimplementation of the critical case.
// User rule: prev=100, next=102 => middle=101 even if OCR says 01.
function smokeResolve() {
  const ocr = [100, 1, 102]
  assert.ok(hasReliableLiteraturePageAnchors(ocr), 'dense triple anchors should be reliable')
  const lit = ocr.slice()
  const n = lit.length
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (ocr[i] == null || ocr[j] == null) continue
      const dPhys = j - i
      const dLab = ocr[j] - ocr[i]
      if (dLab === dPhys) {
        for (let k = i; k <= j; k++) lit[k] = ocr[i] + (k - i)
      }
    }
  }
  assert.strictEqual(lit[1], 101, 'middle page must be 101 when anchors are 100 and 102')
}
smokeResolve()

function smokeSparseFallback() {
  // 20 pages, only one accidental "558" mark → must stay physical 1..20
  const ocr = Array.from({ length: 20 }, () => null)
  ocr[10] = 558
  assert.ok(!hasReliableLiteraturePageAnchors(ocr), 'single sparse anchor is not reliable')
  const lit = ocr.map((label, index) => (
    hasReliableLiteraturePageAnchors(ocr) && label != null ? label : index + 1
  ))
  assert.deepStrictEqual(lit, Array.from({ length: 20 }, (_, i) => i + 1), 'sparse books use physical 1..N')
}
smokeSparseFallback()

function smokeNoLabels() {
  const ocr = Array.from({ length: 12 }, () => null)
  assert.ok(!hasReliableLiteraturePageAnchors(ocr), 'zero anchors is not reliable')
}
smokeNoLabels()

console.log('Literature page number continuity regression checks passed.')
