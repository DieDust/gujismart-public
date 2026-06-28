const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const pdfjsRoot = path.join(root, 'node_modules', 'pdfjs-dist')
const rendererPublicPdfjs = path.join(root, 'src', 'renderer', 'public', 'pdfjs')

function copyDir(source, target) {
  if (!fs.existsSync(source)) {
    throw new Error(`Missing pdfjs asset directory: ${source}`)
  }
  fs.rmSync(target, { recursive: true, force: true })
  fs.mkdirSync(target, { recursive: true })
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name)
    const targetPath = path.join(target, entry.name)
    if (entry.isDirectory()) {
      copyDir(sourcePath, targetPath)
    } else if (entry.isFile()) {
      fs.copyFileSync(sourcePath, targetPath)
    }
  }
}

copyDir(path.join(pdfjsRoot, 'cmaps'), path.join(rendererPublicPdfjs, 'cmaps'))
copyDir(path.join(pdfjsRoot, 'standard_fonts'), path.join(rendererPublicPdfjs, 'standard_fonts'))

console.log('PDF.js local assets synced.')
