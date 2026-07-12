const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8').replace(/\r\n?/g, '\n')
const ocr = read('src', 'main', 'ipc', 'ocr.ts')
const batch = read('src', 'main', 'batch-processor.ts')
const documents = read('src', 'main', 'ipc', 'documents.ts')

assert(!ocr.includes('proofed_text = NULL'), 'OCR execution and reset paths must not delete human proof text.')
assert(!ocr.includes("proofed_text = ? WHERE id = ?', ['processing', 'pending', null"), 'Single-page OCR must preserve proof text and status while processing.')
assert(!batch.includes('ocr_status = ?, proof_status = ? WHERE id = ?'), 'Batch OCR saves must not demote proof status.')
assert(!documents.includes("proofed_text = ?, proofed_text_ref = ?, ocr_status = ?, proof_status = ? WHERE id = ?"), 'OCR version switching must not clear human proof.')
assert(ocr.includes('proof_base_stale') && documents.includes('proof_base_stale'), 'OCR changes and proof saves must maintain the stale/base contract.')
assert((ocr.match(/recordCompatibilityOcrArtifacts\(/g) || []).length >= 2, 'Single-page and batched OCR saves must record immutable compatibility artifacts.')

console.log('OCR human-proof preservation regression passed.')
