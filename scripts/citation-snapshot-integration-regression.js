const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { buildSync } = require('esbuild')
const { Module } = require('module')

const root = path.resolve(__dirname, '..')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gujismart-citation-snapshot-'))
const bundlePath = path.join(tempRoot, 'citation-snapshot.cjs')
const entryPath = path.join(tempRoot, 'entry.js')
const electronStubPath = path.join(tempRoot, 'electron-stub.js')
process.env.GUJISMART_DATA_DIR = path.join(tempRoot, 'data')
process.env.NODE_PATH = path.join(root, 'node_modules')
Module._initPaths()

fs.writeFileSync(electronStubPath, `exports.app={getPath:()=>${JSON.stringify(tempRoot)},getAppPath:()=>${JSON.stringify(root)},getName:()=>'GujiSmart',isPackaged:false}`)
fs.writeFileSync(entryPath, `
  const database=require(${JSON.stringify(path.join(root, 'src/main/database.ts'))})
  const resolver=require(${JSON.stringify(path.join(root, 'src/shared/citation-resolution-v2.ts'))})
  const snapshots=require(${JSON.stringify(path.join(root, 'src/main/citation-snapshots.ts'))})
  module.exports={database,resolver,snapshots}
`)

async function run() {
  let database
  try {
    buildSync({ entryPoints: [entryPath], bundle: true, platform: 'node', format: 'cjs', outfile: bundlePath,
      external: ['better-sqlite3'], alias: { electron: electronStubPath, '@electron-toolkit/utils': path.join(root, 'scripts/stubs/electron-toolkit-utils.js') }, logLevel: 'silent' })
    const modules = require(bundlePath)
    const ancient = modules.resolver.buildCitationResolutionV2({ documentId: 'doc-1', citationType: 'guji_blockprint', formatId: 'guji_blockprint', styleVersion: 's1', templateVersion: 't1', rendered: '史记', fields: [
      { name: 'title', value: '史记', source: 'documents.title' }, { name: 'responsibility', value: '司马迁撰', source: 'metadata.responsibility' },
    ] })
    assert.notStrictEqual(ancient.verificationStatus, 'blocked')
    assert.ok(ancient.fields.every((field) => field.status === 'resolved'))
    const journal = modules.resolver.buildCitationResolutionV2({ documentId: 'doc-1', citationType: 'journal', formatId: 'GB-T7714', styleVersion: 's1', templateVersion: 't1', rendered: 'A', fields: [
      { name: 'title', value: 'A', source: 'documents.title' }, { name: 'author', value: 'B', source: 'documents.author' }, { name: 'year', value: '2024', source: 'metadata.year' },
    ] })
    assert.strictEqual(journal.verificationStatus, 'blocked')
    assert.ok(journal.diagnostics.some((item) => item.code === 'citation.required_group_missing' && item.field === 'journal'))

    database = modules.database
    await database.initDatabase()
    database.run("INSERT INTO documents (id,title,author,doc_type,metadata,import_status,created_at,updated_at) VALUES ('doc-1','A','B','journal','{\"year\":\"2024\",\"journal\":\"J\"}','stored','2026-01-01','2026-01-01')")
    database.run("INSERT INTO citation_styles (id,name,description,is_default,created_at,updated_at) VALUES ('style-1','S','',0,'2026-01-01','2026-01-01')")
    database.run("INSERT INTO citation_templates (id,style_id,name,format_type,template_text,field_mappings,is_default,created_at,updated_at) VALUES ('template-1','style-1','T','GB-T7714','{{author}}. {{title}}. {{journal}}, {{year}}','{}',0,'2026-01-01','2026-01-01')")
    const resolution = modules.resolver.buildCitationResolutionV2({ documentId: 'doc-1', citationType: 'journal', formatId: 'GB-T7714', styleVersion: 'pending', templateVersion: 'pending', rendered: 'B. A. J, 2024', fields: [
      { name: 'title', value: 'A', source: 'documents.title' }, { name: 'author', value: 'B', source: 'documents.author' }, { name: 'journal', value: 'J', source: 'metadata.journal' }, { name: 'year', value: '2024', source: 'metadata.year' },
    ] })
    const saved = modules.snapshots.persistCitationSnapshot({ documentId: 'doc-1', styleId: 'style-1', templateId: 'template-1', resolution })
    const same = modules.snapshots.persistCitationSnapshot({ documentId: 'doc-1', styleId: 'style-1', templateId: 'template-1', resolution })
    assert.strictEqual(saved.id, same.id)
    assert.strictEqual(modules.snapshots.validateCitationSnapshot(saved.id).validation, 'verified')
    database.run("UPDATE documents SET title='Changed', updated_at='2026-01-02' WHERE id='doc-1'")
    assert.strictEqual(modules.snapshots.validateCitationSnapshot(saved.id).validation, 'stale')
    database.run("UPDATE citation_snapshots SET resolution_json='{}' WHERE id=?", [saved.id])
    assert.strictEqual(modules.snapshots.validateCitationSnapshot(saved.id).validation, 'corrupt')
    assert.strictEqual(modules.snapshots.listCitationSnapshots('doc-1', { limit: 1 }).items.length, 1)
    assert.throws(() => modules.snapshots.listCitationSnapshots('doc-1', { limit: 201 }), /citation_snapshot_limit_invalid/)
    database.closeDatabase()
    await database.initDatabase()
    assert.ok(database.queryOne('SELECT id FROM citation_snapshots WHERE id = ?', [saved.id]))
    database.closeDatabase()
    database = null
    console.log('Citation resolution and snapshot integration regression passed.')
  } finally {
    database?.closeDatabase()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

run().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1) })
