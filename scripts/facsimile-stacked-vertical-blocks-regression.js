const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const source = fs.readFileSync(path.join(root, 'src/renderer/src/components/GujiFacsimileProofreader.tsx'), 'utf8')
const documentViewSource = fs.readFileSync(path.join(root, 'src/renderer/src/views/DocumentView.tsx'), 'utf8')

function assertIncludes(needle, label) {
  if (!source.includes(needle)) {
    throw new Error(`${label}: missing ${needle}`)
  }
}

function assertDocumentViewIncludes(needle, label) {
  if (!documentViewSource.includes(needle)) {
    throw new Error(`${label}: missing ${needle}`)
  }
}

function assertNotIncludes(needle, label) {
  if (source.includes(needle)) {
    throw new Error(`${label}: unexpected ${needle}`)
  }
}

assertIncludes('function splitStackedVerticalBlocks', 'facsimile proofreader should split overlapping vertical OCR blocks')
assertIncludes('getStackedVerticalBlockKey', 'facsimile proofreader should group same-rectangle vertical blocks')
assertIncludes('const columnWidth = firstRect.width / group.length', 'stacked vertical blocks should be divided into columns')
assertIncludes('firstRect.left + firstRect.width - (columnIndex + 1) * columnWidth', 'vertical columns should be laid out right-to-left')
assertIncludes('splitStackedVerticalBlocks(splitWideVerticalBlocks(normalizePageOrientations(normalizeBlocks(ocrResult))))', 'stacked block splitting should run in the OCR normalization pipeline')
assertIncludes('uniqueTextCount <= 1', 'exact duplicate stacked blocks should be deduped instead of split')
assertIncludes('hasOriginalLayoutCoordinates', 'facsimile proofreader should distinguish real OCR coordinates from synthetic fallback layout')
assertIncludes('isSyntheticLayoutFallback', 'facsimile proofreader should not pretend text-only OCR is a positioned facsimile layout')
assertIncludes('data-facsimile-missing-layout-warning="true"', 'facsimile proofreader should warn when OCR layout coordinates are missing')
assertIncludes('当前 OCR 缺少版式坐标', 'missing layout warning should explain why position restoration is unavailable')
assertIncludes('activeSearchHitOrdinal', 'facsimile proofreader should distinguish repeated hits inside the same OCR block')
assertIncludes('data-search-active={isActiveHit ?', 'facsimile proofreader should mark the active keyword hit, not only the active box')
assertIncludes('normalizedText.indexOf(normalizedQuery, cursor)', 'facsimile proofreader should render every keyword occurrence instead of only the first one')
assertIncludes('renderFormattedText(fittedDisplayText, searchKeyword, keywordMatch', 'facsimile proofreader should highlight keyword text in all matching blocks')
assertIncludes('activeHit.scrollIntoView', 'facsimile proofreader should scroll to repeated active hits inside the same OCR block')
assertIncludes('[activeBoxIndex, activeSearchHitOrdinal]', 'active hit scrolling should rerun when next/previous moves within the same OCR block')
assertIncludes("const columnCount = Math.max(1, Math.ceil((length * fontSize * 1.02) / usableHeight))", 'single vertical OCR blocks should fit by flowing into multiple columns inside the recognized region')
assertIncludes("verticalColumnCount > 1 || preserveVerticalColumns ? 'pre' : 'normal'", 'single vertical OCR blocks should not be forced into one nowrap column')
assertNotIncludes("verticalColumnCount > 1 || preserveVerticalColumns ? 'pre' : 'nowrap'", 'single vertical OCR blocks should wrap into additional columns instead of squeezing into one unreadable column')
assertNotIncludes('getEstimatedVerticalColumnCount', 'facsimile proofreader should not force vertical OCR text into estimated columns')
assertNotIncludes('splitTextIntoVerticalColumns', 'facsimile proofreader should preserve OCR-provided vertical text columns instead of inventing columns')
assertDocumentViewIncludes("const shouldLoadSearchPages = shouldUseSourcePageReader || documentMode === 'proof'", 'proof mode search should load document-wide search pages')
assertDocumentViewIncludes('readerSearchPages.map((page, fallbackIndex)', 'proof mode search should count hits across loaded document search pages')
assertDocumentViewIncludes('firstMatchAtOrAfterCurrentPage', 'proof mode search should start from the current page when full-document hits load')
assertDocumentViewIncludes('loadPagesAround(match.pageIndex, 5)', 'proof mode next/previous search navigation should preload the target page')

console.log('Facsimile stacked vertical block regression checks passed')
