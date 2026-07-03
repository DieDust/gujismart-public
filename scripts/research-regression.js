const assert = require('assert')
const { createHash } = require('crypto')
const { mkdtempSync, rmSync, writeFileSync } = require('fs')
const { join } = require('path')
const { buildSync } = require('esbuild')

const tempRoot = mkdtempSync(join(__dirname, '.tmp-research-'))
const tempDataDir = join(tempRoot, 'data')
const bundlePath = join(tempRoot, 'research-regression-bundle.cjs')
const entryPath = join(tempRoot, 'research-regression-entry.js')
const electronStubPath = join(tempRoot, 'electron-stub.js')

process.env.GUJISMART_DATA_DIR = tempDataDir

writeFileSync(electronStubPath, `
  const handlers = new Map()
  exports.__handlers = handlers
  exports.ipcMain = {
    handle(channel, handler) {
      handlers.set(channel, handler)
    }
  }
  exports.app = {
    getName: () => 'gujismart-test',
    getPath: () => ${JSON.stringify(tempRoot)}
  }
`)

writeFileSync(entryPath, `
  const database = require(${JSON.stringify(join(__dirname, '..', 'src', 'main', 'database.ts'))})
  const research = require(${JSON.stringify(join(__dirname, '..', 'src', 'main', 'ipc', 'research.ts'))})
  const electron = require('electron')
  module.exports = { database, research, handlers: electron.__handlers }
`)

buildSync({
  entryPoints: [entryPath],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: bundlePath,
  external: ['better-sqlite3'],
  alias: {
    electron: electronStubPath,
    '@electron-toolkit/utils': join(__dirname, 'stubs', 'electron-toolkit-utils.js'),
  },
  logLevel: 'silent',
})

async function run() {
  let database
  try {
    const modules = require(bundlePath)
    database = modules.database
    await database.initDatabase()
    modules.research.registerResearchIpc()

    const invoke = async (channel, ...args) => {
      const handler = modules.handlers.get(channel)
      if (!handler) throw new Error(`Missing research IPC handler: ${channel}`)
      return handler({}, ...args)
    }

    const now = new Date().toISOString()
    const fixtureDocId = 'doc_rx'
    database.run(
      `INSERT INTO documents (
        id, title, author, dynasty, source, doc_type, file_path, thumb_path, page_count,
        ocr_status, proof_status, import_status, metadata_status, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        fixtureDocId,
        '古籍智理测试文献',
        '张三',
        null,
        '测试集',
        '古籍',
        null,
        null,
        1,
        'completed',
        'pending',
        'processed',
        'confirmed',
        JSON.stringify({ year: '1901', publisher: '测试书局' }),
        now,
        now,
      ],
    )
    database.run(
      'INSERT INTO pages (id, doc_id, page_num, image_path, ocr_text, proofed_text, ocr_status, proof_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['page_research_1', fixtureDocId, 1, null, '第一段材料可作为摘录证据。', null, 'completed', 'pending', now],
    )

    const project = await invoke('research:createProject', {
      name: '摘录到写作回归',
      description: '覆盖项目、大纲、摘录和导出',
    })
    assert.ok(project?.id)

    const outline = await invoke('research:createOutlineItem', {
      project_id: project.id,
      title: '第一章',
      description: '材料整理',
      sort_order: 10,
    })
    assert.ok(outline?.id)

    const note = await invoke('research:createNote', {
      project_id: project.id,
      doc_id: fixtureDocId,
      page_num: 1,
      excerpt: '第一段材料可作为摘录证据。',
      note: '用于论证资料来源',
      tags: ['证据', '回归'],
      source_type: 'manual',
      kind: 'quote',
      outline_id: outline.id,
      locator: { pageNum: 1, block: 'p1' },
      citation_text: '张三：《古籍智理测试文献》，第 1 页',
    })
    assert.ok(note?.id)
    assert.strictEqual(note.kind, 'quote')
    assert.strictEqual(note.outline_id, outline.id)
    const noteLocator = JSON.parse(note.locator_json)
    assert.strictEqual(noteLocator.docId, fixtureDocId)
    assert.strictEqual(noteLocator.pageNum, 1)
    assert.strictEqual(noteLocator.sourceType, 'manual')

    const searchExcerpt = 'search excerpt evidence'
    const searchSourceHash = createHash('sha1').update(`${fixtureDocId}:1:${searchExcerpt}`).digest('hex').slice(0, 16)
    const searchNote = await invoke('research:createNote', {
      project_id: project.id,
      doc_id: fixtureDocId,
      page_num: 1,
      excerpt: searchExcerpt,
      note: '来自检索：测试',
      source_type: 'search',
      kind: 'quote',
      locator: { docId: fixtureDocId, pageNum: 1, segmentId: 'segment-search-1' },
      citation_text: '搜索摘录引用',
      source_id: JSON.stringify({
        sourceType: 'search',
        locator: { docId: fixtureDocId, pageNum: 1, segmentId: 'segment-search-1' },
        searchKeyword: '测试',
      }),
    })
    assert.strictEqual(searchNote.source_hash, searchSourceHash)

    await assert.rejects(
      () => invoke('research:createNote', {
        project_id: project.id,
        doc_id: fixtureDocId,
        page_num: 1,
        excerpt: searchExcerpt,
        source_type: 'search',
        locator: { docId: fixtureDocId, pageNum: 1, segmentId: 'segment-search-duplicate' },
      }),
      /摘录|保存/,
    )

    await assert.rejects(
      () => invoke('research:createNote', {
        project_id: project.id,
        doc_id: fixtureDocId,
        page_num: 1,
        excerpt: '第一段材料可作为摘录证据。',
        source_type: 'manual',
      }),
      /已经保存过/,
    )

    const child = await invoke('research:createOutlineItem', {
      project_id: project.id,
      parent_id: outline.id,
      title: '第一节',
    })
    await invoke('research:moveOutlineItem', child.id, null, 5)
    const outlineList = await invoke('research:listOutline', project.id)
    assert.strictEqual(outlineList.length, 2)
    assert.strictEqual(outlineList.find((item) => item.id === child.id)?.parent_id, null)

    await invoke('research:assignNotesToOutline', [note.id], child.id)
    const notesAfterAssign = await invoke('research:listNotes', project.id)
    const assignedNote = notesAfterAssign.find((item) => item.id === note.id)
    assert.strictEqual(assignedNote?.outline_id, child.id)
    assert.strictEqual(assignedNote?.source_available, 1)

    await invoke('research:updateNote', note.id, { kind: 'comment', note: '改为评论条目', sort_order: 3 })
    const updatedNotes = await invoke('research:listNotes', project.id)
    const updatedNote = updatedNotes.find((item) => item.id === note.id)
    assert.strictEqual(updatedNote?.kind, 'comment')
    assert.strictEqual(updatedNote?.note, '改为评论条目')

    const markdown = await invoke('research:exportProject', project.id, { format: 'markdown', includeReferences: true })
    assert.strictEqual(markdown.format, 'markdown')
    assert.strictEqual(markdown.noteCount, 2)
    assert.strictEqual(markdown.outlineCount, 2)
    assert.ok(markdown.content.includes('# 摘录到写作回归'))
    assert.ok(markdown.content.includes('第一段材料可作为摘录证据。'))
    assert.ok(markdown.content.includes('## 参考文献'))

    const json = await invoke('research:exportProject', project.id, { format: 'json', includeReferences: false })
    const parsed = JSON.parse(json.content)
    assert.strictEqual(parsed.project.id, project.id)
    assert.strictEqual(parsed.notes.length, 2)
    assert.strictEqual(json.referenceCount, 0)

    const output = await invoke('research:createOutput', {
      project_id: project.id,
      output_type: 'summary',
      title: 'snapshot fixture output',
      content: 'snapshot fixture content',
    })
    assert.ok(output.input_snapshot_json)
    const outputSnapshot = JSON.parse(output.input_snapshot_json)
    assert.strictEqual(outputSnapshot.schemaVersion, 'gujismart-research-output-input/v1')
    assert.strictEqual(outputSnapshot.source, 'research:createOutput')
    assert.strictEqual(outputSnapshot.projectId, project.id)
    assert.strictEqual(outputSnapshot.documents.length, 1)
    assert.strictEqual(outputSnapshot.notes.length, 2)
    assert.ok(outputSnapshot.notes.every((item) => item.sourceHash))
    assert.strictEqual(outputSnapshot.metadata.projectIntegrity.projectId, project.id)
    assert.strictEqual(outputSnapshot.metadata.projectIntegrity.metrics.documentCount, 1)
    assert.strictEqual(outputSnapshot.metadata.projectIntegrity.metrics.noteCount, 2)
    assert.strictEqual(outputSnapshot.metadata.projectIntegrity.metrics.missingLocatorNoteCount, 0)
    assert.strictEqual(outputSnapshot.metadata.projectIntegrity.metrics.missingSourceHashNoteCount, 0)
    assert.strictEqual(outputSnapshot.metadata.projectIntegrity.metrics.unavailableSourceNoteCount, 0)
    const listedOutputs = await invoke('research:listOutputs', project.id)
    assert.ok(listedOutputs.some((item) => item.id === output.id && item.input_snapshot_json))

    const docs = await invoke('research:listProjectDocuments', project.id)
    assert.strictEqual(docs.length, 1)

    await invoke('research:deleteProject', project.id)
    assert.strictEqual(database.queryOne('SELECT COUNT(*) as count FROM research_projects')?.count, 0)
    assert.strictEqual(database.queryOne('SELECT COUNT(*) as count FROM research_outline_items')?.count, 0)
    assert.strictEqual(database.queryOne('SELECT COUNT(*) as count FROM research_notes')?.count, 0)

    console.log('Research regression test passed.')
    process.exit(0)
  } finally {
    try {
      database?.closeDatabase?.()
    } catch {
      // ignore cleanup errors
    }
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error('Research regression test failed.')
  console.error(error)
  try {
    rmSync(tempRoot, { recursive: true, force: true })
  } catch {
    // ignore cleanup errors
  }
  process.exit(1)
})
