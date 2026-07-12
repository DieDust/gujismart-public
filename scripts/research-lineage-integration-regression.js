const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { buildSync } = require('esbuild')
const { Module } = require('module')
const { createHash } = require('crypto')

const root = path.resolve(__dirname, '..')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gujismart-research-lineage-'))
const bundlePath = path.join(tempRoot, 'research-lineage.cjs')
const entryPath = path.join(tempRoot, 'entry.js')
const electronStubPath = path.join(tempRoot, 'electron-stub.js')
process.env.GUJISMART_DATA_DIR = path.join(tempRoot, 'data')
process.env.NODE_PATH = path.join(root, 'node_modules')
Module._initPaths()

fs.writeFileSync(electronStubPath, `exports.app={getPath:()=>${JSON.stringify(tempRoot)},getAppPath:()=>${JSON.stringify(root)},getName:()=>'GujiSmart',isPackaged:false}`)
fs.writeFileSync(entryPath, `
  const database=require(${JSON.stringify(path.join(root, 'src/main/database.ts'))})
  const repository=require(${JSON.stringify(path.join(root, 'src/main/research-repository.ts'))})
  module.exports={database,repository}
`)

async function run() {
  let database
  try {
    buildSync({ entryPoints: [entryPath], bundle: true, platform: 'node', format: 'cjs', outfile: bundlePath,
      external: ['better-sqlite3'], alias: { electron: electronStubPath, '@electron-toolkit/utils': path.join(root, 'scripts/stubs/electron-toolkit-utils.js') }, logLevel: 'silent' })
    const modules = require(bundlePath)
    database = modules.database
    await database.initDatabase()
    const researchIpcSource = fs.readFileSync(path.join(root, 'src/main/ipc/research.ts'), 'utf8')
    const aiResearchIpcSource = fs.readFileSync(path.join(root, 'src/main/ipc/ai-research.ts'), 'utf8')
    const preloadSource = fs.readFileSync(path.join(root, 'src/preload/index.ts'), 'utf8')
    assert.doesNotMatch(researchIpcSource, /normalizeOutputInputSnapshotJson\(payload\.input_snapshot_json/)
    assert.match(researchIpcSource, /createResearchOutputVersion\(/)
    assert.match(aiResearchIpcSource, /commitExistingResearchRecordUpdate\(/)
    assert.match(aiResearchIpcSource, /createResearchOutputVersion\(/)
    assert.match(researchIpcSource, /research:listEvidenceRelations/)
    assert.match(researchIpcSource, /research:promoteNoteEvidence/)
    assert.match(preloadSource, /listResearchEvidenceRelations/)
    assert.match(preloadSource, /promoteResearchNoteEvidence/)
    assert.match(researchIpcSource, /research:finalizeOutputVersion/)
    assert.match(preloadSource, /finalizeResearchOutputVersion/)
    const tables = database.queryAll("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'research_%' ORDER BY name").map((row) => row.name)
    ;['research_evidence', 'research_evidence_relations', 'research_record_versions', 'research_record_review_events', 'research_output_versions', 'research_claim_manifests', 'research_claim_entries'].forEach((name) => assert.ok(tables.includes(name), name))
    database.run("INSERT INTO documents (id,title,import_status,created_at,updated_at) VALUES ('doc-1','Fixture','stored','2026-01-01','2026-01-01')")
    database.run("INSERT INTO pages (id,doc_id,page_num,ocr_text,ocr_status,proof_status,created_at) VALUES ('page-1','doc-1',1,'alpha beta gamma','completed','pending','2026-01-01')")
    database.run("INSERT INTO research_projects (id,name,status,created_at,updated_at) VALUES ('project-1','P','active','2026-01-01','2026-01-01')")

    const evidence = modules.repository.upsertResearchEvidence({
      documentId: 'doc-1', sourcePageId: 'page-1', pageNum: 1, start: 6, end: 10, quote: 'beta', projectId: 'project-1', relationKind: 'note', note: 'first',
    })
    const same = modules.repository.upsertResearchEvidence({
      documentId: 'doc-1', sourcePageId: 'page-1', pageNum: 1, start: 6, end: 10, quote: 'beta', projectId: 'project-1', relationKind: 'basket', note: 'second',
    })
    assert.strictEqual(same.evidence.id, evidence.evidence.id)
    assert.strictEqual(database.queryOne('SELECT COUNT(*) AS count FROM research_evidence').count, 1)
    assert.strictEqual(database.queryOne('SELECT COUNT(*) AS count FROM research_evidence_relations').count, 2)
    assert.strictEqual(evidence.evidence.verification_status, 'verified')
    database.run("INSERT INTO research_notes (id,project_id,doc_id,page_num,excerpt,note,tags,source_type,kind,locator_json,source_hash,created_at,updated_at) VALUES ('note-1','project-1','doc-1',1,'beta','legacy note','tag-a, tag-b','manual','quote','',?,'2026-01-01','2026-01-01')", [evidence.evidence.source_hash])
    const promoted = modules.repository.promoteResearchNoteToEvidence('note-1')
    assert.strictEqual(promoted.evidence.id, evidence.evidence.id)
    assert.strictEqual(promoted.relation.project_id, 'project-1')
    database.run("INSERT INTO research_notes (id,project_id,doc_id,page_num,excerpt,note,tags,source_type,kind,locator_json,source_hash,created_at,updated_at) VALUES ('note-ambiguous','project-1','doc-1',1,'a','','','manual','quote','','','2026-01-01','2026-01-01')")
    assert.throws(() => modules.repository.promoteResearchNoteToEvidence('note-ambiguous'), /research_note_evidence_unresolved/)
    for (let index = 0; index < 203; index += 1) {
      modules.repository.upsertResearchEvidence({
        documentId: 'doc-1', sourcePageId: 'page-1', pageNum: 1, start: 6, end: 10, quote: 'beta', projectId: 'project-1', relationKind: `relation-${index}`,
      })
    }
    const relationPage1 = modules.repository.listResearchEvidenceRelations('project-1', { limit: 200 })
    assert.strictEqual(relationPage1.items.length, 200)
    assert.ok(relationPage1.nextCursor)
    const relationPage2 = modules.repository.listResearchEvidenceRelations('project-1', { limit: 200, cursor: relationPage1.nextCursor })
    assert.strictEqual(relationPage2.items.length, 6)
    assert.strictEqual(relationPage2.nextCursor, null)
    assert.throws(() => modules.repository.listResearchEvidenceRelations('project-1', { limit: 201 }), /research_relation_limit_invalid/)
    database.run("UPDATE pages SET ocr_text='alpha beta gamma changed' WHERE id='page-1'")
    const changed = modules.repository.upsertResearchEvidence({
      documentId: 'doc-1', sourcePageId: 'page-1', pageNum: 1, start: 6, end: 10, quote: 'beta', projectId: 'project-1', relationKind: 'changed',
    })
    assert.notStrictEqual(changed.evidence.id, evidence.evidence.id)

    database.run("INSERT INTO ai_research_tasks (id,title,goal,status,created_at,updated_at) VALUES ('task-1','T','G','completed','2026-01-01','2026-01-01')")
    database.run("INSERT INTO ai_research_datasets (id,task_id,project_id,name,created_at,updated_at) VALUES ('dataset-1','task-1','project-1','D','2026-01-01','2026-01-01')")
    database.run("INSERT INTO ai_research_records (id,dataset_id,task_id,project_id,doc_id,page_num,excerpt,source_hash,values_json,status,created_at,updated_at) VALUES ('record-1','dataset-1','task-1','project-1','doc-1',1,'beta',?, '{}','pending','2026-01-01','2026-01-01')", [evidence.evidence.source_hash])
    const v1 = modules.repository.commitResearchRecordVersion({ recordId: 'record-1', evidenceId: evidence.evidence.id, values: { subject: 'A' }, status: 'confirmed', note: 'checked', expectedVersion: 0 })
    assert.strictEqual(v1.version, 1)
    assert.throws(() => modules.repository.commitResearchRecordVersion({ recordId: 'record-1', evidenceId: evidence.evidence.id, values: {}, status: 'confirmed', expectedVersion: 0 }), /research_record_version_conflict/)
    assert.strictEqual(database.queryOne('SELECT COUNT(*) AS count FROM research_record_review_events WHERE record_id = ?', ['record-1']).count, 1)

    const aggregateResultJson = '{"totalDocuments":1,"totalHits":1}'
    const aggregateResultHash = createHash('sha256').update(aggregateResultJson).digest('hex')
    const aggregateGeneration = database.queryOne("SELECT generation FROM search_generation_state WHERE scope = 'library'").generation
    database.run("INSERT INTO research_aggregate_artifacts (id,identity_hash,criteria_hash,library_generation,index_generation_vector_hash,exactness,result_json,result_hash,coverage_json,created_at) VALUES ('aggregate-1','aggregate-identity','criteria',?,'vector','exact',?,?, '{}',1)", [aggregateGeneration, aggregateResultJson, aggregateResultHash])
    database.run("INSERT INTO research_aggregate_relations (id,aggregate_id,project_id,relation_kind,label,created_at,updated_at) VALUES ('aggregate-relation-1','aggregate-1','project-1','research-statistic','Count',1,1)")
    const output = modules.repository.createResearchOutputVersion({ projectId: 'project-1', outputType: 'theme_analysis', title: 'Report', content: 'Claim beta', recordIds: ['record-1'], aggregateIds: ['aggregate-1'], claimBindings: [{ start: 0, end: 'Claim beta'.length, evidenceIds: [evidence.evidence.id], aggregateIds: ['aggregate-1'] }] })
    assert.strictEqual(output.version, 1)
    assert.match(output.content_hash, /^[a-f0-9]{64}$/)
    assert.strictEqual(JSON.parse(output.input_manifest_json).aggregateArtifacts[0].aggregateId, 'aggregate-1')
    assert.strictEqual(JSON.parse(database.queryOne('SELECT coverage_json FROM research_claim_manifests WHERE output_version_id = ?', [output.id]).coverage_json).unsupported, 0)
    assert.strictEqual(modules.repository.getResearchClaimManifestPage(output.id, { limit: 1 }).entries.items.length, 1)
    assert.strictEqual(modules.repository.validateResearchClaimManifest(output.id).validation, 'verified')
    const outputCountBeforeRejected = database.queryOne('SELECT COUNT(*) AS count FROM research_output_versions').count
    assert.throws(() => modules.repository.createResearchOutputVersion({ projectId: 'project-1', outputType: 'theme_analysis', title: 'Unsupported formal', content: 'Unsupported claim', recordIds: ['record-1'] }), /research_claim_coverage_incomplete/)
    assert.strictEqual(database.queryOne('SELECT COUNT(*) AS count FROM research_output_versions').count, outputCountBeforeRejected)
    const revised = modules.repository.createResearchOutputVersion({ projectId: 'project-1', outputType: 'theme_analysis', title: 'Report v2', content: 'Claim beta revised', recordIds: ['record-1'], parentVersionId: output.id, claimBindings: [{ start: 0, end: 'Claim beta revised'.length, evidenceIds: [evidence.evidence.id] }] })
    assert.strictEqual(revised.version, 2)
    assert.strictEqual(revised.parent_version_id, output.id)
    database.run("UPDATE pages SET ocr_text='alpha removed gamma' WHERE id='page-1'")
    assert.strictEqual(modules.repository.validateResearchClaimManifest(output.id).validation, 'stale')
    assert.throws(() => modules.repository.createResearchOutputVersion({ projectId: 'project-1', outputType: 'theme_analysis', title: 'Stale', content: 'Stale', recordIds: ['record-1'] }), /research_output_evidence_stale/)
    database.run("UPDATE pages SET ocr_text='alpha beta gamma changed' WHERE id='page-1'")
    const v2 = modules.repository.commitResearchRecordVersion({ recordId: 'record-1', evidenceId: changed.evidence.id, values: { subject: 'A' }, status: 'confirmed', note: 'rechecked', expectedVersion: 1 })
    assert.strictEqual(v2.version, 2)
    assert.throws(() => modules.repository.createResearchOutputVersion({ projectId: 'project-1', outputType: 'theme_analysis', title: 'Stale aggregate', content: 'Bad aggregate', recordIds: ['record-1'], aggregateIds: ['aggregate-1'] }), /research_output_aggregate_invalid/)
    const verifiedV2 = modules.repository.createResearchOutputVersion({ projectId: 'project-1', outputType: 'theme_analysis', title: 'Evidence only', content: 'Current beta', recordIds: ['record-1'], claimBindings: [{ start: 0, end: 'Current beta'.length, evidenceIds: [changed.evidence.id] }] })
    assert.strictEqual(modules.repository.validateResearchClaimManifest(verifiedV2.id).validation, 'verified')
    const finalizableDraft = modules.repository.createResearchOutputVersion({ projectId: 'project-1', outputType: 'theme_analysis', title: 'Review draft', content: 'Reviewed beta', recordIds: ['record-1'], status: 'draft' })
    const draftManifest = database.queryOne('SELECT manifest_hash FROM research_claim_manifests WHERE output_version_id = ?', [finalizableDraft.id])
    assert.throws(() => modules.repository.finalizeResearchOutputVersion({ draftOutputVersionId: finalizableDraft.id, expectedClaimManifestHash: 'wrong', claimBindings: [] }), /research_claim_manifest_conflict/)
    const finalized = modules.repository.finalizeResearchOutputVersion({ draftOutputVersionId: finalizableDraft.id, expectedClaimManifestHash: draftManifest.manifest_hash, claimBindings: [{ start: 0, end: 'Reviewed beta'.length, evidenceIds: [changed.evidence.id] }] })
    assert.strictEqual(finalized.status, 'formal')
    assert.strictEqual(finalized.parent_version_id, finalizableDraft.id)
    assert.strictEqual(modules.repository.validateResearchClaimManifest(finalized.id).validation, 'verified')
    const verifiedV2ManifestId = database.queryOne('SELECT id FROM research_claim_manifests WHERE output_version_id = ?', [verifiedV2.id]).id
    database.run("UPDATE research_claim_entries SET text_hash = 'tampered' WHERE manifest_id = ? AND ordinal = 0", [verifiedV2ManifestId])
    assert.strictEqual(modules.repository.validateResearchClaimManifest(verifiedV2.id).validation, 'corrupt')
    const driftDraft = modules.repository.createResearchOutputVersion({ projectId: 'project-1', outputType: 'theme_analysis', title: 'Drift draft', content: 'Stable input', recordIds: ['record-1'], status: 'draft' })
    const driftManifest = database.queryOne('SELECT manifest_hash FROM research_claim_manifests WHERE output_version_id = ?', [driftDraft.id])
    modules.repository.commitResearchRecordVersion({ recordId: 'record-1', values: { subject: 'changed' }, status: 'pending', expectedVersion: 2 })
    assert.throws(() => modules.repository.finalizeResearchOutputVersion({ draftOutputVersionId: driftDraft.id, expectedClaimManifestHash: driftManifest.manifest_hash, claimBindings: [{ start: 0, end: 'Stable input'.length, evidenceIds: [changed.evidence.id] }] }), /research_output_inputs_changed/)
    assert.throws(() => modules.repository.createResearchOutputVersion({ projectId: 'project-1', outputType: 'theme_analysis', title: 'Bad', content: 'Bad', recordIds: ['missing'] }), /research_output_record_invalid/)
    const draft = modules.repository.createResearchOutputVersion({ projectId: 'project-1', outputType: 'theme_analysis', title: 'Draft', content: 'Draft', recordIds: ['missing'], status: 'draft' })
    assert.strictEqual(draft.status, 'draft')
    assert.strictEqual(JSON.parse(draft.input_manifest_json).coverage.omitted, 1)
    const longDraft = modules.repository.createResearchOutputVersion({ projectId: 'project-1', outputType: 'theme_analysis', title: 'Long draft', content: Array.from({ length: 205 }, (_, index) => `句${index}。`).join(''), recordIds: [], status: 'draft' })
    const claimPage1 = modules.repository.getResearchClaimManifestPage(longDraft.id, { limit: 200 })
    const claimPage2 = modules.repository.getResearchClaimManifestPage(longDraft.id, { limit: 200, cursor: claimPage1.entries.nextCursor })
    assert.strictEqual(claimPage1.entries.items.length, 200)
    assert.strictEqual(claimPage2.entries.items.length, 5)
    assert.strictEqual(claimPage2.entries.nextCursor, null)
    assert.throws(() => modules.repository.getResearchClaimManifestPage(longDraft.id, { limit: 201 }), /research_claim_limit_invalid/)

    database.closeDatabase()
    await database.initDatabase()
    database.closeDatabase()
    database = null
    console.log('Research evidence, record review, and output lineage regression passed.')
  } finally {
    database?.closeDatabase()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

run().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1) })
