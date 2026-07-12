const fs = require('fs')
const path = require('path')
const assert = require('assert')
const { buildSync } = require('esbuild')

const root = path.resolve(__dirname, '..')

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

function assertIncludes(source, needle, label) {
  if (!source.includes(needle)) throw new Error(`${label}: missing ${needle}`)
}

function assertNotIncludes(source, needle, label) {
  if (source.includes(needle)) throw new Error(`${label}: unexpected ${needle}`)
}

function sliceBetween(source, startNeedle, endNeedle, label) {
  const start = source.indexOf(startNeedle)
  if (start < 0) throw new Error(`${label}: missing start ${startNeedle}`)
  const end = source.indexOf(endNeedle, start + startNeedle.length)
  if (end < 0) throw new Error(`${label}: missing end ${endNeedle}`)
  return source.slice(start, end)
}

const documentsIpc = read('src/main/ipc/documents.ts')
const sharedTypes = read('src/shared/types.ts')
const documentView = read('src/renderer/src/views/DocumentView.tsx')

const documentUpdateHandler = sliceBetween(
  documentsIpc,
  "ipcMain.handle('documents:update'",
  "ipcMain.handle('documents:toggleFavorite'",
  'documents:update handler',
)
const initializePdfPagesHandler = sliceBetween(
  documentsIpc,
  "ipcMain.handle('documents:initializePdfPages'",
  "ipcMain.handle('documents:cachePageImage'",
  'documents:initializePdfPages handler',
)
const pageUpdateHandler = sliceBetween(
  documentsIpc,
  "ipcMain.handle('pages:update'",
  "ipcMain.handle('pages:resetOcr'",
  'pages:update handler',
)
const documentAllowedFields = sliceBetween(
  documentUpdateHandler,
  'const allowedFields:',
  'const sets:',
  'documents:update allowed fields',
)
const pageAllowedFields = sliceBetween(
  pageUpdateHandler,
  'const allowedFields:',
  'const sets:',
  'pages:update allowed fields',
)
const documentUpdateType = sliceBetween(
  sharedTypes,
  'export interface DocumentUpdatePayload',
  'export type LibraryDocumentSortKey',
  'DocumentUpdatePayload',
)
const pageUpdateType = sliceBetween(
  sharedTypes,
  'export interface PageUpdatePayload',
  'export interface DocumentPage',
  'PageUpdatePayload',
)
const initializePdfPagesType = sliceBetween(
  sharedTypes,
  'export interface InitializePdfPagesOptions',
  'export interface PdfInfoResult',
  'InitializePdfPagesOptions',
)

assertIncludes(documentUpdateHandler, "rejectProtectedPathFields(data, ['file_path', 'thumb_path'])", 'documents:update runtime guard')
assertNotIncludes(documentAllowedFields, "'file_path'", 'documents:update allowed fields')
assertNotIncludes(documentAllowedFields, "'thumb_path'", 'documents:update allowed fields')
assertIncludes(documentAllowedFields, "'metadata'", 'documents:update metadata compatibility')
assertNotIncludes(documentUpdateType, "| 'file_path'", 'DocumentUpdatePayload')
assertNotIncludes(documentUpdateType, "| 'thumb_path'", 'DocumentUpdatePayload')

assertIncludes(pageUpdateHandler, "rejectProtectedPathFields(data, ['image_path'])", 'pages:update runtime guard')
assertNotIncludes(pageUpdateHandler, "normalizedData.image_path", 'pages:update OCR normalization')
assertNotIncludes(pageAllowedFields, "'image_path'", 'pages:update allowed fields')
assertIncludes(pageAllowedFields, "'ocr_result'", 'pages:update OCR compatibility')
assertIncludes(pageAllowedFields, "'proofed_text'", 'pages:update proof compatibility')
assertNotIncludes(pageUpdateType, "| 'image_path'", 'PageUpdatePayload')

assertIncludes(initializePdfPagesHandler, "rejectProtectedPathFields(options, ['thumbPath'])", 'initializePdfPages runtime guard')
assertNotIncludes(initializePdfPagesHandler, 'options?.thumbPath', 'initializePdfPages path write')
assertNotIncludes(initializePdfPagesType, 'thumbPath?:', 'InitializePdfPagesOptions')

const redundantPagePathWrites = documentView.match(/window\.api\.updatePage\([^\n]+\{ image_path: imagePath \}\)/g) || []
if (redundantPagePathWrites.length > 0) {
  throw new Error(`DocumentView still contains ${redundantPagePathWrites.length} renderer-controlled image_path writes`)
}

async function runBehaviorRegression() {
  let tempRoot = ''
  let database
  try {
    tempRoot = fs.mkdtempSync(path.join(__dirname, '.tmp-path-mutation-'))
    const tempDataDir = path.join(tempRoot, 'data')
    const bundlePath = path.join(tempRoot, 'path-mutation-bundle.cjs')
    const entryPath = path.join(tempRoot, 'path-mutation-entry.js')
    const electronStubPath = path.join(tempRoot, 'electron-stub.js')
    process.env.GUJISMART_DATA_DIR = tempDataDir
    process.env.GUJISMART_AUTO_REINDEX = '0'

  fs.writeFileSync(electronStubPath, `
    const handlers = new Map()
    const emptyImage = {
      isEmpty: () => true,
      getSize: () => ({ width: 0, height: 0 }),
      toBitmap: () => Buffer.alloc(0),
      toJPEG: () => Buffer.alloc(0),
      resize: () => emptyImage,
      crop: () => emptyImage,
    }
    exports.__handlers = handlers
    exports.ipcMain = {
      handle(channel, handler) {
        handlers.set(channel, handler)
      },
    }
    exports.app = {
      getName: () => 'gujismart-test',
      getPath: () => ${JSON.stringify(tempRoot)},
      getVersion: () => '0.0.0-test',
      isPackaged: false,
    }
    exports.dialog = {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    }
    exports.BrowserWindow = class BrowserWindow {
      static getAllWindows() { return [] }
    }
    exports.nativeImage = {
      createFromPath: () => emptyImage,
      createFromBuffer: () => emptyImage,
    }
  `)

  fs.writeFileSync(entryPath, `
    const database = require(${JSON.stringify(path.join(root, 'src', 'main', 'database.ts'))})
    const documents = require(${JSON.stringify(path.join(root, 'src', 'main', 'ipc', 'documents.ts'))})
    const electron = require('electron')
    module.exports = { database, documents, handlers: electron.__handlers }
  `)

  buildSync({
    entryPoints: [entryPath],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundlePath,
    external: ['better-sqlite3', '@napi-rs/canvas'],
    alias: {
      electron: electronStubPath,
      '@electron-toolkit/utils': path.join(__dirname, 'stubs', 'electron-toolkit-utils.js'),
    },
    logLevel: 'silent',
  })

    const modules = require(bundlePath)
    database = modules.database
    await database.initDatabase()
    modules.documents.registerDocumentIpc()

    const invoke = async (channel, ...args) => {
      const handler = modules.handlers.get(channel)
      if (!handler) throw new Error(`Missing document IPC handler: ${channel}`)
      return handler({}, ...args)
    }

    const now = new Date().toISOString()
    const docId = 'fixture1'
    const pageId = 'page1'
    const originalMetadata = JSON.stringify({ source: 'fixture' })
    database.run(
      `INSERT INTO documents (
        id, title, author, dynasty, source, doc_type, file_path, thumb_path, page_count,
        ocr_status, proof_status, import_status, metadata_status, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        docId,
        '原始标题',
        '原始作者',
        null,
        '回归测试',
        '古籍',
        null,
        null,
        1,
        'pending',
        'pending',
        'stored',
        'pending',
        originalMetadata,
        now,
        now,
      ],
    )
    database.run(
      'INSERT INTO pages (id, doc_id, page_num, image_path, ocr_text, ocr_result, proofed_text, ocr_status, proof_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [pageId, docId, 1, null, '原始识别文本', null, '原始校对文本', 'pending', 'pending', now],
    )

    const externalDocumentPath = path.join(tempRoot, 'outside.pdf')
    const externalThumbPath = path.join(tempRoot, 'outside-thumb.jpg')
    const externalPagePath = path.join(tempRoot, 'outside-page.jpg')

    await assert.rejects(
      () => invoke('documents:update', docId, { file_path: externalDocumentPath }),
      /受保护路径字段/,
    )
    await assert.rejects(
      () => invoke('documents:update', docId, { title: '不应写入的标题', thumb_path: externalThumbPath }),
      /受保护路径字段/,
    )
    let documentRow = database.queryOne('SELECT title, file_path, thumb_path, metadata, page_count FROM documents WHERE id = ?', [docId])
    assert.deepStrictEqual(
      { title: documentRow.title, filePath: documentRow.file_path, thumbPath: documentRow.thumb_path, metadata: documentRow.metadata, pageCount: documentRow.page_count },
      { title: '原始标题', filePath: null, thumbPath: null, metadata: originalMetadata, pageCount: 1 },
      'documents:update must reject protected-only and mixed payloads before mutation',
    )

    await assert.rejects(
      () => invoke('pages:update', pageId, { image_path: externalPagePath }),
      /受保护路径字段/,
    )
    await assert.rejects(
      () => invoke('pages:update', pageId, { ocr_text: '不应写入的识别文本', image_path: externalPagePath }),
      /受保护路径字段/,
    )
    let pageRow = database.queryOne('SELECT image_path, ocr_text, proofed_text, ocr_status, proof_status FROM pages WHERE id = ?', [pageId])
    assert.deepStrictEqual(
      pageRow,
      { image_path: null, ocr_text: '原始识别文本', proofed_text: '原始校对文本', ocr_status: 'pending', proof_status: 'pending' },
      'pages:update must reject protected-only and mixed payloads before mutation',
    )

    await assert.rejects(
      () => invoke('documents:initializePdfPages', docId, 3, { thumbPath: externalThumbPath }),
      /受保护路径字段/,
    )
    await assert.rejects(
      () => invoke('documents:initializePdfPages', docId, 3, { title: '不应初始化的标题', thumbPath: externalThumbPath }),
      /受保护路径字段/,
    )
    documentRow = database.queryOne('SELECT title, thumb_path, page_count FROM documents WHERE id = ?', [docId])
    assert.deepStrictEqual(
      documentRow,
      { title: '原始标题', thumb_path: null, page_count: 1 },
      'documents:initializePdfPages must reject protected-only and mixed options before document mutation',
    )
    assert.strictEqual(
      database.queryOne('SELECT COUNT(*) as count FROM pages WHERE doc_id = ?', [docId]).count,
      1,
      'rejected PDF initialization must not insert page rows',
    )

    const legalMetadata = JSON.stringify({ source: 'fixture', verified: true })
    assert.strictEqual(
      await invoke('documents:update', docId, { title: '合法标题更新', metadata: legalMetadata }),
      true,
    )
    documentRow = database.queryOne('SELECT title, metadata FROM documents WHERE id = ?', [docId])
    assert.deepStrictEqual(documentRow, { title: '合法标题更新', metadata: legalMetadata })

    assert.strictEqual(
      await invoke('pages:update', pageId, {
        ocr_text: '合法识别文本',
        proofed_text: '合法校对文本',
        ocr_status: 'completed',
        proof_status: 'completed',
      }),
      true,
    )
    pageRow = database.queryOne('SELECT image_path, ocr_text, proofed_text, ocr_status, proof_status FROM pages WHERE id = ?', [pageId])
    assert.deepStrictEqual(
      pageRow,
      { image_path: null, ocr_text: '合法识别文本', proofed_text: '合法校对文本', ocr_status: 'completed', proof_status: 'completed' },
    )

    assert.strictEqual(
      await invoke('documents:initializePdfPages', docId, 3, { title: '合法 PDF 标题' }),
      true,
    )
    documentRow = database.queryOne('SELECT title, thumb_path, page_count FROM documents WHERE id = ?', [docId])
    assert.deepStrictEqual(documentRow, { title: '合法 PDF 标题', thumb_path: null, page_count: 3 })
    assert.strictEqual(database.queryOne('SELECT COUNT(*) as count FROM pages WHERE doc_id = ?', [docId]).count, 3)
  } finally {
    try {
      database?.closeDatabase?.()
    } catch {
      // Ignore cleanup failures after assertions.
    }
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

runBehaviorRegression()
  .then(() => {
    console.log('Protected document/page path mutation contract and behavior checks passed')
    process.exit(0)
  })
  .catch((error) => {
    console.error('Protected document/page path mutation regression failed')
    console.error(error)
    process.exit(1)
  })
