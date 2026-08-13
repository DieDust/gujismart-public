const assert = require('assert')
const path = require('path')
const { pathToFileURL } = require('url')

const resources = process.env.GUJISMART_PACKAGED_RESOURCES
assert(resources, 'GUJISMART_PACKAGED_RESOURCES is required')

const packagedNodeModules = path.join(resources, 'app.asar', 'node_modules')
const fromPackage = (...parts) => path.join(packagedNodeModules, ...parts)

async function main() {
  const Database = require(fromPackage('better-sqlite3'))
  const database = new Database(':memory:')
  try {
    assert.strictEqual(database.prepare('SELECT 33 AS version').get().version, 33)
  } finally {
    database.close()
  }

  const canvas = require(fromPackage('@napi-rs', 'canvas'))
  assert.strictEqual(canvas.createCanvas(2, 2).width, 2)

  const openCcModule = require(fromPackage('opencc-js'))
  const OpenCC = openCcModule.default || openCcModule
  const toTraditional = OpenCC.Converter({ from: 'cn', to: 'tw' })
  assert.notStrictEqual(toTraditional('汉字转换'), '汉字转换')

  const { PDFDocument } = require(fromPackage('pdf-lib'))
  const fontkit = require(fromPackage('@pdf-lib', 'fontkit'))
  const pdfDocument = await PDFDocument.create()
  pdfDocument.registerFontkit(fontkit)
  pdfDocument.addPage([20, 20])
  const pdfBytes = await pdfDocument.save()

  const pdfJsUrl = pathToFileURL(fromPackage('pdfjs-dist', 'legacy', 'build', 'pdf.mjs')).href
  const pdfjs = await import(pdfJsUrl)
  const loadedPdf = await pdfjs.getDocument({
    data: pdfBytes,
    useWorkerFetch: false,
    useSystemFonts: true,
    isEvalSupported: false,
  }).promise
  assert.strictEqual(loadedPdf.numPages, 1)
  await loadedPdf.destroy()

  for (const dependency of ['@electron-internal/extract-zip', 'archiver', 'fast-xml-parser', 'flexsearch', 'jszip']) {
    assert(require(fromPackage(dependency)), `Unable to load packaged runtime dependency: ${dependency}`)
  }

  console.log('Packaged runtime dependency probe passed.')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
