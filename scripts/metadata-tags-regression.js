const assert = require('assert')
const { app } = require('electron')
const { mkdtempSync, rmSync, writeFileSync } = require('fs')
const { join } = require('path')
const { buildSync } = require('esbuild')

const tempRoot = mkdtempSync(join(__dirname, '.tmp-metadata-tags-'))
const tempDataDir = join(tempRoot, 'data')
const bundlePath = join(tempRoot, 'metadata-tags-regression-bundle.cjs')
const entryPath = join(tempRoot, 'metadata-tags-regression-entry.js')

process.env.GUJISMART_DATA_DIR = tempDataDir

writeFileSync(entryPath, `
  const database = require(${JSON.stringify(join(__dirname, '..', 'src', 'main', 'database.ts'))})
  const metadataTags = require(${JSON.stringify(join(__dirname, '..', 'src', 'main', 'metadata-tags.ts'))})
  module.exports = { database, metadataTags }
`)

buildSync({
  entryPoints: [entryPath],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: bundlePath,
  external: ['better-sqlite3'],
  alias: {
    electron: join(__dirname, 'stubs', 'electron.js'),
    '@electron-toolkit/utils': join(__dirname, 'stubs', 'electron-toolkit-utils.js'),
  },
  logLevel: 'silent',
})

function getMetadataRelationCount(database, docId) {
  return database.queryOne(
    `SELECT COUNT(*) as count
     FROM document_tags
     WHERE doc_id = ?
       AND (
         COALESCE(is_metadata, 0) = 1
         OR TRIM(COALESCE(source_field, '')) != ''
       )`,
    [docId],
  )?.count || 0
}

function insertMetadataDocument(database) {
  const now = new Date().toISOString()
  const metadata = {
    author: 'Sample Author',
    dynasty: 'Sample Period',
    publisher: 'Sample Press',
    keywords: ['cataloging', 'edition'],
  }
  database.run(
    `INSERT INTO documents (
      id, title, author, dynasty, source, doc_type, file_path, thumb_path, page_count,
      ocr_status, proof_status, import_status, metadata_status, metadata, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      'doc_metadata_tags',
      'Metadata tag regression',
      metadata.author,
      metadata.dynasty,
      null,
      'book',
      null,
      null,
      1,
      'completed',
      'pending',
      'processed',
      'auto',
      JSON.stringify(metadata),
      now,
      now,
    ],
  )
  return metadata
}

function insertAiOnlyTag(database, docId) {
  const now = new Date().toISOString()
  database.run(
    'INSERT INTO tags (id, name, color, parent_id, source, confidence, usage_count, normalized_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ['tag_ai_only', 'AI only', '#52c41a', null, 'ai', 0.8, 1, 'ai only', now, now],
  )
  database.run(
    'INSERT INTO document_tags (doc_id, tag_id, is_manual, is_metadata, source_field, confidence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [docId, 'tag_ai_only', 0, 0, null, 0.8, now, now],
  )
}

async function run() {
  let database
  try {
    const modules = require(bundlePath)
    database = modules.database
    const metadataTags = modules.metadataTags

    await database.initDatabase()
    const metadata = insertMetadataDocument(database)

    database.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', ['metadata_tag_binding_enabled', 'true'])
    metadataTags.syncDocumentMetadataTags('doc_metadata_tags', metadata, 'book', {
      author: metadata.author,
      dynasty: metadata.dynasty,
      source: null,
    })
    const initialRelations = getMetadataRelationCount(database, 'doc_metadata_tags')
    assert.ok(initialRelations >= 5, `Expected initial metadata relations, got ${initialRelations}`)

    database.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', ['metadata_tag_binding_enabled', 'false'])
    const cleanup = metadataTags.ensureDisabledMetadataTagBindingsCleared()
    assert.ok(cleanup && cleanup.removedRelations >= 5, `Expected cleanup result, got ${JSON.stringify(cleanup)}`)
    assert.strictEqual(getMetadataRelationCount(database, 'doc_metadata_tags'), 0)

    insertAiOnlyTag(database, 'doc_metadata_tags')
    database.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', ['metadata_tag_binding_enabled', 'true'])
    assert.strictEqual(metadataTags.needsMetadataTagBindingRebuild(), true)

    const selfHealRebuild = await metadataTags.ensureEnabledMetadataTagBindingsRebuilt()
    assert.ok(selfHealRebuild, 'Expected enabled metadata tag self-heal to rebuild missing bindings')
    assert.strictEqual(selfHealRebuild.processedDocuments, 1)
    assert.strictEqual(selfHealRebuild.syncedDocuments, 1)
    assert.ok(
      selfHealRebuild.createdOrUpdatedRelations >= 5,
      `Expected self-healed relations, got ${JSON.stringify(selfHealRebuild)}`,
    )
    const restoredRelations = getMetadataRelationCount(database, 'doc_metadata_tags')
    assert.ok(restoredRelations >= 5, `Expected restored metadata relations, got ${restoredRelations}`)
    assert.strictEqual(metadataTags.needsMetadataTagBindingRebuild(), false)
    assert.strictEqual(await metadataTags.ensureEnabledMetadataTagBindingsRebuilt(), null)

    console.log('Metadata tag binding regression passed')
  } finally {
    if (database) database.closeDatabase()
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

run()
  .then(() => {
    app.quit()
    process.exit(0)
  })
  .catch((error) => {
    console.error(error)
    rmSync(tempRoot, { recursive: true, force: true })
    app.quit()
    process.exit(1)
  })
