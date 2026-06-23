const fs = require('fs')
const path = require('path')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const root = path.join(__dirname, '..')
const rendererPdfSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'src', 'utils', 'pdf.ts'), 'utf8')
const fileAccessSource = fs.readFileSync(path.join(root, 'src', 'main', 'file-access.ts'), 'utf8')
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
  rendererPdfSource.includes("`local-resource://file/${encodeURIComponent(normalized)}`"),
  'renderer local-resource URLs should encode the whole normalized path under the file host',
)
assert(
  !rendererPdfSource.includes('encodeURI(pathname)'),
  'renderer local-resource URLs should not use path-style encodeURI because Windows drive colons can be lost',
)
assert(
  fileAccessSource.includes("if (urlObj.hostname === 'file')") && fileAccessSource.includes("decodeURIComponent(urlObj.pathname.replace(/^\\/+/, ''))"),
  'main local-resource parser should decode file-host URLs back to original Windows paths',
)
assert(
  fileAccessSource.includes("filePath[2] === ':'"),
  'main local-resource parser should keep compatibility with older path-style local-resource URLs',
)
assert(
  rendererPdfSource.includes('function isLocalResourceResponseError') && rendererPdfSource.includes('Unexpected server response \\(0\\)'),
  'renderer should detect Electron local-resource status-0 PDF.js failures',
)
assert(
  rendererPdfSource.includes('async function loadPdfDocumentFromFile') && rendererPdfSource.includes('url: toLocalResourceUrl(normalizedPath)'),
  'renderer cached PDF previews should try local-resource URLs first',
)
assert(
  rendererPdfSource.includes('data: await readPdfFileBuffer(normalizedPath)'),
  'renderer PDF previews should fall back to file-buffer loading when local-resource responses are reported as status 0',
)
assert(
  getCachedPdfDocumentBody.includes('loadPdfDocumentFromFile(cacheKey'),
  'renderer cached PDF previews should use the shared local-resource-with-fallback loader',
)
assert(
  convertPdfFileToImagesBody.includes('loadPdfDocumentFromFile(filePath'),
  'renderer file-path PDF conversion should use the same local-resource-with-fallback loader',
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
