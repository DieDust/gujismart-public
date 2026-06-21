const fs = require('fs')
const os = require('os')
const path = require('path')
const Database = require('better-sqlite3')
const { app } = require('electron')

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gujismart-search-index-atomic-'))
const dbPath = path.join(tempDir, 'regression.db')
function run() {
  const db = new Database(dbPath)
  let ftsAvailable = true
  try {
    db.exec(`
      CREATE TABLE search_index_segments (
      segment_id TEXT PRIMARY KEY,
      doc_id TEXT NOT NULL,
      page_id TEXT,
      page_num INTEGER,
      source_kind TEXT DEFAULT 'page',
      href TEXT,
      title TEXT,
      ordinal INTEGER DEFAULT 0,
      source_start INTEGER DEFAULT 0,
      text TEXT DEFAULT '',
      normalized_text TEXT DEFAULT '',
      offset_map TEXT DEFAULT '',
      text_hash TEXT DEFAULT '',
      updated_at TEXT
    );

    CREATE TABLE search_ngram_index (
      gram TEXT NOT NULL,
      segment_id TEXT NOT NULL,
      doc_id TEXT NOT NULL,
      positions TEXT NOT NULL,
      hit_count INTEGER DEFAULT 0,
      PRIMARY KEY (gram, segment_id)
    );

    CREATE TABLE search_index_segments_staging (
      job_id TEXT NOT NULL,
      segment_id TEXT NOT NULL,
      doc_id TEXT NOT NULL,
      page_id TEXT,
      page_num INTEGER,
      source_kind TEXT DEFAULT 'page',
      href TEXT,
      title TEXT,
      ordinal INTEGER DEFAULT 0,
      source_start INTEGER DEFAULT 0,
      text TEXT DEFAULT '',
      normalized_text TEXT DEFAULT '',
      offset_map TEXT DEFAULT '',
      text_hash TEXT DEFAULT '',
      updated_at TEXT,
      PRIMARY KEY (job_id, segment_id)
    );

    CREATE TABLE search_ngram_index_staging (
      job_id TEXT NOT NULL,
      gram TEXT NOT NULL,
      segment_id TEXT NOT NULL,
      doc_id TEXT NOT NULL,
      positions TEXT NOT NULL,
      hit_count INTEGER DEFAULT 0,
      PRIMARY KEY (job_id, gram, segment_id)
    );

    CREATE TABLE search_index_status (
      doc_id TEXT PRIMARY KEY,
      status TEXT DEFAULT 'pending',
      source_hash TEXT DEFAULT '',
      segment_count INTEGER DEFAULT 0,
      error_message TEXT,
      indexed_at TEXT,
      updated_at TEXT
    );
  `)

  try {
    db.exec(`
      CREATE VIRTUAL TABLE search_segments_fts USING fts5(
        segment_id UNINDEXED,
        doc_id UNINDEXED,
        title,
        normalized_text,
        content='search_index_segments',
        content_rowid='rowid'
      );
    `)
  } catch {
    ftsAvailable = false
  }

  const docId = 'doc-1'
  const oldSegmentId = 'doc-1:old:0'
  const newSegmentId = 'doc-1:new:0'
  const jobId = 'job-1'
  const now = new Date().toISOString()

  db.prepare(`
    INSERT INTO search_index_segments (
      segment_id, doc_id, page_id, page_num, source_kind, href, title, ordinal, source_start, text, normalized_text, offset_map, text_hash, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(oldSegmentId, docId, 'page-old', 1, 'page', null, 'old', 0, 0, 'old text', 'old text', '[]', 'old-hash', now)
  db.prepare('INSERT INTO search_ngram_index (gram, segment_id, doc_id, positions, hit_count) VALUES (?, ?, ?, ?, ?)').run('token', oldSegmentId, docId, '[0,1,2]', 3)
  db.prepare('INSERT INTO search_index_status (doc_id, status, source_hash, segment_count, error_message, indexed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(docId, 'ready', 'old-source', 1, null, now, now)
  if (ftsAvailable) {
    db.prepare('INSERT INTO search_segments_fts (rowid, title, normalized_text) VALUES (?, ?, ?)').run(1, 'old', 'old text')
  }

  db.prepare(`
    INSERT INTO search_index_segments_staging (
      job_id, segment_id, doc_id, page_id, page_num, source_kind, href, title, ordinal, source_start, text, normalized_text, offset_map, text_hash, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(jobId, newSegmentId, docId, 'page-new', 2, 'page', null, 'new', 0, 0, 'new text', 'new text', '[]', 'new-hash', now)
  db.prepare('INSERT INTO search_ngram_index_staging (job_id, gram, segment_id, doc_id, positions, hit_count) VALUES (?, ?, ?, ?, ?, ?)').run(jobId, 'token', newSegmentId, docId, '[0,1,2,3,4]', 5)

  const liveHits = () => Number(db.prepare('SELECT COALESCE(SUM(hit_count), 0) AS hits FROM search_ngram_index WHERE doc_id = ? AND gram = ?').get(docId, 'token').hits)
  const liveSegments = () => Number(db.prepare('SELECT COUNT(*) AS count FROM search_index_segments WHERE doc_id = ?').get(docId).count)
  const stagingRows = () => Number(db.prepare('SELECT COUNT(*) AS count FROM search_index_segments_staging WHERE job_id = ?').get(jobId).count)

  assert(liveHits() === 3, 'staged rows changed live ngram hit count before commit')
  assert(liveSegments() === 1, 'staged rows changed live segment count before commit')
  assert(stagingRows() === 1, 'staging rows were not created')

  const failingSwap = db.transaction(() => {
    if (ftsAvailable) {
      db.prepare(`
        INSERT INTO search_segments_fts(search_segments_fts, rowid, title, normalized_text)
        SELECT 'delete', rowid, COALESCE(title, ''), COALESCE(normalized_text, text, '')
        FROM search_index_segments
        WHERE doc_id = ? AND TRIM(COALESCE(normalized_text, text, '')) != ''
      `).run(docId)
    }
    db.prepare('DELETE FROM search_ngram_index WHERE doc_id = ?').run(docId)
    db.prepare('DELETE FROM search_index_segments WHERE doc_id = ?').run(docId)
    throw new Error('simulated failure before staged rows are promoted')
  })
  try {
    failingSwap()
  } catch {
    // Expected: the transaction must roll back and keep the prior live index.
  }
  assert(liveHits() === 3, 'failed swap did not preserve old ngram index')
  assert(liveSegments() === 1, 'failed swap did not preserve old segments')

  const successfulSwap = db.transaction(() => {
    if (ftsAvailable) {
      db.prepare(`
        INSERT INTO search_segments_fts(search_segments_fts, rowid, title, normalized_text)
        SELECT 'delete', rowid, COALESCE(title, ''), COALESCE(normalized_text, text, '')
        FROM search_index_segments
        WHERE doc_id = ? AND TRIM(COALESCE(normalized_text, text, '')) != ''
      `).run(docId)
    }
    db.prepare('DELETE FROM search_ngram_index WHERE doc_id = ?').run(docId)
    db.prepare('DELETE FROM search_index_segments WHERE doc_id = ?').run(docId)
    db.prepare(`
      INSERT INTO search_index_segments (
        segment_id, doc_id, page_id, page_num, source_kind, href, title, ordinal, source_start, text, normalized_text, offset_map, text_hash, updated_at
      )
      SELECT segment_id, doc_id, page_id, page_num, source_kind, href, title, ordinal, source_start, text, normalized_text, offset_map, text_hash, updated_at
      FROM search_index_segments_staging
      WHERE job_id = ?
      ORDER BY ordinal ASC
    `).run(jobId)
    db.prepare(`
      INSERT INTO search_ngram_index (gram, segment_id, doc_id, positions, hit_count)
      SELECT gram, segment_id, doc_id, positions, hit_count
      FROM search_ngram_index_staging
      WHERE job_id = ?
    `).run(jobId)
    if (ftsAvailable) {
      db.prepare(`
        INSERT INTO search_segments_fts (rowid, title, normalized_text)
        SELECT rowid, COALESCE(title, ''), COALESCE(normalized_text, text, '')
        FROM search_index_segments
        WHERE doc_id = ? AND TRIM(COALESCE(normalized_text, text, '')) != ''
      `).run(docId)
    }
    db.prepare(`
      INSERT INTO search_index_status (doc_id, status, source_hash, segment_count, error_message, indexed_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(doc_id) DO UPDATE SET
        status = excluded.status,
        source_hash = excluded.source_hash,
        segment_count = excluded.segment_count,
        error_message = excluded.error_message,
        indexed_at = excluded.indexed_at,
        updated_at = excluded.updated_at
    `).run(docId, 'ready', 'new-source', 1, null, now, now)
    db.prepare('DELETE FROM search_ngram_index_staging WHERE job_id = ?').run(jobId)
    db.prepare('DELETE FROM search_index_segments_staging WHERE job_id = ?').run(jobId)
  })
  successfulSwap()

  assert(liveHits() === 5, 'successful swap did not promote staged ngram rows')
  assert(liveSegments() === 1, 'successful swap produced wrong segment count')
  assert(stagingRows() === 0, 'successful swap did not clean staged segment rows')
  if (ftsAvailable) {
    const ftsRows = Number(db.prepare(`
      SELECT COUNT(*) AS count
      FROM search_segments_fts fts
      INNER JOIN search_index_segments s ON s.rowid = fts.rowid
      WHERE s.doc_id = ?
    `).get(docId).count)
    assert(ftsRows === 1, 'successful swap did not rebuild FTS rows')
  }

    console.log('search index atomic swap regression passed')
  } finally {
    db.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

Promise.resolve()
  .then(run)
  .then(() => {
    app.quit()
    process.exit(0)
  })
  .catch((error) => {
    console.error(error)
    app.quit()
    process.exit(1)
  })
