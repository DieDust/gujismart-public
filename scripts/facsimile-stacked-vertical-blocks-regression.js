const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const source = fs.readFileSync(path.join(root, 'src/renderer/src/components/GujiFacsimileProofreader.tsx'), 'utf8')
const documentViewSource = fs.readFileSync(path.join(root, 'src/renderer/src/views/DocumentView.tsx'), 'utf8')
const overlayProofreaderSource = fs.readFileSync(path.join(root, 'src/renderer/src/components/OverlayProofreader.tsx'), 'utf8')
const imageViewerSource = fs.readFileSync(path.join(root, 'src/renderer/src/components/ImageViewer.tsx'), 'utf8')
const ocrIrSource = fs.readFileSync(path.join(root, 'src/shared/ocr-ir.ts'), 'utf8')
const mainOcrSource = fs.readFileSync(path.join(root, 'src/main/ocr.ts'), 'utf8')

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

function assertOverlayProofreaderIncludes(needle, label) {
  if (!overlayProofreaderSource.includes(needle)) {
    throw new Error(`${label}: missing ${needle}`)
  }
}

function assertImageViewerIncludes(needle, label) {
  if (!imageViewerSource.includes(needle)) {
    throw new Error(`${label}: missing ${needle}`)
  }
}

function assertOcrIrIncludes(needle, label) {
  if (!ocrIrSource.includes(needle)) {
    throw new Error(`${label}: missing ${needle}`)
  }
}

function assertMainOcrIncludes(needle, label) {
  if (!mainOcrSource.includes(needle)) {
    throw new Error(`${label}: missing ${needle}`)
  }
}

function assertMainOcrNotIncludes(needle, label) {
  if (mainOcrSource.includes(needle)) {
    throw new Error(`${label}: unexpected ${needle}`)
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
assertIncludes('splitStackedVerticalBlocks(splitWideVerticalBlocks(normalizePageOrientations(normalizeBlocks(ocrResult), effectivePreferVerticalLayout)))', 'stacked block splitting should run in the OCR normalization pipeline with document-level vertical preference')
assertIncludes('FACSIMILE_SPLIT_COLUMN_SOURCE_INDEX_BASE', 'split vertical columns should use a reserved source-index range')
assertIncludes('__sourceIndex: FACSIMILE_SPLIT_COLUMN_SOURCE_INDEX_BASE + sourceIndex * 1000 + columnIndex', 'split vertical columns should not reuse source indexes from neighboring OCR blocks')
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
assertIncludes('function isOrdinaryVerticalPageTextBlock', 'facsimile proofreader should identify normal body text that belongs to a dominant vertical page')
assertIncludes('function hasVerticalColumnTextShape', 'facsimile proofreader should keep vertical column body blocks vertical on mixed exercise pages')
assertIncludes('function isLikelyVerticalPseudoTableBlock', 'facsimile proofreader should detect vertical text columns mislabeled as tables')
assertIncludes('function shouldRenderAsTableBlock(block: unknown, pageVerticalMode = false)', 'facsimile proofreader should distinguish true tables from vertical pseudo tables')
assertIncludes('denseVerticalTextGrid', 'facsimile proofreader should treat dense short-cell vertical OCR grids as pseudo tables')
assertIncludes('expandedVerticalLineShape && (denseVerticalTextGrid || expandedSparseVocabularyGrid)', 'facsimile proofreader should use the expanded pseudo-table detector before rendering tables')
assertIncludes('pageVerticalMode && isLikelyVerticalPseudoTableBlock(block)', 'facsimile persistence should downgrade vertical pseudo tables in vertical page mode')
assertIncludes("label: pseudoTable ? 'text' : rest.label", 'vertical pseudo tables should be saved back as text blocks')
assertIncludes('rows: pseudoTable ? undefined : rest.rows', 'vertical pseudo tables should not persist table rows after proof save')
assertIncludes('const isTable = shouldRenderAsTableBlock(block, pageVerticalMode)', 'facsimile renderer should not draw vertical pseudo tables as HTML tables')
assertMainOcrIncludes('function downgradeVerticalPseudoTableBlocks', 'main OCR post-processing should downgrade vertical pseudo tables before saving')
assertMainOcrIncludes('pseudo_table_downgraded: true', 'main OCR should mark downgraded pseudo tables for diagnostics')
assertMainOcrIncludes('downgraded_vertical_pseudo_tables', 'main OCR should preserve pseudo-table downgrade counts in processing metadata')
assertMainOcrIncludes('function correctRotatedOcrCoordinatesForSourceImage', 'main OCR may keep rotated-coordinate diagnostics for non-preserved page-image paths')
assertMainOcrIncludes("ocr_coordinate_rotation_corrected: 'clockwise_to_source'", 'main OCR should record rotated coordinate correction metadata when explicitly applied')
assertMainOcrIncludes('const coordinateCorrectedInput = preserveServiceCoordinates', 'main OCR should skip rotated-coordinate correction when preserving async PDF service coordinates')
assertMainOcrIncludes('const orientationNormalizedInput = !preserveServiceCoordinates && resolved.profile === \'guji_print_vertical\'', 'main OCR should skip guji orientation normalization when preserving async PDF service coordinates')
assertMainOcrIncludes('const downgradedInput = preserveServiceCoordinates', 'main OCR should skip pseudo-table coordinate/layout rewriting when preserving async PDF service coordinates')
assertMainOcrIncludes('function clampGujiOcrResultToSourceImage', 'main OCR may keep clamping diagnostics for non-preserved page-image paths')
assertMainOcrIncludes('ocr_coordinate_clamped_to_source', 'main OCR should record clamped guji OCR box counts when clamping is explicitly applied')
assertMainOcrIncludes('function tightenOcrTextCoordinatesToLocalInk', 'main OCR may keep local-ink coordinate repair code for explicit diagnostics')
assertMainOcrIncludes('ocr_coordinate_tightened_to_local_ink', 'main OCR should record local-ink coordinate tightening when explicitly applied for diagnostics')
assertMainOcrIncludes('if (preserveServiceCoordinates) {', 'async PDF OCR post-processing should return before any guji second-pass coordinate/layout rewriting')
assertMainOcrIncludes('markServiceCoordinatesPreserved(attachProcessingMeta(serviceCoordinateWithFallback, resolved, imagePath, {', 'async PDF OCR saves should mark service-returned coordinates as preserved after attaching a local page-image fallback size')
assertMainOcrIncludes('preserveServiceCoordinates: true', 'async PDF OCR saves should not overwrite the service coordinate basis with local page-image dimensions')
assertMainOcrIncludes('const workingResult = clampedInput', 'default page-image OCR post-processing should keep coordinate tightening opt-in')
assertMainOcrIncludes('return result', 'stored non-guji OCR reads should not dynamically tighten OCR coordinates against local ink')
assertMainOcrNotIncludes('const workingResult = tightenOcrTextCoordinatesToLocalInk(clampedInput, imagePath)', 'default OCR post-processing must not replace OCR coordinates with local ink boxes')
assertMainOcrNotIncludes('const tightened = tightenOcrTextCoordinatesToLocalInk(result, imagePath)', 'stored OCR reads must not silently move previously saved OCR coordinates')
assertMainOcrNotIncludes('const tightened = tightenOcrTextCoordinatesToLocalInk(clamped, imagePath)', 'stored guji OCR reads must not silently move previously saved OCR coordinates')
assertMainOcrIncludes('useChartRecognition: !preferVertical', 'vertical sync OCR should disable server-side chart/table recognition to avoid wrapping vertical prose as tables')
assertMainOcrIncludes('function looksLikeCjkDominantText', 'main OCR should allow CJK-dominant wide blocks to be probed for local vertical columns')
assertMainOcrIncludes("shouldProbeHorizontalBlockForVerticalColumns(block, options.profile === 'guji_print_vertical')", 'vertical guji OCR should split wide horizontal-looking blocks with the same single-page vertical post-processing path')
assertMainOcrIncludes('preferGujiVertical ? inferGujiVerticalOrientation(box) : inferOrientation(box)', 'main OCR reading order should not let explicit horizontal OCR tags override guji vertical geometry')
assertIncludes("if (hasVerticalColumnTextShape(block)) return 'vertical'", 'mixed vertical pages should preserve detected vertical column text before horizontal heuristics')
assertIncludes("if (isOrdinaryVerticalPageTextBlock(block)) return 'vertical'", 'dominant vertical pages should coerce ordinary body text blocks to vertical before strong horizontal heuristics')
assertIncludes('const effectivePreferVerticalLayout = useMemo', 'facsimile proofreader should keep document-level vertical layout preference')
assertIncludes('preferVerticalLayout || isGujiVerticalOcrResult(ocrResult)', 'facsimile proofreader should prefer vertical layout for guji vertical OCR results')
assertIncludes('const pageVerticalMode = useMemo(() => effectivePreferVerticalLayout || isVerticalPage(pageBlocks)', 'mixed guji pages should not fall back to horizontal page mode')
assertIncludes('buildOcrPayload(ocrResult, nextBlocks, pageProofStatus, effectivePreferVerticalLayout)', 'facsimile persistence should preserve the document-level vertical preference')
assertIncludes("orientation_source: 'manual'", 'manual orientation toggles should persist a manual orientation source')
assertIncludes('const currentOrientation = inferPageAwareOrientation(block, pageVerticalModeForToggle)', 'manual orientation toggles should flip the rendered page-aware orientation')
assertIncludes("orientation_source: isManualOrientationSource(block.orientation_source) ? 'manual' : block.orientation_source", 'facsimile persistence should preserve manual orientation source')
assertOcrIrIncludes("block.orientationSource === 'manual'", 'OCR IR consensus should not overwrite manual orientation choices')
assertDocumentViewIncludes('preferVerticalLayout={shouldUseVerticalOcr}', 'document view should pass guji vertical OCR preference into facsimile proofreader')
assertDocumentViewIncludes('function getNestedNumericRecordValue', 'document view should read nested OCR coordinate source sizes')
assertDocumentViewIncludes('const width = preserveServiceCoordinates', 'document view should keep explicit service coordinate sizes for preserved async PDF service coordinates')
assertDocumentViewIncludes("getNumericRecordValue(parsed, 'page_width')", 'document view should prefer the service page width for preserved async PDF service coordinates')
assertDocumentViewIncludes('preserveServiceCoordinates,', 'document view should still mark preserved async PDF service coordinates')
assertDocumentViewIncludes("?? getNumericRecordValue(irPage, 'width')", 'document view should fall back to OCR IR page width for non-preserved coordinate scaling')
assertDocumentViewIncludes("?? getNestedNumericRecordValue(parsed, ['normalization', 'page_width'])", 'document view should fall back to normalization page width for coordinate scaling')
if (documentViewSource.includes("return { width: null, height: null, preserveServiceCoordinates: true }")) {
  throw new Error('document view must not drop explicit service page sizes for preserved async PDF coordinates')
}
assertDocumentViewIncludes('function getOcrCoordinateSourceSize(ocrResult: unknown)', 'document view should derive coordinate source size from the OCR result being rendered')
assertDocumentViewIncludes('const imageCoordinateSourceSize = useMemo(', 'original image overlay should get its own coordinate source size')
assertDocumentViewIncludes('() => getOcrCoordinateSourceSize(proofingOcrResultObj || ocrResultObj)', 'original image overlay should use the proofing OCR result coordinate basis')
assertDocumentViewIncludes('const facsimileCoordinateSourceSize = useMemo(', 'facsimile renderer should get its own coordinate source size')
assertDocumentViewIncludes('() => getOcrCoordinateSourceSize(facsimileOcrResultObj)', 'facsimile renderer should use the actual facsimile OCR result coordinate basis')
assertDocumentViewIncludes('coordinateSourceSize={imageCoordinateSourceSize}', 'document view should pass image coordinate source size to the original image overlay')
assertDocumentViewIncludes('coordinateSourceSize={facsimileCoordinateSourceSize}', 'document view should pass facsimile coordinate source size to the facsimile renderer')
assertIncludes('function resolveCoordinateSourceSizeForImage', 'facsimile renderer should resolve OCR coordinates against the actual page image size')
assertIncludes('coordinateExtentFitsSize(coordinateExtent, pageImageNaturalSize)', 'facsimile renderer should prefer page image size when OCR coordinates already fit the image')
assertIncludes('return explicitSize || pageImageNaturalSize || coordinateSourceSize', 'facsimile renderer should keep explicit service page sizes before falling back to page-image size')
assertIncludes('if (fitsImage && fitsExplicit) return explicitSize', 'facsimile renderer should not replace explicit PDF-point page sizes with larger rendered page-image sizes')
assertOverlayProofreaderIncludes('coordinateSourceSize?: { width?: number | null; height?: number | null; preserveServiceCoordinates?: boolean }', 'overlay proofreader should accept OCR coordinate source size and a service-coordinate no-rescale marker')
assertOverlayProofreaderIncludes('interface CoordinateScale', 'overlay proofreader should compute a coordinate scaling model')
assertOverlayProofreaderIncludes('function scaleRect(rect: Rect, coordinateScale: CoordinateScale): Rect', 'overlay proofreader should scale OCR rectangles before rendering')
if (overlayProofreaderSource.includes('coordinateExtentFitsImage(coordinateExtent, imageWidth, imageHeight)')) {
  throw new Error('overlay proofreader must not infer coordinate basis from whether PDF-point coordinates happen to fit inside a larger page image')
}
if (overlayProofreaderSource.includes('if (coordinateSourceSize?.preserveServiceCoordinates)')) {
  throw new Error('overlay proofreader must not bypass display mapping solely because service coordinates were preserved')
}
assertOverlayProofreaderIncludes('const rect = sourceRect ? scaleRect(sourceRect, coordinateScale) : null', 'overlay proofreader should render boxes in the displayed page image coordinate basis')
assertImageViewerIncludes('coordinateSourceSize?: { width?: number | null; height?: number | null; preserveServiceCoordinates?: boolean }', 'image viewer should accept OCR coordinate source size and a service-coordinate no-rescale marker')
assertImageViewerIncludes('const boxCoordinateScale = useMemo<BoxCoordinateScale>', 'image viewer should compute a coordinate scaling model for original-image overlays')
if (imageViewerSource.includes('coordinateExtentFitsImage(coordinateExtent, imageWidth, imageHeight)')) {
  throw new Error('image viewer must not infer coordinate basis from whether PDF-point coordinates happen to fit inside a larger page image')
}
if (imageViewerSource.includes('if (coordinateSourceSize?.preserveServiceCoordinates) return { scaleX: 1, scaleY: 1 }')) {
  throw new Error('image viewer must not bypass display mapping solely because service coordinates were preserved')
}
assertImageViewerIncludes('const rect = getBoxRect(box, boxCoordinateScale)', 'image viewer should render original-image OCR boxes in the displayed page image coordinate basis')
assertDocumentViewIncludes("const shouldLoadSearchPages = documentMode === 'proof'", 'coordinate-aware proof search should load document-wide search pages without duplicating reader search payloads')
assertDocumentViewIncludes('readerSearchPages.map((page, fallbackIndex)', 'proof mode search should count hits across loaded document search pages')
assertDocumentViewIncludes('firstMatchAtOrAfterCurrentPage', 'proof mode search should start from the current page when full-document hits load')
assertDocumentViewIncludes('loadPagesAround(match.pageIndex, 5)', 'proof mode next/previous search navigation should preload the target page')

console.log('Facsimile stacked vertical block regression checks passed')
