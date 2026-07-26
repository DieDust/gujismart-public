const fs = require('fs')
const path = require('path')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const root = path.join(__dirname, '..')
const documentsPath = path.join(root, 'src', 'main', 'ipc', 'documents.ts')
const ocrPath = path.join(root, 'src', 'main', 'ipc', 'ocr.ts')
const pdfAssetsPath = path.join(root, 'src', 'main', 'pdf-assets.ts')
const preloadPath = path.join(root, 'src', 'preload', 'index.ts')
const libraryPath = path.join(root, 'src', 'renderer', 'src', 'views', 'LibraryView.tsx')
const sharedTypesPath = path.join(root, 'src', 'shared', 'types.ts')
const documentsSource = fs.readFileSync(documentsPath, 'utf8')
const ocrSource = fs.readFileSync(ocrPath, 'utf8')
const pdfAssetsSource = fs.readFileSync(pdfAssetsPath, 'utf8')
const preloadSource = fs.readFileSync(preloadPath, 'utf8')
const librarySource = fs.readFileSync(libraryPath, 'utf8')
const sharedTypesSource = fs.readFileSync(sharedTypesPath, 'utf8')

const importHandlerStart = documentsSource.indexOf("ipcMain.handle('documents:import'")
assert(importHandlerStart >= 0, 'documents:import handler not found')
const importHandlerEnd = documentsSource.indexOf("ipcMain.handle('documents:list'", importHandlerStart)
assert(importHandlerEnd > importHandlerStart, 'documents:import handler end marker not found')
const importHandler = documentsSource.slice(importHandlerStart, importHandlerEnd)

assert(
  !importHandler.includes('storePdfWithCompression('),
  'PDF import must not run storePdfWithCompression before the document row is inserted',
)
assert(
  importHandler.includes('await copyFileWithFingerprintAsync(filePath, destPath, pdfFingerprint || undefined'),
  'PDF import should copy the source and compute its fingerprint in one streaming pass for new PDFs',
)
assert(
  importHandler.includes('json_extract(metadata, \'$.pdf_size_bytes\') = ?')
    && importHandler.includes('json_extract(metadata, \'$.pdf_original_size_bytes\') = ?')
    && importHandler.includes('pdfFingerprint = await getPdfFingerprintAsync(filePath'),
  'PDF import should only pre-hash the source when a same-size PDF could be a duplicate',
)
assert(
  importHandler.includes('await copyFileWithFingerprintAsync(filePath, destPath, pdfFingerprint || undefined'),
  'PDF import should reuse a precomputed duplicate-check fingerprint instead of hashing again while copying',
)
assert(
  importHandler.includes('await restorePdfAssetForDocumentAsync(existing.id, filePath, pdfFingerprint)'),
  'Duplicate PDF restore during import should be async and reuse the already computed source fingerprint',
)
assert(
  importHandler.includes('let pdfDuplicateChecked = false')
    && importHandler.includes('if (!pdfDuplicateChecked)')
    && importHandler.includes('await rm(destDir, { recursive: true, force: true })'),
  'PDF import should still fall back to SHA duplicate detection after copying for older library records without size metadata',
)
assert(
  !importHandler.includes('getPdfFingerprint(filePath)')
    && !importHandler.includes('getPdfFingerprint(destPath)')
    && !importHandler.includes('getPdfFingerprint(destPath)')
    && !importHandler.includes('getPdfFingerprintAsync(destPath)'),
  'PDF import should not hash stored PDFs in a separate pass',
)
const fileBranchStart = importHandler.indexOf('const isImageFile = IMAGE_IMPORT_EXTENSIONS.has(ext)')
assert(fileBranchStart >= 0, 'generic file import branch not found')
const fileBranch = importHandler.slice(fileBranchStart)
assert(
  fileBranch.includes("reason: pdfCompressionSettings.enabled ? 'manual_only_before_ocr' : 'disabled'"),
  'PDF import should record that compression is not blocking OCR upload',
)
assert(
  fileBranch.includes('if (!copiedPdf)')
    && fileBranch.includes('await copyFile(filePath, destPath)')
    && fileBranch.includes('INSERT INTO documents'),
  'Non-PDF imports should still copy normally while PDFs reuse the streamed copy',
)
assert(
  !fileBranch.includes('getPdfFingerprint(destPath)'),
  'PDF import should reuse the source hash after copying instead of hashing the stored copy again',
)
const projectScopedDuplicateHashLookup = importHandler.indexOf("json_extract(metadata, '$.pdf_sha256') = ?")
assert(
  importHandler.indexOf('pdfFingerprint = await getPdfFingerprintAsync(filePath') < projectScopedDuplicateHashLookup
    && projectScopedDuplicateHashLookup < importHandler.indexOf('await copyFileWithFingerprintAsync(filePath, destPath, pdfFingerprint || undefined')
    && importHandler.includes('WHERE library_project_id = ?'),
  'PDF duplicate lookup should happen before copying into the library when a same-size candidate exists',
)
assert(
  sharedTypesSource.includes('export interface ImportProgressEvent')
    && preloadSource.includes('onImportProgress: (callback: (data: ImportProgressEvent) => void): IpcUnsubscribe')
    && preloadSource.includes("ipcRenderer.on('documents:importProgress'")
    && librarySource.includes('window.api.onImportProgress')
    && librarySource.includes("event.phase === 'hashing' ? '正在校验' : '正在复制'")
    && librarySource.includes('setImportProgressText(content)')
    && documentsSource.includes('ImportProgressEvent')
    && documentsSource.includes('function sendImportProgress')
    && documentsSource.includes("sender.send('documents:importProgress'")
    && importHandler.includes('sendImportProgress(event.sender')
    && importHandler.includes("phase: 'hashing'")
    && importHandler.includes("phase: 'copying'")
    && importHandler.includes('bytesDone')
    && importHandler.includes('totalBytes')
    && importHandler.includes('progress: totalBytes > 0 ? bytesDone / totalBytes : undefined'),
  'PDF import should stream copy/hash progress to the renderer so large files do not look stuck.',
)
assert(
  pdfAssetsSource.includes('export type CopyFileProgress')
    && pdfAssetsSource.includes('const HASH_CHUNK_BYTES = 8 * 1024 * 1024')
    && pdfAssetsSource.includes('onProgress?: (progress: CopyFileProgress) => void')
    && pdfAssetsSource.includes('hashFileAsync(filePath: string, onProgress?: (progress: CopyFileProgress) => void')
    && pdfAssetsSource.includes('getPdfFingerprintAsync(filePath: string, onProgress?: (progress: CopyFileProgress) => void')
    && pdfAssetsSource.includes('bytesDone += bytesRead')
    && pdfAssetsSource.includes('now - lastProgressAt < 250')
    && pdfAssetsSource.includes('bytesDone - lastProgressBytes < 32 * 1024 * 1024'),
  'PDF copy progress should be emitted from the streaming copy loop and throttled to avoid UI event spam.',
)
assert(
  !ocrSource.includes('ensureStoredPdfCompressedForUpload('),
  'OCR must not compress stored PDFs before async upload/chunking',
)
assert(
  importHandler.includes(".filter((result) => result.success && (result.sourceType === 'paddle-json' || result.sourceType === 'ebook-text'))")
    && importHandler.includes('markSearchIndexStaleForDocuments(changedDocIds)')
    && !importHandler.includes("markSearchIndexStaleForDocuments([id])\n          notifySearchContentChanged()\n          results.push({ id, title: parsedEbook.title || title, success: true"),
  'PDF/image imports should not queue empty search indexing before OCR, while text-ready JSON/ebook imports still do.',
)

console.log('PDF import non-blocking compression regression passed.')
