const fs = require('fs')
const path = require('path')

const repoRoot = path.resolve(__dirname, '..')
const documentViewPath = path.join(repoRoot, 'src', 'renderer', 'src', 'views', 'DocumentView.tsx')
const sourcePageReaderPath = path.join(repoRoot, 'src', 'renderer', 'src', 'components', 'SourcePageReader.tsx')
const ebookReaderPath = path.join(repoRoot, 'src', 'renderer', 'src', 'components', 'EbookReader.tsx')

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8')
}

function assertIncludes(text, needle, message) {
  if (!text.includes(needle)) {
    throw new Error(`${message}\nMissing: ${needle}`)
  }
}

function assertNotIncludes(text, needle, message) {
  if (text.includes(needle)) {
    throw new Error(`${message}\nUnexpected: ${needle}`)
  }
}

function assertMatch(text, pattern, message) {
  if (!pattern.test(text)) {
    throw new Error(`${message}\nMissing pattern: ${pattern}`)
  }
}

const documentView = read(documentViewPath)
const sourcePageReader = read(sourcePageReaderPath)
const ebookReader = read(ebookReaderPath)

assertIncludes(
  documentView,
  "const READER_GLOBAL_PREFERENCES_SETTING_KEY = 'reader_global_preferences'",
  '阅读模式全局偏好必须保存到 settings 表，不能只存在组件状态里。',
)
assertIncludes(
  documentView,
  'window.api.getSetting(READER_GLOBAL_PREFERENCES_SETTING_KEY)',
  '进入文献页时必须读取全局阅读偏好。',
)
assertIncludes(
  documentView,
  'window.api.setSetting(READER_GLOBAL_PREFERENCES_SETTING_KEY, JSON.stringify(preferences))',
  '用户修改阅读样式后必须写回全局阅读偏好。',
)
assertIncludes(
  documentView,
  'latestReaderPreferencesRef',
  '切换文献或返回前必须保留最后一次阅读偏好，避免防抖保存被卸载打断。',
)
assertIncludes(
  documentView,
  'Failed to flush reader global preferences',
  '卸载阅读页时必须尝试立即落盘尚未保存的全局阅读偏好。',
)
assertIncludes(
  documentView,
  'const [readerViewMode, setReaderViewMode]',
  '普通阅读模式需要独立保存单页/双页偏好。',
)
assertIncludes(
  documentView,
  "const [documentMode, setDocumentMode] = useState<DocumentMode>('proof')",
  '没有历史阅读状态的新文献应默认进入校对/版式还原模式。',
)
assertIncludes(
  documentView,
  "const [proofViewMode, setProofViewMode] = useState<ProofViewMode>('facsimile')",
  '版式还原候选文献应默认显示版式还原视图。',
)
assertIncludes(
  documentView,
  "state.document_mode === 'read'",
  '已有用户阅读模式选择仍应优先于新的默认模式。',
)
assertIncludes(
  documentView,
  "tryRestoreDocumentMode('read')",
  '恢复阅读状态时应调用 tryRestoreDocumentMode(read)。',
)
assertIncludes(
  documentView,
  'if (documentModeTouchedRef.current) return false',
  '用户手动切换阅读/校对后，不应再被异步恢复覆盖。',
)
assertIncludes(
  documentView,
  "view_mode: readerViewMode",
  '保存文献阅读位置时必须使用当前阅读版式，不能硬编码双页。',
)
assertNotIncludes(
  documentView.replace("view_mode: 'spread',", ''),
  "view_mode: 'spread'",
  'DocumentView 不应再把普通阅读状态硬编码为双页。',
)
assertNotIncludes(
  documentView,
  'setReaderFontSize(state.font_size)',
  '每篇文献的 reader_state 不能覆盖全局字号偏好。',
)
assertNotIncludes(
  documentView,
  'setReaderLineHeight(state.line_height)',
  '每篇文献的 reader_state 不能覆盖全局行距偏好。',
)
assertNotIncludes(
  documentView,
  'setReaderTheme(state.theme)',
  '每篇文献的 reader_state 不能覆盖全局主题偏好。',
)
assertMatch(
  documentView,
  /const readerPages = \(readerViewMode === 'spread'\s*\?\s*\[readerCurrentPage, readerNextPage\]\s*:\s*\[readerCurrentPage\]\)\.filter\(Boolean\)/,
  '普通阅读模式应按单页/双页偏好决定渲染页数。',
)
assertIncludes(
  documentView,
  'value={readerViewMode}',
  '显示设置里的版式控件必须绑定全局 readerViewMode。',
)
assertIncludes(
  documentView,
  'setReaderViewMode(value as ReaderViewMode)',
  '显示设置里的版式控件必须能更新全局 readerViewMode。',
)
assertNotIncludes(
  sourcePageReader,
  'readingViewMode',
  '原文件/版式还原类阅读器不应被普通阅读模式全局偏好接管。',
)
assertIncludes(
  sourcePageReader,
  "const SOURCE_PAGE_READER_PREFERENCES_SETTING_KEY = 'source_page_reader_preferences'",
  'Source page reader must keep its own layout preferences instead of resetting to spread mode.',
)
assertIncludes(
  sourcePageReader,
  'window.api.getSetting(SOURCE_PAGE_READER_PREFERENCES_SETTING_KEY)',
  'Source page reader must load its independent layout preferences.',
)
assertIncludes(
  sourcePageReader,
  'window.api.setSetting(SOURCE_PAGE_READER_PREFERENCES_SETTING_KEY, JSON.stringify(preferences))',
  'Source page reader must save independent layout preference changes.',
)
assertIncludes(
  sourcePageReader,
  'latestSourceReaderPreferencesRef',
  'Source page reader must flush the last layout preference before mode switches unmount it.',
)
assertIncludes(
  sourcePageReader,
  'Failed to flush source page reader preferences',
  'Source page reader must attempt to flush pending preference saves on unmount.',
)
assertNotIncludes(
  sourcePageReader,
  'reader_global_preferences',
  'Source page reader must not share the ordinary text reader preference key.',
)
assertNotIncludes(
  ebookReader,
  'readingViewMode',
  '电子书/源文件阅读器保持自己的内部阅读体系，不应被本次普通阅读偏好改造接管。',
)

assertIncludes(
  sourcePageReader,
  "className={`source-reader-sidebar ${theme === 'dark' ? 'is-dark' : 'is-light'}`}",
  'Source reader empty states must expose the active light or dark sidebar theme for readable contrast.',
)
assertIncludes(
  ebookReader,
  'className="ebook-reader-sidebar"',
  'Ebook reader empty states must use the readable light-sidebar contrast treatment.',
)

console.log('reader-preferences regression checks passed')
