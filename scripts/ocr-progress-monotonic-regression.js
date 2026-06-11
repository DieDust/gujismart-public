const fs = require('fs')
const path = require('path')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const root = path.join(__dirname, '..')
const ocrSource = fs.readFileSync(path.join(root, 'src', 'main', 'ipc', 'ocr.ts'), 'utf8')
const documentStoreSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'src', 'stores', 'useDocumentStore.ts'), 'utf8')
const libraryViewSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'src', 'views', 'LibraryView.tsx'), 'utf8')

const directStatusSends = [...ocrSource.matchAll(/\.send\('ocr:statusChanged'/g)]
  .map((match) => match.index || 0)
const sendOcrStatusStart = ocrSource.indexOf('function sendOcrStatus')
const sendOcrStatusEnd = ocrSource.indexOf('function flushPendingOcrStatus', sendOcrStatusStart)
const emitOcrStatusStart = ocrSource.indexOf('function emitOcrStatus')
const emitOcrStatusEnd = ocrSource.indexOf('function getDocProgress', emitOcrStatusStart)

assert(emitOcrStatusStart >= 0 && emitOcrStatusEnd > emitOcrStatusStart, 'emitOcrStatus helper not found')
assert(sendOcrStatusStart >= 0 && sendOcrStatusEnd > sendOcrStatusStart, 'sendOcrStatus helper not found')
assert(
  directStatusSends.length === 1
    && directStatusSends[0] >= sendOcrStatusStart
    && directStatusSends[0] < sendOcrStatusEnd,
  'All OCR progress events must go through sendOcrStatus so throttling and destroyed-window checks stay centralized',
)
assert(
  ocrSource.includes('getMonotonicOcrStatusPayload(payload)'),
  'emitOcrStatus should normalize OCR progress before sending it to the renderer',
)
assert(
  ocrSource.includes('const OCR_STATUS_EVENT_THROTTLE_MS = 250')
    && ocrSource.includes('pendingOcrStatusEventsByDoc')
    && ocrSource.includes('flushPendingOcrStatus(docId)')
    && ocrSource.includes('isTerminalOcrProgressPayload(next)')
    && ocrSource.includes('setTimeout(() => {')
    && ocrSource.includes('Math.max(0, OCR_STATUS_EVENT_THROTTLE_MS - (now - lastSentAt))'),
  'active OCR progress events should be throttled while terminal progress events still flush immediately',
)
assert(
  documentStoreSource.includes('function hasDocumentPatchChange')
    && documentStoreSource.includes('Object.entries(patch).some')
    && documentStoreSource.includes('!hasDocumentPatchChange(document, data)')
    && documentStoreSource.includes('!hasDocumentPatchChange(document, patch)')
    && documentStoreSource.includes('return changed ? { documents } : state'),
  'OCR progress list patches should skip no-op document updates to avoid unnecessary LibraryView rerenders.',
)
assert(
  /function getOcrProgressPercent\(info: OcrProgressInfo\): number \{\s*if \(info\.completedPages !== undefined && \(info\.totalPages \|\| 0\) > 0\)/s.test(libraryViewSource),
  'Library OCR progress bars must use page counts whenever they are present, including 0 completed pages.',
)

console.log('OCR progress monotonic regression passed.')
