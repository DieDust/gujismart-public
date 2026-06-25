const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

function assertIncludes(source, needle, label) {
  if (!source.includes(needle)) {
    throw new Error(`${label}: missing ${needle}`)
  }
}

function assertNotIncludes(source, needle, label) {
  if (source.includes(needle)) {
    throw new Error(`${label}: unexpected ${needle}`)
  }
}

function assertMatch(source, pattern, label) {
  if (!pattern.test(source)) {
    throw new Error(`${label}: missing pattern ${pattern}`)
  }
}

function between(source, start, end) {
  const startIndex = source.indexOf(start)
  if (startIndex < 0) return ''
  const endIndex = source.indexOf(end, startIndex + start.length)
  return endIndex < 0 ? source.slice(startIndex) : source.slice(startIndex, endIndex)
}

const textEditor = read('src/renderer/src/components/TextEditor.tsx')
const ocrText = read('src/renderer/src/utils/ocrText.ts')
const documentView = read('src/renderer/src/views/DocumentView.tsx')
const facsimileProofreader = read('src/renderer/src/components/GujiFacsimileProofreader.tsx')
const packageJson = JSON.parse(read('package.json'))

assertIncludes(textEditor, 'HolderOutlined', 'TextEditor should show a drag handle for OCR text blocks')
assertIncludes(textEditor, "gridTemplateColumns: '42px minmax(0, 1fr)'", 'TextEditor should provide a full-height left drag lane instead of a tiny handle button')
assertIncludes(textEditor, 'DragPreviewState', 'TextEditor should render a whole-row drag preview instead of moving only the handle')
assertIncludes(textEditor, "position: 'fixed'", 'TextEditor drag preview should be viewport-positioned like a drag overlay')
assertIncludes(textEditor, 'handleDragPointerDown', 'TextEditor should use pointer dragging from the left drag lane')
assertIncludes(textEditor, 'getInsertIndexFromPoint', 'TextEditor should use the pointer position to choose the insert position')
assertIncludes(textEditor, 'autoScroll', 'TextEditor should auto-scroll the text list during long drags')
assertIncludes(textEditor, 'showInsertBefore', 'TextEditor should render an insertion indicator before the hovered row')
assertIncludes(textEditor, 'showInsertAfter', 'TextEditor should render an insertion indicator after the final row')
assertIncludes(textEditor, 'shouldShiftForDrag', 'TextEditor should animate neighboring rows while dragging')
assertIncludes(textEditor, 'touchAction: \'none\'', 'TextEditor drag lane should enlarge the drag hit area without text-selection interference')
assertIncludes(textEditor, 'onPointerDown={(event) => handleDragPointerDown(event, index)}', 'TextEditor should start block reordering from the full-height drag lane')
assertIncludes(textEditor, 'getMoveTargetIndex(index, nextInsertIndex, layoutData.length)', 'TextEditor should drop blocks by insertion index rather than the small target row only')
assertIncludes(textEditor, 'onLineFocus?.(nextTargetIndex, nextData[nextTargetIndex])', 'TextEditor should keep focus on the dragged block after it is dropped')
assertNotIncludes(textEditor, 'onDragStart={(event) => handleDragStart(event, index)}', 'TextEditor should not rely on native drag previews that only move the handle')
assertIncludes(textEditor, 'normalizeManualReadingOrder', 'TextEditor should normalize per-page manual reading order')
assertIncludes(textEditor, 'manual_reading_order: index', 'TextEditor should persist manual_reading_order on each block')
assertIncludes(textEditor, 'getTextFlowOcrBlocks({ ocr_result: ocrResult })', 'TextEditor should display text blocks in text-flow order')
assertIncludes(textEditor, 'proofed_text: nextText', 'TextEditor saves should refresh proofed_text for reading mode')
assertIncludes(textEditor, 'ocr_text: nextText', 'TextEditor saves should refresh ocr_text for fallback reading mode')
assertIncludes(textEditor, 'words_result: normalizedData.map', 'TextEditor saves should rebuild words_result in the reordered sequence')
assertNotIncludes(textEditor, 'getOrderedOcrBlocks', 'TextEditor should not use coordinate/layout ordering for the editable text list')

assertIncludes(ocrText, 'export function getTextFlowOcrBlocks', 'ocrText should expose a dedicated text-flow block sorter')
assertIncludes(ocrText, 'getManualReadingOrder', 'ocrText should detect manual reading order separately from layout order')
assertIncludes(ocrText, 'manual_reading_order', 'ocrText text-flow ordering should read manual_reading_order')
assertIncludes(ocrText, 'return compareByOriginalReadingOrder(left, right)', 'Text-flow ordering should fall back to the original OCR order')
assertIncludes(ocrText, 'const ordered = getTextFlowOcrBlocks(page)', 'Ordered block text should honor manual reading order')
assertIncludes(ocrText, 'for (const block of getTextFlowOcrBlocks({ ...page, ocr_result: { layout_result: layoutBlocks } }))', 'Readable layout elements should honor manual reading order')
assertMatch(
  ocrText,
  /export function extractPageText\(page: OcrTextPage\): string \{\s+const blocks = getTextFlowOcrBlocks\(page\)/,
  'extractPageText should prefer manually ordered blocks when it reads OCR block text',
)
assertMatch(
  ocrText,
  /export function getReadablePageElements\(page: OcrTextPage\): ReadablePageElement\[\] \{\s+if \(isEbookPage\(page\)\) return getEbookReadableElements\(page\)\s+const blocks = getTextFlowOcrBlocks\(page\)/,
  'getReadablePageElements should use the text-flow sorter for ordinary reading',
)

const orderedSorter = between(ocrText, 'export function getOrderedOcrBlocks', 'function compareByOriginalReadingOrder')
assertNotIncludes(orderedSorter, 'manual_reading_order', 'Coordinate/layout ordering should not depend on manual_reading_order')

assertIncludes(documentView, 'getTextFlowOcrBlocks', 'DocumentView should import the text-flow sorter')
assertIncludes(documentView, 'const boxes = getTextFlowOcrBlocks(page) as FacsimileLayoutBlock[]', 'Reader search should inspect blocks in text-flow order')
assertIncludes(documentView, 'const textFlowBoxes = useMemo(() => (currentPage ? getTextFlowOcrBlocks(currentPage)', 'DocumentView should keep a text-flow box list for the current page')
assertIncludes(documentView, 'buildBoxIndexMap(layoutBoxes, textFlowBoxes)', 'DocumentView should map layout indexes to text-flow indexes')
assertIncludes(documentView, 'buildBoxIndexMap(textFlowBoxes, layoutBoxes)', 'DocumentView should map text-flow indexes back to layout indexes')
assertIncludes(documentView, 'boxIndex: getMappedBoxIndex(textFlowToLayoutIndex, boxIndex)', 'Search matches should return layout box indexes after text-flow scanning')
assertIncludes(documentView, 'activeBoxIndex={activeTextEditorBoxIndex}', 'TextEditor should receive text-flow active indexes')
assertIncludes(documentView, 'onLineFocus={handleTextEditorLineFocus}', 'TextEditor line focus should map text-flow indexes back to layout indexes')
assertIncludes(documentView, 'findBoxIndexByIdentity(layoutBoxes, textFlowBox)', 'TextEditor drag focus should follow the dragged block identity after reorder')
assertIncludes(documentView, 'const layoutBoxes = useMemo(() => (currentPage ? getOrderedOcrBlocks(currentPage)', 'Image/layout preview should keep using coordinate/layout order')

assertNotIncludes(facsimileProofreader, 'manual_reading_order', 'Facsimile proofreader should not use manual reading order')
assertNotIncludes(facsimileProofreader, 'getTextFlowOcrBlocks', 'Facsimile proofreader should not use text-flow ordering for coordinate layout')
assertIncludes(facsimileProofreader, 'getOrderedOcrBlocks', 'Facsimile proofreader should keep its original layout ordering path')

assertIncludes(packageJson.scripts['check:reading-order'] || '', 'scripts/reading-order-regression.js', 'package.json should expose check:reading-order')
assertIncludes(packageJson.scripts.check || '', 'npm run check:reading-order', 'The aggregate check script should include check:reading-order')

console.log('Reading order regression checks passed')
