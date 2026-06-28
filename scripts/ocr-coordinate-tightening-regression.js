const fs = require('fs')
const path = require('path')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function sliceBetween(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker)
  assert(start >= 0, `${label} start marker not found`)
  const end = source.indexOf(endMarker, start + startMarker.length)
  assert(end > start, `${label} end marker not found`)
  return source.slice(start, end)
}

function readSource(filePath) {
  return fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n')
}

const root = path.resolve(__dirname, '..')
const ocrSource = readSource(path.join(root, 'src', 'main', 'ocr.ts'))
const ocrIpcSource = readSource(path.join(root, 'src', 'main', 'ipc', 'ocr.ts'))
const batchSource = readSource(path.join(root, 'src', 'main', 'batch-processor.ts'))
const ocrIrSource = readSource(path.join(root, 'src', 'shared', 'ocr-ir.ts'))
const documentViewSource = readSource(path.join(root, 'src', 'renderer', 'src', 'views', 'DocumentView.tsx'))
const imageViewerSource = readSource(path.join(root, 'src', 'renderer', 'src', 'components', 'ImageViewer.tsx'))
const overlayProofreaderSource = readSource(path.join(root, 'src', 'renderer', 'src', 'components', 'OverlayProofreader.tsx'))
const facsimileProofreaderSource = readSource(path.join(root, 'src', 'renderer', 'src', 'components', 'GujiFacsimileProofreader.tsx'))
const sourcePageReaderSource = readSource(path.join(root, 'src', 'renderer', 'src', 'components', 'SourcePageReader.tsx'))
const exportSource = readSource(path.join(root, 'src', 'main', 'export.ts'))
const pdfAssetsSource = readSource(path.join(root, 'src', 'main', 'pdf-assets.ts'))

const postProcessBody = sliceBetween(
  ocrSource,
  'export async function postProcessRecognizedPageResult',
  'export function normalizePageResult',
  'OCR post-processing',
)
const ipcPostProcessPdfBody = sliceBetween(
  ocrIpcSource,
  'async function postProcessPdfOcrResultsBatched',
  'async function recognizeSinglePage',
  'IPC async PDF result post-processing',
)
const batchPostProcessPdfBody = sliceBetween(
  batchSource,
  'private async postProcessPdfResultsBatched',
  'setMainWindow',
  'batch async PDF result post-processing',
)

assert(
  ocrSource.includes('export function tightenOcrTextCoordinatesToLocalInk')
    && ocrSource.includes('function isOverTightenedSmallTextBlock')
    && ocrSource.includes('source.height * 0.025')
    && ocrSource.includes("coordinate_source: 'local_ink_tightened'")
    && ocrSource.includes('ocr_coordinate_tightened_to_local_ink'),
  'OCR core should expose deterministic local-ink coordinate tightening with diagnostic metadata and keep page-number drift tightly bounded.',
)

assert(
  postProcessBody.includes('const workingResult = clampedInput')
    && postProcessBody.includes('const preserveServiceCoordinates = runtimeOptions.preserveServiceCoordinates === true')
    && ocrSource.includes('function markServiceCoordinatesPreserved')
    && ocrSource.includes('ocr_service_coordinates_preserved: true')
    && ocrSource.includes('service_coordinate_source')
    && postProcessBody.includes('const scaledInput = preserveServiceCoordinates')
    && postProcessBody.includes('const coordinateCorrectedInput = preserveServiceCoordinates')
    && postProcessBody.includes('const downgradedInput = preserveServiceCoordinates')
    && postProcessBody.includes('!preserveServiceCoordinates && runtimeOptions.tightenTextCoordinatesToLocalInk')
    && postProcessBody.indexOf('const workingResult = clampedInput') < postProcessBody.indexOf('!preserveServiceCoordinates && runtimeOptions.tightenTextCoordinatesToLocalInk')
    && postProcessBody.includes('if (preserveServiceCoordinates) {')
    && postProcessBody.indexOf('if (preserveServiceCoordinates) {') < postProcessBody.indexOf("if (resolved.secondPass === 'cloud_column_ocr')")
    && postProcessBody.includes('markServiceCoordinatesPreserved(attachProcessingMeta(serviceCoordinateResult, resolved, imagePath, {')
    && postProcessBody.includes('preserveServiceCoordinates: true')
    && postProcessBody.includes('attachProcessingMeta(isOcrResultPayload(coordinateTightenedInput)'),
  'OCR post-processing should only tighten coordinates when the caller explicitly enables it, and async PDF saves must return before any guji second-pass coordinate/layout rewriting.',
)

assert(
  ocrSource.includes('metaOptions: { preserveServiceCoordinates?: boolean } = {}')
    && ocrSource.includes('metaOptions.preserveServiceCoordinates ? getCoordinateSourceDimensions(result) : getImageDimensions(imagePath)')
    && ocrSource.includes("source_image_fingerprint: metaOptions.preserveServiceCoordinates ? '' : getImageFingerprint(imagePath)")
    && ocrSource.includes('const preserveServiceCoordinates = readRecordValue(gujiProcessing, \'ocr_service_coordinates_preserved\') === true')
    && ocrSource.includes('const dimensions = preserveServiceCoordinates ? undefined : getImageDimensions(imagePath)'),
  'Async PDF service-coordinate OCR must not overwrite the service coordinate basis with the local page-image dimensions during post-processing or read hydration.',
)

assert(
  ocrIpcSource.includes('function isServiceCoordinatePreservedResult(result: unknown): boolean')
    && ocrIpcSource.includes('if (isServiceCoordinatePreservedResult(result)) return {}')
    && ocrIpcSource.includes('const irSize = getStoredOcrIrSize(result, page?.image_path)')
    && ocrIpcSource.includes('pageWidth: irSize.width')
    && ocrIpcSource.includes('pageHeight: irSize.height'),
  'Saving async PDF service-coordinate OCR results must not rebuild OCR IR with local page-image dimensions.',
)

assert(
  ipcPostProcessPdfBody.includes('preserveServiceCoordinates: true')
    && batchPostProcessPdfBody.includes('preserveServiceCoordinates: true')
    && !ipcPostProcessPdfBody.includes('tightenTextCoordinatesToLocalInk: true')
    && !batchPostProcessPdfBody.includes('tightenTextCoordinatesToLocalInk: true'),
  'Both foreground and background async PDF OCR result saves should preserve service-returned coordinates instead of tightening them against the local page image.',
)

assert(
  ocrIrSource.includes('const preserveServiceCoordinates = gujiProcessing?.ocr_service_coordinates_preserved === true')
    && ocrIrSource.includes('|| (!preserveServiceCoordinates && gujiProcessing ? finiteNumber(gujiProcessing.source_image_width) : null)')
    && ocrIrSource.includes('|| (!preserveServiceCoordinates && gujiProcessing ? finiteNumber(gujiProcessing.source_image_height) : null)'),
  'OCR IR rebuilds must not resurrect stale guji_processing source-image dimensions for preserved async PDF service coordinates.',
)

assert(
  documentViewSource.includes('preserveServiceCoordinates?: boolean')
    && documentViewSource.includes("readRecordValue(gujiProcessing, 'ocr_service_coordinates_preserved') === true")
    && documentViewSource.includes('const width = preserveServiceCoordinates')
    && documentViewSource.includes("getNumericRecordValue(parsed, 'page_width')")
    && documentViewSource.includes('preserveServiceCoordinates,')
    && !documentViewSource.includes('return { width: null, height: null, preserveServiceCoordinates: true }')
    && !imageViewerSource.includes('if (coordinateSourceSize?.preserveServiceCoordinates) return { scaleX: 1, scaleY: 1 }')
    && !overlayProofreaderSource.includes('if (coordinateSourceSize?.preserveServiceCoordinates)')
    && facsimileProofreaderSource.includes('if (coordinateSourceSize?.preserveServiceCoordinates)')
    && sourcePageReaderSource.includes('const candidates = preserveServiceCoordinates')
    && sourcePageReaderSource.includes('{ width: parsed.page_width, height: parsed.page_height }'),
  'Renderer reads must preserve service-returned coordinates while still mapping them through the explicit service page size.',
)

assert(
  exportSource.includes('const preserveServiceCoordinates = parsed?.guji_processing?.ocr_service_coordinates_preserved === true')
    && exportSource.includes('const candidates = preserveServiceCoordinates')
    && exportSource.includes('{ width: parsed?.page_width, height: parsed?.page_height }')
    && !exportSource.includes('if (preserveServiceCoordinates) return fallback || null')
    && pdfAssetsSource.includes("getPathValue(parsed, ['guji_processing', 'ocr_service_coordinates_preserved']) === true")
    && pdfAssetsSource.includes('const candidates = preserveServiceCoordinates')
    && pdfAssetsSource.includes('{ width: parsed.page_width, height: parsed.page_height }')
    && !pdfAssetsSource.includes('if (preserveServiceCoordinates) return imageSize'),
  'Export and image-asset materialization must use the explicit service page size for preserved async PDF coordinates.',
)

assert(
  !ocrSource.includes('normalizeStoredOcrResultForRead(\n  result')
    || (
      !ocrSource.includes('const tightened = tightenOcrTextCoordinatesToLocalInk(result, imagePath)')
      && !ocrSource.includes('const coordinateCorrected = correctRotatedOcrCoordinatesForSourceImage(result, imagePath, options)')
      && !ocrSource.includes('const clamped = clampGujiOcrResultToSourceImage(pseudoTableDowngraded, imagePath)')
      && !ocrSource.includes('splitMergedWideVerticalTextLineBlocks(clamped, options)')
      && !ocrSource.includes('forceRebuild: true,\n  }) as OcrResultPayload')
    ),
  'Opening already stored OCR results should not silently move, clamp, rotate, split, or rebuild coordinates at read time.',
)

console.log('OCR coordinate tightening regression passed')
