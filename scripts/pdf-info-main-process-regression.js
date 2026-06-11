const fs = require('fs')
const path = require('path')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const root = path.join(__dirname, '..')
const rendererPdfSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'src', 'utils', 'pdf.ts'), 'utf8')
const mainPdfInfoSource = fs.readFileSync(path.join(root, 'src', 'main', 'pdf-info.ts'), 'utf8')
const preloadSource = fs.readFileSync(path.join(root, 'src', 'preload', 'index.ts'), 'utf8')
const documentsSource = fs.readFileSync(path.join(root, 'src', 'main', 'ipc', 'documents.ts'), 'utf8')

const getPdfFileInfoStart = rendererPdfSource.indexOf('export async function getPdfFileInfo')
assert(getPdfFileInfoStart >= 0, 'renderer getPdfFileInfo not found')
const getPdfFileInfoEnd = rendererPdfSource.indexOf('export async function renderPdfFilePageToImage', getPdfFileInfoStart)
assert(getPdfFileInfoEnd > getPdfFileInfoStart, 'renderer getPdfFileInfo end marker not found')
const getPdfFileInfoBody = rendererPdfSource.slice(getPdfFileInfoStart, getPdfFileInfoEnd)
const getCachedPdfDocumentStart = rendererPdfSource.indexOf('async function getCachedPdfDocument')
assert(getCachedPdfDocumentStart >= 0, 'renderer getCachedPdfDocument not found')
const getCachedPdfDocumentEnd = rendererPdfSource.indexOf('export function releaseCachedPdfDocument', getCachedPdfDocumentStart)
assert(getCachedPdfDocumentEnd > getCachedPdfDocumentStart, 'renderer getCachedPdfDocument end marker not found')
const getCachedPdfDocumentBody = rendererPdfSource.slice(getCachedPdfDocumentStart, getCachedPdfDocumentEnd)
const convertPdfFileToImagesStart = rendererPdfSource.indexOf('export async function convertPdfFileToImages')
assert(convertPdfFileToImagesStart >= 0, 'renderer convertPdfFileToImages not found')
const convertPdfFileToImagesEnd = rendererPdfSource.indexOf('export async function getPdfFileInfo', convertPdfFileToImagesStart)
assert(convertPdfFileToImagesEnd > convertPdfFileToImagesStart, 'renderer convertPdfFileToImages end marker not found')
const convertPdfFileToImagesBody = rendererPdfSource.slice(convertPdfFileToImagesStart, convertPdfFileToImagesEnd)

assert(
  getPdfFileInfoBody.includes('window.api.getPdfInfo(normalizedPath)'),
  'renderer PDF page count should use the main-process getPdfInfo API',
)
assert(
  !getPdfFileInfoBody.includes('readPdfFileBuffer('),
  'renderer PDF page count should not read the entire PDF into renderer memory',
)
assert(
  rendererPdfSource.includes('function toLocalResourceUrl'),
  'renderer should build local-resource URLs for file-path PDF rendering',
)
assert(
  getCachedPdfDocumentBody.includes('url: toLocalResourceUrl(cacheKey)'),
  'renderer cached PDF previews should load file paths through local-resource URLs',
)
assert(
  !getCachedPdfDocumentBody.includes('readPdfFileBuffer('),
  'renderer cached PDF previews should not read the entire PDF into renderer memory',
)
assert(
  convertPdfFileToImagesBody.includes('url: toLocalResourceUrl(filePath)'),
  'renderer file-path PDF conversion should load through local-resource URLs',
)
assert(
  !convertPdfFileToImagesBody.includes('readPdfFileBuffer(filePath)'),
  'renderer file-path PDF conversion should not read the entire PDF into renderer memory',
)
assert(
  mainPdfInfoSource.includes("'--show-npages'"),
  'main PDF info should use qpdf --show-npages as the fast path',
)
assert(
  mainPdfInfoSource.includes('PDFDocument.load'),
  'main PDF info should keep a pdf-lib fallback for PDFs qpdf cannot inspect',
)
assert(
  preloadSource.includes("getPdfInfo: (filePath: string)") && preloadSource.includes("ipcRenderer.invoke('documents:getPdfInfo', filePath)"),
  'preload should expose documents:getPdfInfo',
)
assert(
  documentsSource.includes("ipcMain.handle('documents:getPdfInfo'") && documentsSource.includes('assertAllowedLocalFilePath(filePath)'),
  'main documents IPC should validate local paths before reading PDF info',
)

console.log('PDF info main-process regression passed.')
