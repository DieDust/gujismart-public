const assert = require('assert')
const { mkdtempSync, rmSync, writeFileSync } = require('fs')
const { join } = require('path')
const { build } = require('esbuild')
const { PDFDocument } = require('pdf-lib')

const tempRoot = mkdtempSync(join(__dirname, '.tmp-ocr-pdf-resume-'))
const bundlePath = join(tempRoot, 'ocr-pdf-resume-bundle.cjs')
const entryPath = join(tempRoot, 'ocr-pdf-resume-entry.js')
const databaseStubPath = join(tempRoot, 'database-stub.js')
const settingsSecurityStubPath = join(tempRoot, 'settings-security-stub.js')

writeFileSync(databaseStubPath, `
  const settings = new Map([
    ['paddleocr_api_key', 'test-token'],
    ['paddleocr_token_pool', JSON.stringify({
      version: 1,
      primaryLabel: 'Account 1',
      primaryEnabled: true,
      entries: [{
        id: '11111111-1111-1111-1111-111111111111',
        label: 'Account 2',
        enabled: true,
      }],
    })],
    ['ocr_async_model', 'PaddleOCR-VL-1.6'],
    ['ocr_async_pdf_chunk_concurrency', '1'],
    ['ocr_upload_timeout_seconds', '10'],
  ])

  exports.queryOne = function queryOne(sql, params) {
    const text = String(sql || '')
    const key = Array.isArray(params) && params.length > 0
      ? String(params[0])
      : Array.from(settings.keys()).find((item) => text.includes(item))
    if (key === 'ocr_async_pdf_chunk_concurrency' && process.env.GUJISMART_TEST_OCR_CHUNK_CONCURRENCY) {
      return { value: process.env.GUJISMART_TEST_OCR_CHUNK_CONCURRENCY }
    }
    return key && settings.has(key) ? { value: settings.get(key) } : null
  }
  exports.run = () => ({ changes: 1 })
  exports.getDataDir = () => ${JSON.stringify(tempRoot)}
`)

writeFileSync(settingsSecurityStubPath, `
  exports.readProtectedSetting = (key) => key === 'paddleocr_api_key'
    ? 'test-token'
    : key === 'paddleocr_token:11111111-1111-1111-1111-111111111111'
    ? 'backup-token'
    : ''
  exports.getCredentialPublicState = () => ({ configured: true, version: 1, state: 'available', last4: 'oken' })
  exports.writeProtectedSetting = () => ({ configured: true, version: 1, state: 'available', last4: 'oken' })
  exports.revokeProtectedSetting = () => true
`)

writeFileSync(entryPath, `
  const ocr = require(${JSON.stringify(join(__dirname, '..', 'src', 'main', 'ocr.ts'))})
  module.exports = { ocr }
`)

async function buildBundle() {
  await build({
    entryPoints: [entryPath],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundlePath,
    external: ['better-sqlite3', 'pdf-lib', '@napi-rs/canvas'],
    alias: {
      electron: join(__dirname, 'stubs', 'electron.js'),
    },
    plugins: [{
      name: 'stub-database',
      setup(build) {
        build.onResolve({ filter: /^\.\/database$/ }, (args) => {
          const importer = args.importer.replace(/\\/g, '/')
          if (importer.endsWith('/src/main/ocr.ts') || importer.endsWith('/src/main/paddle-ocr-token-pool.ts')) {
            return { path: databaseStubPath }
          }
          return null
        })
        build.onResolve({ filter: /^\.\/settings-security$/ }, (args) => {
          if (args.importer.replace(/\\/g, '/').endsWith('/src/main/paddle-ocr-token-pool.ts')) {
            return { path: settingsSecurityStubPath }
          }
          return null
        })
      },
    }],
    logLevel: 'silent',
  })
}

async function createTestPdf(filePath, pageCount = 5) {
  const pdf = await PDFDocument.create()
  for (let pageNum = 1; pageNum <= pageCount; pageNum += 1) {
    pdf.addPage([200 + pageNum, 300 + pageNum])
  }
  writeFileSync(filePath, Buffer.from(await pdf.save()))
}

async function readUploadedPdf(body) {
  assert.ok(body && typeof body.get === 'function', 'expected FormData upload body')
  const file = body.get('file')
  assert.ok(file && typeof file.arrayBuffer === 'function', 'expected uploaded PDF file')
  const pdf = await PDFDocument.load(Buffer.from(await file.arrayBuffer()))
  return {
    name: file.name,
    pageCount: pdf.getPageCount(),
    sizes: pdf.getPages().map((page) => ({
      width: page.getWidth(),
      height: page.getHeight(),
    })),
  }
}

function installMockAsyncFetch() {
  const uploads = []
  let jobIndex = 0

  global.fetch = async (input, init = {}) => {
    const url = String(input)
    const method = String(init.method || 'GET').toUpperCase()

    if (method === 'POST' && url.includes('/api/v2/ocr/jobs')) {
      const upload = await readUploadedPdf(init.body)
      const jobId = `job-${jobIndex}`
      jobIndex += 1
      uploads.push({ jobId, ...upload })
      return new Response(JSON.stringify({ data: { jobId } }), { status: 200 })
    }

    if (method === 'GET' && url.includes('/api/v2/ocr/jobs/')) {
      const jobId = url.slice(url.lastIndexOf('/') + 1)
      const upload = uploads.find((item) => item.jobId === jobId)
      assert.ok(upload, `unknown job id ${jobId}`)
      return new Response(JSON.stringify({
        data: {
          status: 'completed',
          completedPages: upload.pageCount,
          totalPages: upload.pageCount,
          jsonUrl: `mock://result/${jobId}`,
        },
      }), { status: 200 })
    }

    if (method === 'GET' && url.startsWith('mock://result/')) {
      const jobId = url.slice(url.lastIndexOf('/') + 1)
      const upload = uploads.find((item) => item.jobId === jobId)
      assert.ok(upload, `unknown result job id ${jobId}`)
      return new Response(JSON.stringify({
        layoutParsingResults: Array.from({ length: upload.pageCount }, (_, index) => ({
          markdown: `page ${index + 1}`,
        })),
      }), { status: 200 })
    }

    throw new Error(`unexpected fetch: ${method} ${url}`)
  }

  return uploads
}

function installIncompleteChunkFetch() {
  const uploads = []
  let jobIndex = 0

  global.fetch = async (input, init = {}) => {
    const url = String(input)
    const method = String(init.method || 'GET').toUpperCase()

    if (method === 'POST' && url.includes('/api/v2/ocr/jobs')) {
      const upload = await readUploadedPdf(init.body)
      const jobId = `incomplete-job-${jobIndex}`
      jobIndex += 1
      uploads.push({ jobId, ...upload })
      return new Response(JSON.stringify({ data: { jobId } }), { status: 200 })
    }

    if (method === 'GET' && url.includes('/api/v2/ocr/jobs/incomplete-job-')) {
      const jobId = url.slice(url.lastIndexOf('/') + 1)
      const upload = uploads.find((item) => item.jobId === jobId)
      assert.ok(upload, `unknown incomplete job id ${jobId}`)
      return new Response(JSON.stringify({
        data: {
          status: 'completed',
          completedPages: upload.pageCount,
          totalPages: upload.pageCount,
          jsonUrl: `mock://incomplete-result/${jobId}`,
        },
      }), { status: 200 })
    }

    if (method === 'GET' && url.startsWith('mock://incomplete-result/')) {
      const jobId = url.slice(url.lastIndexOf('/') + 1)
      const upload = uploads.find((item) => item.jobId === jobId)
      assert.ok(upload, `unknown incomplete result job id ${jobId}`)
      const resultCount = jobId === 'incomplete-job-0'
        ? Math.max(0, upload.pageCount - 1)
        : upload.pageCount
      return new Response(JSON.stringify({
        layoutParsingResults: Array.from({ length: resultCount }, (_, index) => ({
          markdown: `recovered page ${index + 1}`,
        })),
      }), { status: 200 })
    }

    throw new Error(`unexpected incomplete fetch: ${method} ${url}`)
  }

  return uploads
}

function installPersistentMiddleChunkFailureFetch() {
  const uploads = []
  let jobIndex = 0

  global.fetch = async (input, init = {}) => {
    const url = String(input)
    const method = String(init.method || 'GET').toUpperCase()

    if (method === 'POST' && url.includes('/api/v2/ocr/jobs')) {
      const upload = await readUploadedPdf(init.body)
      const jobId = `middle-failure-job-${jobIndex}`
      jobIndex += 1
      uploads.push({ jobId, ...upload })
      return new Response(JSON.stringify({ data: { jobId } }), { status: 200 })
    }

    if (method === 'GET' && url.includes('/api/v2/ocr/jobs/middle-failure-job-')) {
      const jobId = url.slice(url.lastIndexOf('/') + 1)
      const upload = uploads.find((item) => item.jobId === jobId)
      assert.ok(upload, `unknown middle failure job id ${jobId}`)
      return new Response(JSON.stringify({
        data: {
          status: 'completed',
          completedPages: upload.pageCount,
          totalPages: upload.pageCount,
          jsonUrl: `mock://middle-failure-result/${jobId}`,
        },
      }), { status: 200 })
    }

    if (method === 'GET' && url.startsWith('mock://middle-failure-result/')) {
      const jobId = url.slice(url.lastIndexOf('/') + 1)
      const upload = uploads.find((item) => item.jobId === jobId)
      assert.ok(upload, `unknown middle failure result job id ${jobId}`)
      const isMiddleChunk = upload.sizes[0]?.width === 301
      const resultCount = isMiddleChunk ? Math.max(0, upload.pageCount - 1) : upload.pageCount
      return new Response(JSON.stringify({
        layoutParsingResults: Array.from({ length: resultCount }, (_, index) => ({
          markdown: `chunk page ${index + 1}`,
        })),
      }), { status: 200 })
    }

    throw new Error(`unexpected middle failure fetch: ${method} ${url}`)
  }

  return uploads
}

function installTokenFailoverFetch() {
  const uploads = []
  const submissionTokens = []
  let jobIndex = 0
  let rejectedPrimaryAfterFirstChunk = false

  global.fetch = async (input, init = {}) => {
    const url = String(input)
    const method = String(init.method || 'GET').toUpperCase()

    if (method === 'POST' && url.includes('/api/v2/ocr/jobs')) {
      const token = String(new Headers(init.headers).get('authorization') || '').replace(/^Bearer\s+/i, '')
      submissionTokens.push(token)
      const upload = await readUploadedPdf(init.body)
      if (uploads.length === 1 && token === 'test-token' && !rejectedPrimaryAfterFirstChunk) {
        rejectedPrimaryAfterFirstChunk = true
        return new Response(JSON.stringify({ error_code: 429, error_msg: 'daily page quota exceeded' }), { status: 429 })
      }
      const jobId = `failover-job-${jobIndex}`
      jobIndex += 1
      uploads.push({ jobId, token, ...upload })
      return new Response(JSON.stringify({ data: { jobId } }), { status: 200 })
    }

    if (method === 'GET' && url.includes('/api/v2/ocr/jobs/')) {
      const jobId = url.slice(url.lastIndexOf('/') + 1)
      const upload = uploads.find((item) => item.jobId === jobId)
      assert.ok(upload, `unknown failover job id ${jobId}`)
      return new Response(JSON.stringify({
        data: {
          status: 'completed',
          completedPages: upload.pageCount,
          totalPages: upload.pageCount,
          jsonUrl: `mock://failover-result/${jobId}`,
        },
      }), { status: 200 })
    }

    if (method === 'GET' && url.startsWith('mock://failover-result/')) {
      const jobId = url.slice(url.lastIndexOf('/') + 1)
      const upload = uploads.find((item) => item.jobId === jobId)
      assert.ok(upload, `unknown failover result job id ${jobId}`)
      return new Response(JSON.stringify({
        layoutParsingResults: Array.from({ length: upload.pageCount }, (_, index) => ({
          markdown: `chunk page ${index + 1}`,
        })),
      }), { status: 200 })
    }

    throw new Error(`unexpected failover fetch: ${method} ${url}`)
  }

  return { uploads, submissionTokens }
}

function installRegressingProgressFetch() {
  const uploads = []
  let jobIndex = 0
  let pollCount = 0

  global.fetch = async (input, init = {}) => {
    const url = String(input)
    const method = String(init.method || 'GET').toUpperCase()

    if (method === 'POST' && url.includes('/api/v2/ocr/jobs')) {
      const upload = await readUploadedPdf(init.body)
      const jobId = `job-${jobIndex}`
      jobIndex += 1
      uploads.push({ jobId, ...upload })
      return new Response(JSON.stringify({ data: { jobId } }), { status: 200 })
    }

    if (method === 'GET' && url.includes('/api/v2/ocr/jobs/')) {
      const jobId = url.slice(url.lastIndexOf('/') + 1)
      const upload = uploads.find((item) => item.jobId === jobId)
      assert.ok(upload, `unknown job id ${jobId}`)
      pollCount += 1
      const completedPages = pollCount === 1 ? 4 : pollCount === 2 ? 2 : upload.pageCount
      return new Response(JSON.stringify({
        data: {
          status: pollCount >= 3 ? 'completed' : 'processing',
          completedPages,
          totalPages: upload.pageCount,
          jsonUrl: pollCount >= 3 ? `mock://result/${jobId}` : undefined,
        },
      }), { status: 200 })
    }

    if (method === 'GET' && url.startsWith('mock://result/')) {
      const jobId = url.slice(url.lastIndexOf('/') + 1)
      const upload = uploads.find((item) => item.jobId === jobId)
      assert.ok(upload, `unknown result job id ${jobId}`)
      return new Response(JSON.stringify({
        layoutParsingResults: Array.from({ length: upload.pageCount }, (_, index) => ({
          markdown: `page ${index + 1}`,
        })),
      }), { status: 200 })
    }

    throw new Error(`unexpected fetch: ${method} ${url}`)
  }
}

function installStalledProgressFetch() {
  let uploaded = false

  global.fetch = async (input, init = {}) => {
    const url = String(input)
    const method = String(init.method || 'GET').toUpperCase()

    if (method === 'POST' && url.includes('/api/v2/ocr/jobs')) {
      await readUploadedPdf(init.body)
      uploaded = true
      return new Response(JSON.stringify({ data: { jobId: 'job-stalled' } }), { status: 200 })
    }

    if (method === 'GET' && url.includes('/api/v2/ocr/jobs/job-stalled')) {
      assert.ok(uploaded, 'expected upload before polling')
      return new Response(JSON.stringify({
        data: {
          status: 'processing',
          completedPages: 0,
          totalPages: 1,
          progress: 0,
        },
      }), { status: 200 })
    }

    throw new Error(`unexpected fetch: ${method} ${url}`)
  }
}

async function withFastPollTimers(fn) {
  const originalDateNow = Date.now
  const originalSetTimeout = global.setTimeout
  let fakeNow = 0
  Date.now = () => fakeNow
  global.setTimeout = (callback, ms, ...args) => {
    if (ms === 5000) {
      fakeNow += 11 * 60 * 1000
      return originalSetTimeout(callback, 0, ...args)
    }
    return originalSetTimeout(callback, ms, ...args)
  }

  try {
    return await fn()
  } finally {
    Date.now = originalDateNow
    global.setTimeout = originalSetTimeout
  }
}

async function runResumeScenario(ocr, pdfPath) {
  const uploads = installMockAsyncFetch()
  const progressEvents = []

  const chunks = []
  const results = await ocr.recognizePdfAsync(pdfPath, (payload) => {
    progressEvents.push(payload)
  }, {
    model: 'PaddleOCR-VL-1.6',
    targetPageNums: [3, 5],
    onChunkComplete: (chunk) => {
      chunks.push({
        pageCount: chunk.pageCount,
        totalPages: chunk.totalPages,
        sourcePageIndexes: chunk.sourcePageIndexes,
        resultCount: chunk.results.length,
      })
    },
  })

  assert.strictEqual(results.length, 2)
  assert.deepStrictEqual(results.map((result) => result && result.markdown), ['page 3', 'page 5'])
  assert.strictEqual(uploads.length, 1)
  assert.strictEqual(uploads[0].pageCount, 5)
  assert.deepStrictEqual(uploads[0].sizes, [
    { width: 201, height: 301 },
    { width: 202, height: 302 },
    { width: 203, height: 303 },
    { width: 204, height: 304 },
    { width: 205, height: 305 },
  ])
  assert.deepStrictEqual(chunks, [{
    pageCount: 2,
    totalPages: 5,
    sourcePageIndexes: [2, 4],
    resultCount: 2,
  }])
  assert.ok(progressEvents.some((payload) => payload.chunkStartPage === 3 && payload.chunkEndPage === 5))
  assert.ok(progressEvents.some((payload) => payload.fullFileUpload === true && payload.uploadPageCount === 2))
  assert.ok(!progressEvents.some((payload) => payload.fallbackWholePdf === true))
}

async function runRegressingProgressScenario(ocr, pdfPath) {
  installRegressingProgressFetch()
  const progressEvents = []

  await withFastPollTimers(async () => {
    const results = await ocr.recognizePdfAsync(pdfPath, (payload) => {
      progressEvents.push(payload)
    }, {
      model: 'PaddleOCR-VL-1.6',
      targetPageNums: [1, 2, 3, 4, 5],
    })
    assert.strictEqual(results.length, 5)
  })

  const completedPages = progressEvents
    .filter((payload) => Number.isFinite(Number(payload.completedPages)))
    .map((payload) => Number(payload.completedPages))
  for (let index = 1; index < completedPages.length; index += 1) {
    assert.ok(
      completedPages[index] >= completedPages[index - 1],
      `expected async PDF progress to be monotonic: ${completedPages.join(', ')}`,
    )
  }
}

async function runQpdfChunkingScenario(ocr, pdfPath) {
  const uploads = installMockAsyncFetch()
  const progressEvents = []
  const originalCopyPages = PDFDocument.prototype.copyPages
  PDFDocument.prototype.copyPages = async () => {
    throw new Error('pdf-lib copyPages should not be used when qpdf chunking succeeds')
  }

  try {
    const chunks = []
    const results = await ocr.recognizePdfAsync(pdfPath, (payload) => {
      progressEvents.push(payload)
    }, {
      model: 'PaddleOCR-VL-1.6',
      targetPageNums: [3, 5],
      onChunkComplete: (chunk) => {
        chunks.push({
          pageCount: chunk.pageCount,
          totalPages: chunk.totalPages,
          sourcePageIndexes: chunk.sourcePageIndexes,
          resultCount: chunk.results.length,
        })
      },
    })

    assert.strictEqual(results.length, 2)
    assert.deepStrictEqual(results.map((result) => result && result.markdown), ['page 1', 'page 2'])
    assert.strictEqual(uploads.length, 1)
    assert.strictEqual(uploads[0].pageCount, 2)
    assert.deepStrictEqual(uploads[0].sizes, [
      { width: 203, height: 303 },
      { width: 205, height: 305 },
    ])
    assert.deepStrictEqual(chunks, [{
      pageCount: 2,
      totalPages: 1001,
      sourcePageIndexes: [2, 4],
      resultCount: 2,
    }])
    assert.ok(progressEvents.some((payload) => payload.chunkStartPage === 3 && payload.chunkEndPage === 5))
    assert.ok(!progressEvents.some((payload) => payload.fallbackWholePdf === true))
  } finally {
    PDFDocument.prototype.copyPages = originalCopyPages
  }
}

async function runStalledProgressScenario(ocr, pdfPath) {
  installStalledProgressFetch()

  await assert.rejects(
    () => withFastPollTimers(() => ocr.recognizePdfAsync(pdfPath, undefined, {
      model: 'PaddleOCR-VL-1.6',
      targetPageNums: [1],
    })),
    /长时间没有进展/,
  )
}

async function runWholePdfFallbackScenario(ocr, pdfPath) {
  const uploads = installMockAsyncFetch()
  const progressEvents = []
  const originalCopyPages = PDFDocument.prototype.copyPages
  const originalQpdfChunking = process.env.GUJISMART_OCR_QPDF_CHUNKING
  process.env.GUJISMART_OCR_QPDF_CHUNKING = '0'
  PDFDocument.prototype.copyPages = async () => {
    throw new Error('Expected instance of PDFDict, but got instance of undefined')
  }

  try {
    await assert.rejects(() => ocr.recognizePdfAsync(pdfPath, (payload) => {
      progressEvents.push(payload)
    }, {
      model: 'PaddleOCR-VL-1.6',
      targetPageNums: [3, 5],
    }), /cannot be uploaded as one PaddleOCR job/)

    assert.strictEqual(uploads.length, 0)
    assert.ok(!progressEvents.some((payload) => payload.fallbackWholePdf === true))
  } finally {
    PDFDocument.prototype.copyPages = originalCopyPages
    if (originalQpdfChunking === undefined) {
      delete process.env.GUJISMART_OCR_QPDF_CHUNKING
    } else {
      process.env.GUJISMART_OCR_QPDF_CHUNKING = originalQpdfChunking
    }
  }
}

async function runWholePdfFallbackWhenLoadFailsScenario(ocr, pdfPath) {
  const uploads = installMockAsyncFetch()
  const progressEvents = []
  const originalLoad = PDFDocument.load
  const originalQpdfChunking = process.env.GUJISMART_OCR_QPDF_CHUNKING
  process.env.GUJISMART_OCR_QPDF_CHUNKING = '0'
  let shouldFailNextLoad = true
  PDFDocument.load = async (...args) => {
    if (shouldFailNextLoad) {
      shouldFailNextLoad = false
      throw new Error('Expected instance of PDFDict, but got instance of undefined')
    }
    return originalLoad.apply(PDFDocument, args)
  }

  try {
    const chunks = []
    const results = await ocr.recognizePdfAsync(pdfPath, (payload) => {
      progressEvents.push(payload)
    }, {
      model: 'PaddleOCR-VL-1.6',
      targetPageNums: [3, 5],
      onChunkComplete: (chunk) => {
        chunks.push({
          pageCount: chunk.pageCount,
          totalPages: chunk.totalPages,
          sourcePageIndexes: chunk.sourcePageIndexes,
          resultCount: chunk.results.length,
          resultMarkdowns: chunk.results.map((result) => result && result.markdown),
        })
      },
    })

    assert.strictEqual(results.length, 2)
    assert.deepStrictEqual(results.map((result) => result && result.markdown), ['page 3', 'page 5'])
    assert.strictEqual(uploads.length, 1)
    assert.strictEqual(uploads[0].pageCount, 5)
    assert.deepStrictEqual(chunks, [{
      pageCount: 2,
      totalPages: 5,
      sourcePageIndexes: [2, 4],
      resultCount: 2,
      resultMarkdowns: ['page 3', 'page 5'],
    }])
    assert.ok(progressEvents.some((payload) => payload.fallbackWholePdf === true && payload.uploadPageCount === 2))
  } finally {
    PDFDocument.load = originalLoad
    if (originalQpdfChunking === undefined) {
      delete process.env.GUJISMART_OCR_QPDF_CHUNKING
    } else {
      process.env.GUJISMART_OCR_QPDF_CHUNKING = originalQpdfChunking
    }
  }
}

async function runEmptyTargetScenario(ocr, pdfPath) {
  let fetchCount = 0
  global.fetch = async () => {
    fetchCount += 1
    throw new Error('empty target should not upload')
  }

  const chunks = []
  const results = await ocr.recognizePdfAsync(pdfPath, undefined, {
    model: 'PaddleOCR-VL-1.6',
    targetPageNums: [],
    onChunkComplete: (chunk) => chunks.push(chunk),
  })

  assert.strictEqual(fetchCount, 0)
  assert.strictEqual(results.length, 0)
  assert.strictEqual(chunks.length, 0)
}

async function runIncompleteChunkRetryScenario(ocr, pdfPath) {
  const uploads = installIncompleteChunkFetch()
  const chunks = []
  const progressEvents = []
  const results = await ocr.recognizePdfAsync(pdfPath, (payload) => {
    progressEvents.push(payload)
  }, {
    model: 'PaddleOCR-VL-1.6',
    onChunkComplete: (chunk) => chunks.push(chunk),
  })

  assert.strictEqual(uploads.length, 2, 'an incomplete result should resubmit only the affected chunk')
  assert.strictEqual(chunks.length, 1, 'an incomplete attempt must not fire the completion callback')
  assert.strictEqual(results.length, 5)
  assert.ok(results.every(Boolean))
  assert.ok(progressEvents.some((payload) => String(payload.errorMessage || '').includes('结果不完整')))
}

async function runPersistentMiddleChunkFailureScenario(ocr, pdfPath) {
  const uploads = installPersistentMiddleChunkFailureFetch()
  const completedChunkStarts = []
  const previousConcurrency = process.env.GUJISMART_TEST_OCR_CHUNK_CONCURRENCY
  process.env.GUJISMART_TEST_OCR_CHUNK_CONCURRENCY = '2'

  try {
    await assert.rejects(
      () => ocr.recognizePdfAsync(pdfPath, undefined, {
        model: 'PaddleOCR-VL-1.6',
        fallbackPageCount: 205,
        onChunkComplete: (chunk) => {
          completedChunkStarts.push(chunk.sourcePageIndexes[0])
        },
      }),
      /async_pdf_incomplete_chunk/,
    )
  } finally {
    if (previousConcurrency === undefined) {
      delete process.env.GUJISMART_TEST_OCR_CHUNK_CONCURRENCY
    } else {
      process.env.GUJISMART_TEST_OCR_CHUNK_CONCURRENCY = previousConcurrency
    }
  }

  assert.strictEqual(
    uploads.filter((upload) => upload.sizes[0]?.width === 301).length,
    3,
    'the incomplete middle chunk should stop after three attempts',
  )
  assert.ok(
    uploads.some((upload) => upload.sizes[0]?.width === 401 && upload.pageCount === 5),
    'the final five pages must still upload after the middle chunk fails',
  )
  assert.deepStrictEqual(
    completedChunkStarts.sort((left, right) => left - right),
    [0, 200],
    'successful chunks before and after the failure must both reach the persistence callback',
  )
}

async function runTokenFailoverChunkResumeScenario(ocr, pdfPath) {
  const { uploads, submissionTokens } = installTokenFailoverFetch()
  const chunks = []
  const results = await ocr.recognizePdfAsync(pdfPath, undefined, {
    model: 'PaddleOCR-VL-1.6',
    fallbackPageCount: 205,
    onChunkComplete: (chunk) => {
      chunks.push({
        pageCount: chunk.pageCount,
        sourcePageIndexes: chunk.sourcePageIndexes,
      })
    },
  })

  assert.strictEqual(results.length, 205)
  assert.deepStrictEqual(uploads.map((upload) => upload.pageCount), [100, 100, 5])
  assert.deepStrictEqual(uploads.map((upload) => upload.token), ['test-token', 'backup-token', 'backup-token'])
  assert.deepStrictEqual(submissionTokens, ['test-token', 'test-token', 'backup-token', 'backup-token'])
  assert.deepStrictEqual(chunks.map((chunk) => chunk.pageCount), [100, 100, 5])
  assert.deepStrictEqual(chunks.map((chunk) => chunk.sourcePageIndexes[0]), [0, 100, 200])
}

async function run() {
  const pdfPath = join(tempRoot, 'source.pdf')
  const largePdfPath = join(tempRoot, 'large-source.pdf')
  const failoverPdfPath = join(tempRoot, 'failover-source.pdf')
  await createTestPdf(pdfPath)
  await createTestPdf(largePdfPath, 1001)
  await createTestPdf(failoverPdfPath, 205)
  await buildBundle()
  const { ocr } = require(bundlePath)
  await runResumeScenario(ocr, pdfPath)
  await runRegressingProgressScenario(ocr, pdfPath)
  await runStalledProgressScenario(ocr, pdfPath)
  await runQpdfChunkingScenario(ocr, largePdfPath)
  await runWholePdfFallbackScenario(ocr, largePdfPath)
  await runWholePdfFallbackWhenLoadFailsScenario(ocr, pdfPath)
  await runPersistentMiddleChunkFailureScenario(ocr, failoverPdfPath)
  await runIncompleteChunkRetryScenario(ocr, pdfPath)
  await runTokenFailoverChunkResumeScenario(ocr, failoverPdfPath)
  await runEmptyTargetScenario(ocr, pdfPath)
  console.log('OCR PDF resume regression passed')
}

run()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => {
    rmSync(tempRoot, { recursive: true, force: true })
  })
