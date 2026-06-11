const fs = require('fs')
const path = require('path')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const root = path.join(__dirname, '..')
const ocrSource = fs.readFileSync(path.join(root, 'src', 'main', 'ocr.ts'), 'utf8')
const ocrIpcSource = fs.readFileSync(path.join(root, 'src', 'main', 'ipc', 'ocr.ts'), 'utf8')
const librarySource = fs.readFileSync(path.join(root, 'src', 'renderer', 'src', 'views', 'LibraryView.tsx'), 'utf8')

assert(
  ocrSource.includes('ASYNC_RESULT_READY_GRACE_MS'),
  'Async PDF OCR should have a bounded grace period after all pages are reported complete',
)
assert(
  ocrSource.includes('if (allPagesCompleted && jsonUrl)'),
  'Async PDF OCR should accept a result URL when all pages are complete even if the status is not final',
)
assert(
  ocrSource.includes('结果文件长时间未生成'),
  'Async PDF OCR should fail with a retryable message instead of polling forever at 100%',
)
assert(
  ocrIpcSource.includes("phase: isAwaitingAsyncResult ? 'saving' : 'ocr'"),
  'OCR IPC progress should switch 100% async PDF polling into the saving/waiting phase',
)
assert(
  librarySource.includes("info.phase === 'saving' ? '停止等待' : '停止上传'"),
  'Library progress UI should not label the 100% result-waiting phase as upload',
)

console.log('OCR async PDF complete-pending regression passed.')
