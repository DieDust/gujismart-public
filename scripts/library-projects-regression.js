const assert = require('assert')
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('fs')
const { join } = require('path')
const { buildSync } = require('esbuild')

const root = join(__dirname, '..')
const databaseSource = readFileSync(join(root, 'src', 'main', 'database.ts'), 'utf8')
const documentsSource = readFileSync(join(root, 'src', 'main', 'ipc', 'documents.ts'), 'utf8')
const semanticSearchSource = readFileSync(join(root, 'src', 'main', 'semantic-search.ts'), 'utf8')
const embeddingSource = readFileSync(join(root, 'src', 'main', 'embedding-index.ts'), 'utf8')
const appSource = readFileSync(join(root, 'src', 'renderer', 'src', 'App.tsx'), 'utf8')
const rendererMainSource = readFileSync(join(root, 'src', 'renderer', 'src', 'main.tsx'), 'utf8')
const projectBootstrapSource = readFileSync(join(root, 'src', 'renderer', 'src', 'ProjectBootstrap.tsx'), 'utf8')
const appShellSource = readFileSync(join(root, 'src', 'renderer', 'src', 'AppShell.tsx'), 'utf8')
const libraryViewSource = readFileSync(join(root, 'src', 'renderer', 'src', 'views', 'LibraryView.tsx'), 'utf8')
const workspaceSource = readFileSync(join(root, 'src', 'renderer', 'src', 'utils', 'appWorkspace.ts'), 'utf8')

assert.ok(databaseSource.includes('CREATE TABLE IF NOT EXISTS library_projects'), 'database must persist library projects')
assert.ok(databaseSource.includes('CREATE TABLE IF NOT EXISTS library_project_documents'), 'projects must use a many-to-many document membership table')
assert.ok(databaseSource.includes("VALUES (?, '默认项目', '由旧版本文献自动迁移生成'"), 'legacy documents must migrate to a default project')
assert.ok(databaseSource.includes('trg_documents_assign_library_project'), 'new imports must inherit the active project')
assert.ok(documentsSource.includes('FROM library_project_documents project_scope'), 'library lists must use project memberships')
assert.ok(semanticSearchSource.includes('FROM library_project_documents active_project_scope'), 'full-text search must use project memberships')
assert.ok(embeddingSource.includes('project_scope.document_id = ec.doc_id'), 'vector scans must filter by project memberships in SQL')
assert.ok(embeddingSource.includes('project_scope.document_id = d.id'), 'embedding queues must join active project memberships')
assert.ok(
  !databaseSource.includes('idx_search_segments_library_project')
    && !databaseSource.includes('idx_embedding_chunks_library_project_model'),
  'shared search/vector tables must not build obsolete project indexes during a large-library upgrade',
)
assert.ok(
  !/UPDATE search_index_segments\s+SET library_project_id = \(SELECT d\.library_project_id[\s\S]*?WHERE library_project_id IS NULL;/.test(databaseSource)
    && !/UPDATE embedding_chunks\s+SET library_project_id = \(SELECT d\.library_project_id[\s\S]*?WHERE library_project_id IS NULL;/.test(databaseSource),
  'project migration must not rewrite every shared search segment or vector chunk before first paint',
)
assert.ok(
  databaseSource.includes('DROP TRIGGER IF EXISTS trg_documents_propagate_library_project')
    && !databaseSource.includes('CREATE TRIGGER trg_documents_propagate_library_project'),
  'moving a shared document must not rewrite its canonical search/vector rows',
)
assert.ok(projectBootstrapSource.includes('选择本次要加载的文献项目'), 'startup must wait for project selection')
assert.ok(appSource.includes('migrateGlobalWorkspace: project.id === DEFAULT_LIBRARY_PROJECT_ID'), 'legacy workspace must migrate only to the default project')
assert.ok(
  appSource.includes('void window.api.listLibraryProjects()')
    && !appSource.includes('const refreshedProjects = await window.api.listLibraryProjects()'),
  'project selection should enter the selected workspace before refreshing project counts in the background',
)
assert.ok(
  rendererMainSource.includes("import ProjectBootstrap from './ProjectBootstrap'")
    && !rendererMainSource.includes("from './App'")
    && !rendererMainSource.includes("from 'antd'")
    && projectBootstrapSource.includes("const loadAppShell = () => import('./AppShell')")
    && appShellSource.includes("import App from './App'"),
  'project selection must not parse the full workspace bundle before the user chooses a project',
)
assert.ok(libraryViewSource.includes("key: 'move_project'"), 'library batch menu must expose project transfer')
assert.ok(libraryViewSource.includes("key: 'context_move_project'"), 'document context menu must expose project transfer directly')
assert.ok(libraryViewSource.includes("key: 'link_project'"), 'library batch menu must expose synchronized project linking')
assert.ok(libraryViewSource.includes("key: 'context_link_project'"), 'document context menu must expose synchronized project linking')
assert.ok(libraryViewSource.includes("key: 'copy_project'"), 'library batch menu must expose project copy')
assert.ok(libraryViewSource.includes("key: 'context_copy_project'"), 'document context menu must expose project copy directly')
assert.ok(libraryViewSource.includes('setBatchProjectDocumentIds(targetIds)'), 'project transfer must snapshot the clicked or selected documents')
assert.ok(libraryViewSource.includes("libraryProjects.filter((project) => project.id !== activeLibraryProjectId)"), 'the current project must not be offered as its own transfer target')
assert.ok(libraryViewSource.includes('window.api.moveDocumentsToLibraryProject'), 'project transfer must cross preload explicitly')
assert.ok(libraryViewSource.includes('window.api.addDocumentsToLibraryProject'), 'project linking must cross preload explicitly')
assert.ok(libraryViewSource.includes('window.api.copyDocumentsToLibraryProject'), 'project copy must cross preload explicitly')
assert.ok(workspaceSource.includes('scopedWorkspaceKey'), 'open tabs must be persisted independently per project')

const tempRoot = mkdtempSync(join(__dirname, '.tmp-library-projects-'))
const bundlePath = join(tempRoot, 'library-projects-regression-bundle.cjs')
const entryPath = join(tempRoot, 'library-projects-regression-entry.js')
const electronStubPath = join(tempRoot, 'electron-stub.js')
process.env.GUJISMART_DATA_DIR = join(tempRoot, 'data')

writeFileSync(electronStubPath, `
  exports.app = {
    getName: () => 'gujismart-test',
    getPath: () => ${JSON.stringify(tempRoot)}
  }
`)
writeFileSync(entryPath, `
  const database = require(${JSON.stringify(join(root, 'src', 'main', 'database.ts'))})
  const projects = require(${JSON.stringify(join(root, 'src', 'main', 'library-projects.ts'))})
  module.exports = { database, projects }
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

    const defaultProject = modules.projects.getActiveLibraryProject()
    assert.strictEqual(defaultProject.id, 'library_project_default')

    const timestamp = '2026-01-01T00:00:00.000Z'
    database.run(
      `INSERT INTO documents
       (id, title, file_path, thumb_path, import_status, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'processed', '{}', ?, ?)`,
      [
        'legacy_doc',
        'Legacy document',
        join(process.env.GUJISMART_DATA_DIR, 'storage', 'legacy_doc', 'source.pdf'),
        join(process.env.GUJISMART_DATA_DIR, 'storage', 'legacy_doc', 'thumb.png'),
        timestamp,
        timestamp,
      ],
    )
    const legacyStorageRoot = join(process.env.GUJISMART_DATA_DIR, 'storage', 'legacy_doc')
    mkdirSync(legacyStorageRoot, { recursive: true })
    writeFileSync(join(legacyStorageRoot, 'source.pdf'), 'source-pdf-content')
    writeFileSync(join(legacyStorageRoot, 'thumb.png'), 'source-thumbnail')
    assert.strictEqual(
      database.queryOne('SELECT library_project_id FROM documents WHERE id = ?', ['legacy_doc']).library_project_id,
      defaultProject.id,
    )
    assert.strictEqual(
      database.queryOne(
        'SELECT COUNT(*) AS count FROM library_project_documents WHERE project_id = ? AND document_id = ?',
        [defaultProject.id, 'legacy_doc'],
      ).count,
      1,
      'new documents must automatically receive a project membership',
    )
    database.run(
      `INSERT INTO pages (id, doc_id, page_num, image_path, ocr_text, ocr_status, created_at)
       VALUES ('legacy_page', 'legacy_doc', 1, ?, 'preserved OCR text', 'completed', ?)`,
      [join(legacyStorageRoot, 'page-1.png'), timestamp],
    )
    writeFileSync(join(legacyStorageRoot, 'page-1.png'), 'source-page-image')
    database.run(
      `INSERT INTO embedding_index_status
       (doc_id, status, segment_count, embedded_count, content_hash, updated_at)
       VALUES ('legacy_doc', 'ready', 1, 1, 'preserved-vector-hash', ?)`,
      [timestamp],
    )
    database.run(
      `INSERT INTO research_notes
       (id, library_project_id, doc_id, page_num, excerpt, note, created_at, updated_at)
       VALUES ('legacy_note', ?, 'legacy_doc', 1, 'preserved excerpt', 'preserved note', ?, ?)`,
      [defaultProject.id, timestamp, timestamp],
    )
    database.run(
      `INSERT INTO folders (id, library_project_id, name, created_at, updated_at)
       VALUES ('legacy_folder', ?, 'Legacy folder', ?, ?)`,
      [defaultProject.id, timestamp, timestamp],
    )
    database.run("INSERT INTO document_folders (doc_id, folder_id) VALUES ('legacy_doc', 'legacy_folder')")
    database.run(
      `INSERT INTO tags (id, library_project_id, name, normalized_name, created_at, updated_at)
       VALUES ('legacy_tag', ?, 'Legacy tag', 'legacy tag', ?, ?)`,
      [defaultProject.id, timestamp, timestamp],
    )
    database.run("INSERT INTO document_tags (doc_id, tag_id) VALUES ('legacy_doc', 'legacy_tag')")
    database.run(
      `INSERT INTO search_index_segments
       (segment_id, doc_id, page_id, page_num, text, normalized_text, text_hash, updated_at)
       VALUES ('legacy_segment', 'legacy_doc', 'legacy_page', 1, 'preserved OCR text', 'preserved OCR text', 'segment-hash', ?)`,
      [timestamp],
    )
    database.run(
      `INSERT INTO embedding_chunks
       (segment_id, doc_id, page_id, page_num, model_id, dim, content_hash, embedding, updated_at)
       VALUES ('legacy_segment', 'legacy_doc', 'legacy_page', 1, 'test-model@1', 1, 'vector-hash', ?, ?)`,
      [Buffer.alloc(4), timestamp],
    )
    assert.deepStrictEqual(
      database.queryOne(
        `SELECT
           (SELECT library_project_id FROM search_index_segments WHERE segment_id = 'legacy_segment') AS search_project,
           (SELECT library_project_id FROM embedding_chunks WHERE segment_id = 'legacy_segment') AS vector_project`,
      ),
      { search_project: defaultProject.id, vector_project: defaultProject.id },
      'new search/vector rows must inherit the document project',
    )

    const secondProject = modules.projects.createLibraryProject({ name: 'Second project', activate: true })
    database.run(
      `INSERT INTO documents
       (id, title, import_status, metadata, created_at, updated_at)
       VALUES (?, ?, 'processed', '{}', ?, ?)`,
      ['new_doc', 'New document', timestamp, timestamp],
    )
    assert.strictEqual(
      database.queryOne('SELECT library_project_id FROM documents WHERE id = ?', ['new_doc']).library_project_id,
      secondProject.id,
    )
    assert.strictEqual(
      database.queryOne(
        'SELECT COUNT(*) AS count FROM library_project_documents WHERE project_id = ? AND document_id = ?',
        [secondProject.id, 'new_doc'],
      ).count,
      1,
    )

    modules.projects.setActiveLibraryProject(defaultProject.id)
    assert.throws(
      () => modules.projects.moveDocumentsToLibraryProject(['new_doc'], defaultProject.id),
      /current project|belongs|项目|文献/,
      'a stale document selection from another project must be rejected',
    )
    const linked = modules.projects.addDocumentsToLibraryProject(
      ['legacy_doc', 'legacy_doc'],
      secondProject.id,
    )
    assert.deepStrictEqual(linked, {
      requested: 1,
      added: 1,
      already_present: 0,
      source_project_id: defaultProject.id,
      target_project_id: secondProject.id,
    })
    assert.strictEqual(
      database.queryOne(
        'SELECT COUNT(*) AS count FROM library_project_documents WHERE document_id = ?',
        ['legacy_doc'],
      ).count,
      2,
      'linking must reuse one canonical document across projects',
    )
    assert.strictEqual(
      database.queryOne('SELECT COUNT(*) AS count FROM documents WHERE id = ?', ['legacy_doc']).count,
      1,
      'linking must not clone the document row',
    )
    assert.strictEqual(
      database.queryOne('SELECT COUNT(*) AS count FROM embedding_chunks WHERE doc_id = ?', ['legacy_doc']).count,
      1,
      'linking must reuse the vector index',
    )
    assert.strictEqual(
      database.queryOne(
        'SELECT COUNT(*) AS count FROM research_notes WHERE doc_id = ? AND library_project_id = ?',
        ['legacy_doc', secondProject.id],
      ).count,
      0,
      'project-specific excerpts must not leak into a linked project',
    )
    database.run('UPDATE documents SET title = ? WHERE id = ?', ['Shared document title', 'legacy_doc'])
    database.run('UPDATE pages SET ocr_text = ? WHERE doc_id = ?', ['Shared OCR text', 'legacy_doc'])
    modules.projects.setActiveLibraryProject(secondProject.id)
    assert.deepStrictEqual(
      database.queryOne(
        `SELECT d.title, p.ocr_text
         FROM documents d
         INNER JOIN pages p ON p.doc_id = d.id
         INNER JOIN library_project_documents lpd ON lpd.document_id = d.id
         WHERE lpd.project_id = ? AND d.id = ?`,
        [secondProject.id, 'legacy_doc'],
      ),
      { title: 'Shared document title', ocr_text: 'Shared OCR text' },
      'edits to a linked document must be visible from every project',
    )
    modules.projects.setActiveLibraryProject(defaultProject.id)

    const copied = await modules.projects.copyDocumentsToLibraryProject(
      ['legacy_doc', 'legacy_doc'],
      secondProject.id,
    )
    assert.strictEqual(copied.requested, 1)
    assert.strictEqual(copied.copied, 1)
    assert.strictEqual(copied.source_project_id, defaultProject.id)
    assert.strictEqual(copied.target_project_id, secondProject.id)
    assert.strictEqual(copied.documents.length, 1)
    assert.strictEqual(copied.documents[0].source_document_id, 'legacy_doc')
    const copiedDocId = copied.documents[0].copied_document_id
    assert.ok(copiedDocId && copiedDocId !== 'legacy_doc')
    const copiedDocument = database.queryOne(
      `SELECT
         d.library_project_id,
         d.file_path,
         d.thumb_path,
         (SELECT id FROM pages WHERE doc_id = d.id LIMIT 1) AS page_id,
         (SELECT image_path FROM pages WHERE doc_id = d.id LIMIT 1) AS image_path,
         (SELECT ocr_text FROM pages WHERE doc_id = d.id LIMIT 1) AS ocr_text,
         (SELECT status FROM embedding_index_status WHERE doc_id = d.id) AS embedding_status,
         (SELECT excerpt FROM research_notes WHERE doc_id = d.id LIMIT 1) AS excerpt,
         (SELECT project_id FROM research_notes WHERE doc_id = d.id LIMIT 1) AS excerpt_project_id,
         (SELECT COUNT(*) FROM document_folders WHERE doc_id = d.id) AS folder_count,
         (SELECT COUNT(*) FROM document_tags WHERE doc_id = d.id) AS tag_count
       FROM documents d
       WHERE d.id = ?`,
      [copiedDocId],
    )
    assert.deepStrictEqual(
      {
        library_project_id: copiedDocument.library_project_id,
        ocr_text: copiedDocument.ocr_text,
        embedding_status: copiedDocument.embedding_status,
        excerpt: copiedDocument.excerpt,
        excerpt_project_id: copiedDocument.excerpt_project_id,
        folder_count: copiedDocument.folder_count,
        tag_count: copiedDocument.tag_count,
      },
      {
        library_project_id: secondProject.id,
        ocr_text: 'Shared OCR text',
        embedding_status: 'ready',
        excerpt: 'preserved excerpt',
        excerpt_project_id: null,
        folder_count: 1,
        tag_count: 1,
      },
      'copying must preserve isolated document content and organization in the target project',
    )
    assert.notStrictEqual(copiedDocument.page_id, 'legacy_page')
    assert.notStrictEqual(copiedDocument.file_path, join(legacyStorageRoot, 'source.pdf'))
    assert.strictEqual(readFileSync(copiedDocument.file_path, 'utf8'), 'source-pdf-content')
    assert.strictEqual(readFileSync(copiedDocument.thumb_path, 'utf8'), 'source-thumbnail')
    assert.strictEqual(readFileSync(copiedDocument.image_path, 'utf8'), 'source-page-image')
    const copiedSearchVector = database.queryOne(
      `SELECT
         sis.library_project_id AS search_project,
         sis.segment_id AS search_segment,
         sis.page_id AS search_page,
         ec.library_project_id AS vector_project,
         ec.segment_id AS vector_segment,
         ec.page_id AS vector_page
       FROM search_index_segments sis
       JOIN embedding_chunks ec ON ec.segment_id = sis.segment_id
       WHERE sis.doc_id = ?`,
      [copiedDocId],
    )
    assert.deepStrictEqual(
      {
        search_project: copiedSearchVector.search_project,
        search_page: copiedSearchVector.search_page,
        vector_project: copiedSearchVector.vector_project,
        vector_page: copiedSearchVector.vector_page,
      },
      {
        search_project: secondProject.id,
        search_page: copiedDocument.page_id,
        vector_project: secondProject.id,
        vector_page: copiedDocument.page_id,
      },
      'copied search and vector rows must be remapped to the target document and page',
    )
    assert.notStrictEqual(copiedSearchVector.search_segment, 'legacy_segment')
    assert.strictEqual(copiedSearchVector.vector_segment, copiedSearchVector.search_segment)

    database.run('UPDATE documents SET title = ? WHERE id = ?', ['Changed copied title', copiedDocId])
    database.run('UPDATE pages SET ocr_text = ? WHERE doc_id = ?', ['Changed copied OCR', copiedDocId])
    writeFileSync(copiedDocument.file_path, 'changed-copy-content')
    assert.deepStrictEqual(
      database.queryOne(
        `SELECT d.title, p.ocr_text
         FROM documents d JOIN pages p ON p.doc_id = d.id
         WHERE d.id = 'legacy_doc'`,
      ),
      { title: 'Shared document title', ocr_text: 'Shared OCR text' },
      'editing the copied database records must not mutate the source document',
    )
    assert.strictEqual(
      readFileSync(join(legacyStorageRoot, 'source.pdf'), 'utf8'),
      'source-pdf-content',
      'editing a copied physical file must not mutate the source file',
    )

    const moved = modules.projects.moveDocumentsToLibraryProject(['legacy_doc', 'legacy_doc'], secondProject.id)
    assert.deepStrictEqual(moved, {
      requested: 1,
      moved: 1,
      from_project_ids: [defaultProject.id],
      target_project_id: secondProject.id,
    })
    const projects = modules.projects.listLibraryProjects()
    assert.strictEqual(projects.find((project) => project.id === defaultProject.id).document_count, 0)
    assert.strictEqual(projects.find((project) => project.id === secondProject.id).document_count, 3)
    assert.strictEqual(
      database.queryOne(
        `SELECT
           (SELECT ocr_text FROM pages WHERE doc_id = d.id LIMIT 1) AS ocr_text,
           (SELECT status FROM embedding_index_status WHERE doc_id = d.id) AS embedding_status,
           (SELECT excerpt FROM research_notes WHERE doc_id = d.id LIMIT 1) AS excerpt,
           (SELECT COUNT(*) FROM document_folders WHERE doc_id = d.id) AS folder_count,
           (SELECT COUNT(*) FROM document_tags WHERE doc_id = d.id) AS tag_count
         FROM documents d
         WHERE d.id = 'legacy_doc'`,
      ).ocr_text,
      'Shared OCR text',
      'moving a document must preserve its OCR/page content',
    )
    const preservedRelations = database.queryOne(
      `SELECT
         (SELECT status FROM embedding_index_status WHERE doc_id = d.id) AS embedding_status,
         (SELECT excerpt FROM research_notes WHERE doc_id = d.id LIMIT 1) AS excerpt,
         (SELECT COUNT(*) FROM document_folders WHERE doc_id = d.id) AS folder_count,
         (SELECT COUNT(*) FROM document_tags WHERE doc_id = d.id) AS tag_count
       FROM documents d
       WHERE d.id = 'legacy_doc'`,
    )
    assert.deepStrictEqual(preservedRelations, {
      embedding_status: 'ready',
      excerpt: 'preserved excerpt',
      folder_count: 1,
      tag_count: 1,
    }, 'moving a document must preserve vector state, excerpts, folders, and tags')
    const movedOrganization = database.queryOne(
      `SELECT
         (SELECT f.library_project_id
          FROM document_folders df JOIN folders f ON f.id = df.folder_id
          WHERE df.doc_id = 'legacy_doc' LIMIT 1) AS folder_project,
         (SELECT t.library_project_id
          FROM document_tags dt JOIN tags t ON t.id = dt.tag_id
          WHERE dt.doc_id = 'legacy_doc' LIMIT 1) AS tag_project,
         (SELECT COUNT(*) FROM folders WHERE id = 'legacy_folder' AND library_project_id = ?) AS source_folder_kept,
         (SELECT COUNT(*) FROM tags WHERE id = 'legacy_tag' AND library_project_id = ?) AS source_tag_kept`,
      [defaultProject.id, defaultProject.id],
    )
    assert.deepStrictEqual(movedOrganization, {
      folder_project: secondProject.id,
      tag_project: secondProject.id,
      source_folder_kept: 1,
      source_tag_kept: 1,
    }, 'moving a document must remap project-owned folders and tags without deleting source definitions')
    assert.deepStrictEqual(
      database.queryOne(
        `SELECT
           (SELECT library_project_id FROM search_index_segments WHERE segment_id = 'legacy_segment') AS search_project,
           (SELECT library_project_id FROM embedding_chunks WHERE segment_id = 'legacy_segment') AS vector_project`,
      ),
      { search_project: defaultProject.id, vector_project: defaultProject.id },
      'moving a document must leave canonical search/vector rows untouched because project scope comes from membership',
    )

    await modules.projects.withLibraryProjectContext(defaultProject.id, async () => {
      modules.projects.setActiveLibraryProject(secondProject.id)
      await Promise.resolve()
      assert.strictEqual(
        modules.projects.getActiveLibraryProjectId(),
        defaultProject.id,
        'an async operation must retain the project captured when it started',
      )
    })
    assert.strictEqual(modules.projects.getActiveLibraryProjectId(), secondProject.id)

    const largeProject = modules.projects.createLibraryProject({ name: 'Large selection project', activate: false })
    const sqlite = database.getDatabase()
    const insertLargeDocument = sqlite.prepare(
      `INSERT INTO documents
       (id, library_project_id, title, import_status, metadata, created_at, updated_at)
       VALUES (?, ?, ?, 'processed', '{}', ?, ?)`,
    )
    sqlite.transaction(() => {
      for (let index = 0; index < 20_000; index += 1) {
        const id = `large_project_doc_${index}`
        insertLargeDocument.run(id, largeProject.id, `Large project document ${index}`, timestamp, timestamp)
      }
    })()
    const selectionStartedAt = Date.now()
    const selectedLargeProject = modules.projects.setActiveLibraryProject(largeProject.id)
    const selectionDurationMs = Date.now() - selectionStartedAt
    assert.strictEqual(selectedLargeProject.document_count, 20_000)
    assert.ok(
      selectionDurationMs < 1_500,
      `large project selection should stay bounded, took ${selectionDurationMs}ms`,
    )
    const creationStartedAt = Date.now()
    const emptyProject = modules.projects.createLibraryProject({ name: 'Fast empty project', activate: true })
    const creationDurationMs = Date.now() - creationStartedAt
    assert.strictEqual(emptyProject.document_count, 0)
    assert.ok(
      creationDurationMs < 1_500,
      `empty project creation should not aggregate the large library, took ${creationDurationMs}ms`,
    )
    console.log(
      `Large project responsiveness: select=${selectionDurationMs}ms create=${creationDurationMs}ms documents=20000`,
    )
    assert.deepStrictEqual(database.queryAll('PRAGMA foreign_key_check'), [], 'project migration must preserve foreign keys')

    console.log('Library project migration, isolation, workspace, transfer, and copy regression passed.')
    process.exit(0)
  } finally {
    try {
      database?.closeDatabase?.()
    } catch {
      // Ignore cleanup errors.
    }
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error('Library project regression failed.')
  console.error(error)
  try {
    rmSync(tempRoot, { recursive: true, force: true })
  } catch {
    // Ignore cleanup errors.
  }
  process.exit(1)
})
