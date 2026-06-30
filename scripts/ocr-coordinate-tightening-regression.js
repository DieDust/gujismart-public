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
const documentsIpcSource = readSource(path.join(root, 'src', 'main', 'ipc', 'documents.ts'))
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
const alignServiceCoordinatesBody = sliceBetween(
  ocrSource,
  'function alignServiceCoordinatesToLocalImage',
  'function locationToCornerPoints',
  'async PDF service-coordinate alignment',
)
const normalizePageResultBody = sliceBetween(
  ocrSource,
  'export function normalizePageResult',
  'interface SyncRecognitionOptions',
  'OCR page result normalization',
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
const pagesUpdateBody = sliceBetween(
  documentsIpcSource,
  "ipcMain.handle('pages:update'",
  "ipcMain.handle('pages:resetOcr'",
  'page update OCR save',
)
const pagesResetBody = sliceBetween(
  documentsIpcSource,
  "ipcMain.handle('pages:resetOcr'",
  "ipcMain.handle('pages:listOcrVersions'",
  'page OCR reset',
)
const pagesSwitchVersionBody = sliceBetween(
  documentsIpcSource,
  "ipcMain.handle('pages:switchOcrVersion'",
  '\n}\n',
  'page OCR version switch',
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
    && ocrSource.includes('function alignServiceCoordinatesToLocalImage')
    && ocrSource.includes('service_coordinates_aligned_to_local_image')
    && ocrSource.includes("service_coordinate_size_source: 'local_page_image'")
    && postProcessBody.includes('const scaledInput = preserveServiceCoordinates')
    && postProcessBody.includes('const coordinateCorrectedInput = preserveServiceCoordinates')
    && postProcessBody.includes('const downgradedInput = preserveServiceCoordinates')
    && postProcessBody.includes('!preserveServiceCoordinates && runtimeOptions.tightenTextCoordinatesToLocalInk')
    && postProcessBody.indexOf('const workingResult = clampedInput') < postProcessBody.indexOf('!preserveServiceCoordinates && runtimeOptions.tightenTextCoordinatesToLocalInk')
    && postProcessBody.includes('if (preserveServiceCoordinates) {')
    && postProcessBody.indexOf('if (preserveServiceCoordinates) {') < postProcessBody.indexOf("if (resolved.secondPass === 'cloud_column_ocr')")
    && postProcessBody.includes('const preserved = markServiceCoordinatesPreserved(attachProcessingMeta(serviceCoordinateWithFallback, resolved, imagePath, {')
    && postProcessBody.includes('preserveServiceCoordinates: true')
    && postProcessBody.includes('alignServiceCoordinatesToLocalImage(preserved, imagePath)')
    && postProcessBody.includes('attachProcessingMeta(isOcrResultPayload(coordinateTightenedInput)'),
  'OCR post-processing should keep page-image OCR tightening opt-in while aligning async PDF service coordinates to the local page image before saving.',
)

assert(
  alignServiceCoordinatesBody.includes('const shouldScale = Math.abs(scaleX - 1) > 0.002 || Math.abs(scaleY - 1) > 0.002')
    && alignServiceCoordinatesBody.includes('const scaled = shouldScale ? scaleOcrResultCoordinates(result, scaleX, scaleY) : result')
    && alignServiceCoordinatesBody.includes('page_width: localImageSize.width')
    && alignServiceCoordinatesBody.includes('page_height: localImageSize.height')
    && alignServiceCoordinatesBody.includes('image_width: localImageSize.width')
    && alignServiceCoordinatesBody.includes('image_height: localImageSize.height')
    && alignServiceCoordinatesBody.includes('return alignedBase')
    && !alignServiceCoordinatesBody.includes('tightenOcrTextCoordinatesToLocalInk'),
  'Async PDF service-coordinate alignment should only scale between service and local image sizes, never run local ink tightening that moves PaddleOCR boxes.',
)

assert(
  normalizePageResultBody.includes('const servicePageWidth = positiveNumber')
    && normalizePageResultBody.includes("firstRecordValue(sourcePruned, ['page_width', 'image_width', 'width', 'source_image_width'])")
    && normalizePageResultBody.includes('const servicePageHeight = positiveNumber')
    && normalizePageResultBody.includes('const servicePageSize = servicePageWidth && servicePageHeight')
    && normalizePageResultBody.includes('page_width: servicePageWidth')
    && normalizePageResultBody.includes('page_height: servicePageHeight')
    && normalizePageResultBody.includes('image_width: servicePageWidth')
    && normalizePageResultBody.includes('image_height: servicePageHeight')
    && normalizePageResultBody.includes('...servicePageSize'),
  'PaddleOCR async PDF normalization should preserve prunedResult width/height as the service coordinate page size.',
)

assert(
  ocrSource.includes('metaOptions: { preserveServiceCoordinates?: boolean } = {}')
    && ocrSource.includes('metaOptions.preserveServiceCoordinates ? getCoordinateSourceDimensions(result) : getImageDimensions(imagePath)')
    && ocrSource.includes("source_image_fingerprint: metaOptions.preserveServiceCoordinates ? '' : getImageFingerprint(imagePath)")
    && ocrSource.includes('const preserveServiceCoordinates = readRecordValue(gujiProcessing, \'ocr_service_coordinates_preserved\') === true')
    && ocrSource.includes('const dimensions = preserveServiceCoordinates ? undefined : getImageDimensions(imagePath)')
    && ocrSource.includes('const coordinateAligned = preserveServiceCoordinates')
    && ocrSource.includes('? alignServiceCoordinatesToLocalImage(result, imagePath)')
    && ocrSource.includes('forceRebuild: coordinateAligned !== result'),
  'Async PDF service-coordinate OCR should preserve the service-origin marker, then repair legacy reads onto the local page-image coordinate basis and rebuild IR only when coordinates changed.',
)

assert(
  ocrIpcSource.includes('function isServiceCoordinatePreservedResult(result: unknown): boolean')
    && ocrIpcSource.includes('const irSize = getStoredOcrIrSize(sizeNormalizedResult, page?.image_path)')
    && ocrIpcSource.includes('pageWidth: irSize.width')
    && ocrIpcSource.includes('pageHeight: irSize.height')
    && ocrIpcSource.includes('function ensureServiceCoordinatePageSizeForStorage')
    && ocrIpcSource.includes("service_coordinate_size_source: gujiProcessing.service_coordinate_size_source || 'page_image_fallback'"),
  'Saving async PDF service-coordinate OCR results should store an explicit coordinate size for IR instead of falling back to coordinate extents.',
)

assert(
  ipcPostProcessPdfBody.includes('preserveServiceCoordinates: true')
    && batchPostProcessPdfBody.includes('preserveServiceCoordinates: true')
    && ipcPostProcessPdfBody.includes('serviceCoordinateFallbackSize: getPageImageSize(item.page.image_path)')
    && batchPostProcessPdfBody.includes('serviceCoordinateFallbackSize: getPageImageSize(item.page.image_path)')
    && !ipcPostProcessPdfBody.includes('ensurePageImageForOcrFallback(item.page')
    && !ipcPostProcessPdfBody.includes('tightenTextCoordinatesToLocalInk: true')
    && !batchPostProcessPdfBody.includes('tightenTextCoordinatesToLocalInk: true'),
  'Both foreground and background async PDF OCR result saves should preserve service provenance while using existing page-image fallback sizes when available.',
)

assert(
  ocrIrSource.includes('const preserveServiceCoordinates = gujiProcessing?.ocr_service_coordinates_preserved === true')
    && ocrIrSource.includes('const localImageAlignedServiceCoordinates = preserveServiceCoordinates')
    && ocrIrSource.includes("gujiProcessing?.service_coordinate_size_source === 'local_page_image'")
    && ocrIrSource.includes('service_coordinates_aligned_to_local_image')
    && ocrIrSource.includes('|| ((!preserveServiceCoordinates || localImageAlignedServiceCoordinates) && gujiProcessing ? finiteNumber(gujiProcessing.source_image_width) : null)')
    && ocrIrSource.includes('|| ((!preserveServiceCoordinates || localImageAlignedServiceCoordinates) && gujiProcessing ? finiteNumber(gujiProcessing.source_image_height) : null)'),
  'OCR IR rebuilds should trust guji_processing source-image dimensions after preserved async PDF coordinates have been aligned to the local page image.',
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
  ocrSource.includes('export function normalizeStoredOcrResultForRead')
    && ocrSource.includes('const coordinateAligned = preserveServiceCoordinates')
    && ocrSource.includes('? alignServiceCoordinatesToLocalImage(result, imagePath)')
    && !ocrSource.includes('const coordinateCorrected = correctRotatedOcrCoordinatesForSourceImage(result, imagePath, options)')
    && !ocrSource.includes('const clamped = clampGujiOcrResultToSourceImage(pseudoTableDowngraded, imagePath)')
    && !ocrSource.includes('splitMergedWideVerticalTextLineBlocks(clamped, options)'),
  'Opening stored OCR results may run the idempotent async-PDF coordinate alignment repair, but must not rerun broader layout rewrites at read time.',
)

assert(
  documentsIpcSource.includes('normalizeStoredGujiOcrResultForRead')
    && pagesUpdateBody.includes('normalizeStoredGujiOcrResultForRead(normalizedData.ocr_result, imagePath, pageIndex)')
    && pagesUpdateBody.includes('forceRebuild: true')
    && pagesResetBody.includes('normalizeStoredGujiOcrResultForRead(ocrResult, page.image_path, pageIndex)')
    && pagesSwitchVersionBody.includes('normalizeStoredGujiOcrResultForRead(hydratedVersion.ocr_result, page.image_path, pageIndex)'),
  'Page update, reset, and OCR-version switch saves should normalize stored OCR coordinates before rebuilding IR so legacy async-PDF offsets are not persisted again.',
)

console.log('OCR coordinate tightening regression passed')
