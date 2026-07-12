const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { buildSync } = require('esbuild')
const { Module } = require('module')

const root = path.resolve(__dirname, '..')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gujismart-translation-cas-'))
const bundlePath = path.join(tempRoot, 'translation-cas.cjs')
const entryPath = path.join(tempRoot, 'entry.js')
const electronStubPath = path.join(tempRoot, 'electron-stub.js')
process.env.GUJISMART_DATA_DIR = path.join(tempRoot, 'data')
process.env.NODE_PATH = path.join(root, 'node_modules')
Module._initPaths()

fs.writeFileSync(electronStubPath, `exports.app={getPath:()=>${JSON.stringify(tempRoot)},getAppPath:()=>${JSON.stringify(root)},getName:()=>'GujiSmart',isPackaged:false}`)
fs.writeFileSync(entryPath, `
  const database=require(${JSON.stringify(path.join(root, 'src/main/database.ts'))})
  const revisions=require(${JSON.stringify(path.join(root, 'src/main/translation-revisions.ts'))})
  module.exports={database,revisions}
`)

async function run() {
  let database
  try {
    buildSync({ entryPoints: [entryPath], bundle: true, platform: 'node', format: 'cjs', outfile: bundlePath,
      external: ['better-sqlite3'], alias: { electron: electronStubPath, '@electron-toolkit/utils': path.join(root, 'scripts/stubs/electron-toolkit-utils.js') }, logLevel: 'silent' })
    const modules = require(bundlePath)
    database = modules.database
    await database.initDatabase()
    const translationServiceSource = fs.readFileSync(path.join(root, 'src/main/translation-service.ts'), 'utf8')
    assert.match(translationServiceSource, /beginTranslationBatchAttempts\(/)
    assert.match(translationServiceSource, /commitMachineTranslationAttempt\(/)
    assert.doesNotMatch(translationServiceSource, /SET translation_text = CASE WHEN \? <> '' THEN \? ELSE translation_text END/)
    database.run("INSERT INTO documents (id,title,import_status,created_at,updated_at) VALUES ('doc-1','Fixture','stored','2026-01-01','2026-01-01')")
    database.run("INSERT INTO pages (id,doc_id,page_num,ocr_text,ocr_status,proof_status,created_at) VALUES ('page-1','doc-1',1,'source one','completed','pending','2026-01-01')")
    database.run(`INSERT INTO page_translation_units
      (id,doc_id,page_id,page_num,unit_id,block_id,block_index,unit_order,block_type,source_text,source_hash,translation_text,target_language,mode,model_signature,glossary_signature,status,manual_override,stale,skipped,quality_json,source_rect_json,created_at,updated_at)
      VALUES ('row-1','doc-1','page-1',1,'unit-1','block-1',0,0,'text','source one','source-hash-1','','zh-CN','balanced','model-a','glossary-a','pending',0,0,0,'{}','', '2026-01-01','2026-01-01')`)

    const base = modules.revisions.ensureActiveTranslationRevision('unit-1')
    assert.strictEqual(base.revision, 1)
    const context = modules.revisions.createTranslationContextSnapshot({
      unitId: 'unit-1', contentVersion: 'artifact-1', canonicalSourceHash: 'canonical-1', sourceLocator: { schemaVersion: 'stable-reader-locator/v2', precision: 'block', documentId: 'doc-1', sourcePageId: 'page-1', pageNum: 1, blockId: 'block-1', contentVersion: 'artifact-1', sourceHash: 'canonical-1', verificationStatus: 'verified' },
      mode: 'balanced', style: 'academic_smooth', providerId: 'provider-a', model: 'model-a', modelSignature: 'provider-a|model-a', parameters: { temperature: 0 }, glossaryVersion: 'g1', promptVersion: 'p1', protectorVersion: 'protect-v1', normalizerVersion: 'normalize-v1',
    })
    const sameContext = modules.revisions.createTranslationContextSnapshot({
      unitId: 'unit-1', contentVersion: 'artifact-1', canonicalSourceHash: 'canonical-1', sourceLocator: JSON.parse(context.source_locator_json), mode: 'balanced', style: 'academic_smooth', providerId: 'provider-a', model: 'model-a', modelSignature: 'provider-a|model-a', parameters: { temperature: 0 }, glossaryVersion: 'g1', promptVersion: 'p1', protectorVersion: 'protect-v1', normalizerVersion: 'normalize-v1',
    })
    assert.strictEqual(sameContext.id, context.id)
    const changedContext = modules.revisions.createTranslationContextSnapshot({
      unitId: 'unit-1', contentVersion: 'artifact-1', canonicalSourceHash: 'canonical-1', sourceLocator: JSON.parse(context.source_locator_json), mode: 'quality', style: 'academic_smooth', providerId: 'provider-a', model: 'model-a', modelSignature: 'provider-a|model-a', parameters: { temperature: 0 }, glossaryVersion: 'g1', promptVersion: 'p1', protectorVersion: 'protect-v1', normalizerVersion: 'normalize-v1',
    })
    assert.notStrictEqual(changedContext.context_hash, context.context_hash)

    const attempt = modules.revisions.beginTranslationAttempt({ taskId: 'task-1', unitId: 'unit-1', contextSnapshotId: context.id })
    const manual = modules.revisions.commitManualTranslationRevision({ unitId: 'unit-1', translationText: '人工译文', expectedRevisionId: base.id })
    const conflict = modules.revisions.commitMachineTranslationAttempt({ attemptId: attempt.id, translationText: '迟到机器译文', quality: { ok: true } })
    assert.strictEqual(conflict.outcome, 'conflict')
    assert.strictEqual(conflict.revision.status, 'detached')
    assert.strictEqual(database.queryOne("SELECT translation_text FROM page_translation_units WHERE unit_id='unit-1'").translation_text, '人工译文')
    assert.strictEqual(modules.revisions.getActiveTranslationRevision('unit-1').id, manual.id)
    assert.throws(() => modules.revisions.commitManualTranslationRevision({ unitId: 'unit-1', translationText: '冲突编辑', expectedRevisionId: base.id }), /translation_revision_conflict/)

    const machineContext = modules.revisions.createTranslationContextSnapshot({
      unitId: 'unit-1', contentVersion: 'artifact-1', canonicalSourceHash: 'canonical-1', sourceLocator: JSON.parse(context.source_locator_json), mode: 'balanced', style: 'academic_smooth', providerId: 'provider-a', model: 'model-a', modelSignature: 'provider-a|model-a', parameters: {}, glossaryVersion: 'g1', promptVersion: 'p1', protectorVersion: 'protect-v1', normalizerVersion: 'normalize-v1',
    })
    database.run("UPDATE page_translation_units SET manual_override=0 WHERE unit_id='unit-1'")
    const sourceAttempt = modules.revisions.beginTranslationAttempt({ taskId: 'task-2', unitId: 'unit-1', contextSnapshotId: machineContext.id })
    database.run("UPDATE page_translation_units SET source_text='source two', source_hash='source-hash-2', stale=1 WHERE unit_id='unit-1'")
    const sourceConflict = modules.revisions.commitMachineTranslationAttempt({ attemptId: sourceAttempt.id, translationText: '旧来源译文', quality: {} })
    assert.strictEqual(sourceConflict.outcome, 'conflict')
    assert.strictEqual(database.queryOne("SELECT translation_text FROM page_translation_units WHERE unit_id='unit-1'").translation_text, '人工译文')

    const page1 = modules.revisions.listTranslationRevisions('unit-1', { limit: 2 })
    const page2 = modules.revisions.listTranslationRevisions('unit-1', { limit: 2, cursor: page1.nextCursor })
    assert.strictEqual(page1.items.length, 2)
    assert.ok(page2.items.length >= 1)
    assert.throws(() => modules.revisions.listTranslationRevisions('unit-1', { limit: 201 }), /translation_revision_limit_invalid/)
    database.closeDatabase()
    await database.initDatabase()
    assert.ok(modules.revisions.getActiveTranslationRevision('unit-1'))
    database.closeDatabase()
    database = null
    console.log('Translation revision and CAS integration regression passed.')
  } finally {
    database?.closeDatabase()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

run().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1) })
