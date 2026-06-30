const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const { build } = require('esbuild')
const { Image } = require('@napi-rs/canvas')

const root = path.resolve(__dirname, '..')
process.env.NODE_PATH = [
  path.join(root, 'node_modules'),
  process.env.NODE_PATH || '',
].filter(Boolean).join(path.delimiter)
require('module').Module._initPaths()

const dbPath = path.join(root, 'data', 'db', 'gujismart.db')
const outputRoot = path.join(root, 'data', 'temp', 'ocr-coordinate-real-db')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gujismart-real-ocr-coordinates-'))
const entryPath = path.join(tempRoot, 'entry.js')
const bundlePath = path.join(tempRoot, 'bundle.cjs')
const databaseStubPath = path.join(tempRoot, 'database-stub.js')
const includeAllPages = process.argv.includes('--all-pages')

fs.writeFileSync(databaseStubPath, `
  module.exports = {
    queryOne: () => null,
  }
`)
fs.writeFileSync(entryPath, `
  const ocr = require(${JSON.stringify(path.join(root, 'src', 'main', 'ocr.ts'))})
  const ocrIr = require(${JSON.stringify(path.join(root, 'src', 'shared', 'ocr-ir.ts'))})
  module.exports = {
    normalizeStoredOcrResultForRead: ocr.normalizeStoredOcrResultForRead,
    getOcrPageIr: ocrIr.getOcrPageIr,
    OCR_IR_PIPELINE_VERSION: ocrIr.OCR_IR_PIPELINE_VERSION,
  }
`)

async function prepareBundle() {
  await build({
    entryPoints: [entryPath],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundlePath,
    external: ['@napi-rs/canvas', '@napi-rs/canvas-win32-x64-msvc'],
    alias: {
      electron: path.join(__dirname, 'stubs', 'electron.js'),
      '@electron-toolkit/utils': path.join(__dirname, 'stubs', 'electron-toolkit-utils.js'),
    },
    plugins: [{
      name: 'stub-main-database',
      setup(pluginBuild) {
        pluginBuild.onResolve({ filter: /^\.\/database$/ }, (args) => (
          /src[\\/]main[\\/]ocr\.ts$/.test(args.importer)
            ? { path: databaseStubPath }
            : undefined
        ))
      },
    }],
    logLevel: 'silent',
  })
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function safeName(value) {
  return String(value || 'untitled')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80)
}

function parseJson(value, fallback = null) {
  if (typeof value !== 'string') return value || fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function getImageSize(imagePath) {
  const image = new Image()
  image.src = fs.readFileSync(imagePath)
  return { width: image.width, height: image.height }
}

function getLocation(block) {
  const source = block?.location || block?.__rect || block?.bbox || block?.box || block?.coordinate || block?.points
  if (!source) return null
  if (Array.isArray(source) && source.length >= 4) {
    if (source.length >= 8 && source.every((item) => Number.isFinite(Number(item)))) {
      const xs = []
      const ys = []
      for (let index = 0; index + 1 < source.length; index += 2) {
        xs.push(Number(source[index]))
        ys.push(Number(source[index + 1]))
      }
      const left = Math.min(...xs)
      const top = Math.min(...ys)
      return { left, top, width: Math.max(...xs) - left, height: Math.max(...ys) - top }
    }
    if (source.every((item) => Number.isFinite(Number(item)))) {
      const [left, top, third, fourth] = source.map(Number)
      return third > left && fourth > top
        ? { left, top, width: third - left, height: fourth - top }
        : { left, top, width: third, height: fourth }
    }
    const xs = source.map((point) => Number(point?.x ?? point?.[0])).filter(Number.isFinite)
    const ys = source.map((point) => Number(point?.y ?? point?.[1])).filter(Number.isFinite)
    if (xs.length > 0 && ys.length > 0) {
      const left = Math.min(...xs)
      const top = Math.min(...ys)
      return { left, top, width: Math.max(...xs) - left, height: Math.max(...ys) - top }
    }
  }
  if (typeof source === 'object') {
    const left = Number(source.left ?? source.x)
    const top = Number(source.top ?? source.y)
    const width = Number(source.width ?? source.w)
    const height = Number(source.height ?? source.h)
    if ([left, top, width, height].every(Number.isFinite) && width > 0 && height > 0) {
      return { left, top, width, height }
    }
    const right = Number(source.right ?? source.x2)
    const bottom = Number(source.bottom ?? source.y2)
    if ([left, top, right, bottom].every(Number.isFinite) && right > left && bottom > top) {
      return { left, top, width: right - left, height: bottom - top }
    }
  }
  return null
}

function getBlocks(result) {
  return Array.isArray(result?.layout_result) ? result.layout_result.filter((block) => getLocation(block)) : []
}

function getExtent(blocks) {
  const rects = blocks.map(getLocation).filter(Boolean)
  if (rects.length === 0) return null
  return {
    minLeft: Math.min(...rects.map((rect) => rect.left)),
    minTop: Math.min(...rects.map((rect) => rect.top)),
    maxRight: Math.max(...rects.map((rect) => rect.left + rect.width)),
    maxBottom: Math.max(...rects.map((rect) => rect.top + rect.height)),
    count: rects.length,
  }
}

function getMeta(result) {
  const guji = result?.guji_processing && typeof result.guji_processing === 'object' ? result.guji_processing : {}
  const irPage = result?.gujismart_ir?.page || null
  return {
    source_image_width: result?.source_image_width ?? null,
    source_image_height: result?.source_image_height ?? null,
    service_coordinate_source: guji.service_coordinate_source ?? null,
    service_coordinate_size_source: guji.service_coordinate_size_source ?? null,
    ocr_service_coordinates_preserved: guji.ocr_service_coordinates_preserved === true,
    service_coordinates_aligned_to_local_image: guji.service_coordinates_aligned_to_local_image ?? null,
    service_coordinate_original_width: guji.service_coordinate_original_width ?? null,
    service_coordinate_original_height: guji.service_coordinate_original_height ?? null,
    service_coordinate_align_scale_x: guji.service_coordinate_align_scale_x ?? null,
    service_coordinate_align_scale_y: guji.service_coordinate_align_scale_y ?? null,
    ocr_coordinate_tightened_to_local_ink: guji.ocr_coordinate_tightened_to_local_ink ?? 0,
    ir_pipeline_version: result?.gujismart_ir?.pipelineVersion ?? null,
    ir_width: irPage?.width ?? null,
    ir_height: irPage?.height ?? null,
  }
}

function compareBlocks(before, after) {
  const beforeBlocks = getBlocks(before)
  const afterBlocks = getBlocks(after)
  const count = Math.min(beforeBlocks.length, afterBlocks.length)
  const deltas = []
  for (let index = 0; index < count; index += 1) {
    const left = getLocation(beforeBlocks[index])
    const right = getLocation(afterBlocks[index])
    if (!left || !right) continue
    deltas.push({
      index,
      dx: Math.round(right.left - left.left),
      dy: Math.round(right.top - left.top),
      dw: Math.round(right.width - left.width),
      dh: Math.round(right.height - left.height),
      label: String(afterBlocks[index].label || beforeBlocks[index].label || ''),
    })
  }
  const changed = deltas.filter((delta) => delta.dx || delta.dy || delta.dw || delta.dh)
  const median = (values) => {
    if (values.length === 0) return 0
    const sorted = values.slice().sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)]
  }
  return {
    beforeBlockCount: beforeBlocks.length,
    afterBlockCount: afterBlocks.length,
    changedBlockCount: changed.length,
    medianAbsDx: median(changed.map((delta) => Math.abs(delta.dx))),
    medianAbsDy: median(changed.map((delta) => Math.abs(delta.dy))),
    maxAbsDx: Math.max(0, ...changed.map((delta) => Math.abs(delta.dx))),
    maxAbsDy: Math.max(0, ...changed.map((delta) => Math.abs(delta.dy))),
    samples: changed.slice(0, 8),
  }
}

function writeOverlaySpec(imagePath, result, outputPath, title) {
  const blocks = getBlocks(result).map((block, index) => {
    const rect = getLocation(block)
    return rect
      ? {
        index,
        label: String(block.label || block.type || 'text').slice(0, 18),
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      }
      : null
  }).filter(Boolean)
  const specPath = `${outputPath}.json`
  fs.writeFileSync(specPath, JSON.stringify({ imagePath, outputPath, title, blocks }, null, 2), 'utf8')
  return specPath
}

function drawOverlaySpecsWithPython(specPaths) {
  if (specPaths.length === 0) return
  const python = String.raw`
import json
import pathlib
import sys
from PIL import Image, ImageDraw, ImageFont

colors = ['#f59e0b', '#22c55e', '#38bdf8', '#e879f9', '#ef4444']

try:
    font = ImageFont.truetype('arial.ttf', 16)
except Exception:
    font = ImageFont.load_default()

for spec_path in sys.argv[1:]:
    spec = json.loads(pathlib.Path(spec_path).read_text(encoding='utf-8'))
    image = Image.open(spec['imagePath']).convert('RGB')
    draw = ImageDraw.Draw(image, 'RGBA')
    line_width = max(2, round(image.width / 700))
    for block in spec['blocks']:
        color = colors[block['index'] % len(colors)]
        left = round(block['left'])
        top = round(block['top'])
        right = round(block['left'] + block['width'])
        bottom = round(block['top'] + block['height'])
        draw.rectangle([left, top, right, bottom], outline=color, width=line_width)
        label = f"{block['index']}:{block['label']}"
        bbox = draw.textbbox((left, max(0, top - 19)), label, font=font)
        draw.rectangle([bbox[0] - 2, bbox[1] - 2, bbox[2] + 4, bbox[3] + 2], fill=color + 'dd')
        draw.text((left + 1, max(0, top - 19)), label, font=font, fill=(17, 24, 39, 255))
    title = spec.get('title') or ''
    if title:
        bbox = draw.textbbox((12, 10), title, font=font)
        draw.rectangle([8, 8, min(image.width - 8, bbox[2] + 12), bbox[3] + 8], fill=(17, 24, 39, 220))
        draw.text((12, 10), title, font=font, fill=(255, 255, 255, 255))
    image.save(spec['outputPath'], quality=90)
`
  const result = spawnSync('python', ['-c', python, ...specPaths], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
    },
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `Python overlay drawing failed with ${result.status}`)
}

function loadRealDatabaseSample(requestedIds, options = {}) {
  const python = String.raw`
import gzip
import json
import pathlib
import sqlite3
import sys

root = pathlib.Path.cwd()
db_path = root / 'data' / 'db' / 'gujismart.db'
requested_ids = json.loads(sys.argv[1])
include_all_pages = sys.argv[2] == '1'
con = sqlite3.connect(db_path)
con.row_factory = sqlite3.Row

def parse_json(value):
    if not value:
        return None
    try:
        return json.loads(value)
    except Exception:
        return None

def hydrate(row):
    inline = parse_json(row['ocr_result'])
    if not (isinstance(inline, dict) and inline.get('externalized')):
        return inline
    ref = (row['ocr_result_ref'] or '').strip()
    if not ref.startswith('page-payload:v2:'):
        return inline
    payload_path = root / 'data' / 'storage' / 'page-payloads' / ref[len('page-payload:v2:'):]
    if payload_path.suffix == '.gz':
        raw = gzip.decompress(payload_path.read_bytes()).decode('utf-8')
    else:
        raw = payload_path.read_text('utf-8')
    outer = parse_json(raw) or {}
    value = outer.get('value')
    return parse_json(value) if isinstance(value, str) else value

if requested_ids:
    docs = [
        dict(row) for row in con.execute(
            'SELECT id, title FROM documents WHERE id IN (%s)' % ','.join('?' for _ in requested_ids),
            requested_ids,
        )
    ]
    docs.sort(key=lambda item: requested_ids.index(item['id']) if item['id'] in requested_ids else 9999)
else:
    docs = [
        dict(row) for row in con.execute('''
            SELECT DISTINCT d.id, d.title, d.updated_at
            FROM documents d
            JOIN pages p ON p.doc_id = d.id
            WHERE d.ocr_status = 'completed'
              AND (p.ocr_result IS NOT NULL OR p.ocr_result_ref IS NOT NULL)
              AND p.image_path IS NOT NULL
              AND TRIM(p.image_path) <> ''
            ORDER BY d.updated_at DESC
            LIMIT 6
        ''')
    ]

for doc in docs:
    rows = [dict(row) for row in con.execute('''
        SELECT id, doc_id, page_num, image_path, ocr_result, ocr_result_ref
        FROM pages
        WHERE doc_id = ?
          AND (ocr_result IS NOT NULL OR ocr_result_ref IS NOT NULL)
          AND image_path IS NOT NULL
          AND TRIM(image_path) <> ''
        ORDER BY page_num
    ''', (doc['id'],))]
    selected = []
    indexes = range(len(rows)) if include_all_pages else list(range(min(2, len(rows)))) + list(range(max(0, len(rows)//2 - 1), min(len(rows), len(rows)//2 + 1))) + ([len(rows)-1] if rows else [])
    for index in indexes:
        if index >= 0 and index < len(rows) and rows[index]['id'] not in {page['id'] for page in selected}:
            page = rows[index]
            page['ocr_payload'] = hydrate(page)
            page.pop('ocr_result', None)
            page.pop('ocr_result_ref', None)
            selected.append(page)
    doc['pages'] = selected
    doc['page_count'] = len(rows)

print(json.dumps({'documents': docs}, ensure_ascii=False))
`
  const result = spawnSync('python', ['-c', python, JSON.stringify(requestedIds), options.includeAllPages ? '1' : '0'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
    },
    maxBuffer: 128 * 1024 * 1024,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `Python sqlite diagnostic failed with ${result.status}`)
  }
  return parseJson(result.stdout, { documents: [] })
}

function run() {
  assert.ok(fs.existsSync(dbPath), `Database not found: ${dbPath}`)
  ensureDir(outputRoot)
  const { normalizeStoredOcrResultForRead, getOcrPageIr, OCR_IR_PIPELINE_VERSION } = require(bundlePath)
  const requestedIds = process.argv.slice(2).filter((arg) => !arg.startsWith('--'))
  const docs = loadRealDatabaseSample(requestedIds, { includeAllPages }).documents || []
  const report = {
    generatedAt: new Date().toISOString(),
    dbPath,
    outputRoot,
    includeAllPages,
    pipelineVersion: OCR_IR_PIPELINE_VERSION,
    documents: [],
  }
  const overlaySpecs = []

  for (const doc of docs) {
    const docDir = path.join(outputRoot, `${safeName(doc.title)}_${doc.id}`)
    ensureDir(docDir)
    const docReport = { id: doc.id, title: doc.title, pageCount: doc.page_count || doc.pages?.length || 0, pages: [] }
    report.documents.push(docReport)

    for (const page of doc.pages || []) {
      if (!fs.existsSync(page.image_path)) continue
      const before = page.ocr_payload
      if (!before) continue
      const imageSize = getImageSize(page.image_path)
      const after = normalizeStoredOcrResultForRead(before, page.image_path, Number(page.page_num || 0) || 1)
      const beforeIr = getOcrPageIr(before)
      const afterIr = getOcrPageIr(after)
      const beforeMeta = getMeta(before)
      const afterMeta = getMeta(after)
      const diff = compareBlocks(before, after)
      const pageTag = `page_${String(page.page_num).padStart(3, '0')}`
      const beforeOverlay = path.join(docDir, `${pageTag}_before.jpg`)
      const afterOverlay = path.join(docDir, `${pageTag}_after.jpg`)
      overlaySpecs.push(writeOverlaySpec(page.image_path, before, beforeOverlay, `before p${page.page_num}`))
      overlaySpecs.push(writeOverlaySpec(page.image_path, after, afterOverlay, `after p${page.page_num}`))
      const pageReport = {
        id: page.id,
        pageNum: page.page_num,
        imagePath: page.image_path,
        imageSize,
        before: {
          meta: beforeMeta,
          extent: getExtent(getBlocks(before)),
          ir: beforeIr?.page ? { width: beforeIr.page.width, height: beforeIr.page.height, pipelineVersion: beforeIr.pipelineVersion } : null,
          overlay: beforeOverlay,
        },
        after: {
          meta: afterMeta,
          extent: getExtent(getBlocks(after)),
          ir: afterIr?.page ? { width: afterIr.page.width, height: afterIr.page.height, pipelineVersion: afterIr.pipelineVersion } : null,
          overlay: afterOverlay,
        },
        diff,
      }
      docReport.pages.push(pageReport)
      const aligned = afterMeta.ocr_service_coordinates_preserved
        ? afterMeta.service_coordinate_size_source === 'local_page_image'
          && afterMeta.source_image_width === imageSize.width
          && afterMeta.source_image_height === imageSize.height
          && afterIr?.page?.width === imageSize.width
          && afterIr?.page?.height === imageSize.height
        : true
      pageReport.pass = aligned
    }
  }

  report.summary = {
    documentCount: report.documents.length,
    pageCount: report.documents.reduce((sum, doc) => sum + doc.pages.length, 0),
    failedPages: report.documents.flatMap((doc) => doc.pages.filter((page) => !page.pass).map((page) => ({ docId: doc.id, pageNum: page.pageNum }))),
  }
  drawOverlaySpecsWithPython(overlaySpecs)
  const reportPath = path.join(outputRoot, 'report.json')
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8')
  console.log(JSON.stringify({
    reportPath,
    outputRoot,
    documentCount: report.summary.documentCount,
    pageCount: report.summary.pageCount,
    failedPages: report.summary.failedPages,
  }, null, 2))
  if (report.summary.failedPages.length > 0) process.exitCode = 1
}

prepareBundle()
  .then(() => run())
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  })
