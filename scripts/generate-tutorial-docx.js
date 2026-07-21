/**
 * Generate docs/文献管理-图文使用教程.docx from the Markdown tutorial.
 * Usage: node scripts/generate-tutorial-docx.js
 * Requires: npm install docx (dev or temporary)
 */
const fs = require('fs')
const path = require('path')

let docx
try {
  docx = require('docx')
} catch {
  console.error('Missing dependency: run `npm install docx --no-save` then retry.')
  process.exit(1)
}

const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  ImageRun,
  ExternalHyperlink,
  BorderStyle,
  LevelFormat,
  AlignmentType,
} = docx

const root = path.join(__dirname, '..')
const docsDir = path.join(root, 'docs')
const mdPath = path.join(docsDir, '文献管理-图文使用教程.md')
const outPath = path.join(docsDir, '文献管理-图文使用教程.docx')
const outPathAlt = path.join(docsDir, '文献管理-图文使用教程-1.1.10.docx')

const md = fs.readFileSync(mdPath, 'utf8').replace(/\r\n/g, '\n')
const lines = md.split('\n')

function loadPng(relPath) {
  const full = path.join(docsDir, relPath.replace(/\//g, path.sep))
  if (!fs.existsSync(full)) return null
  return fs.readFileSync(full)
}

function parseInline(text) {
  const runs = []
  // Split keeping markdown links and **bold** and `code`
  const tokenRe = /(\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*|`[^`]+`)/g
  let last = 0
  let match
  const pushPlain = (plain) => {
    if (!plain) return
    runs.push(new TextRun({ text: plain, font: 'Microsoft YaHei', size: 22 }))
  }
  while ((match = tokenRe.exec(text)) !== null) {
    pushPlain(text.slice(last, match.index))
    const tok = match[0]
    if (tok.startsWith('[') && tok.includes('](')) {
      const m = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
      if (m) {
        const href = m[2].startsWith('http') ? m[2] : 'https://github.com/DieDust/gujismart-public'
        runs.push(new ExternalHyperlink({
          children: [new TextRun({
            text: m[1],
            color: '0563C1',
            underline: {},
            font: 'Microsoft YaHei',
            size: 22,
          })],
          link: href,
        }))
      } else {
        pushPlain(tok)
      }
    } else if (tok.startsWith('**')) {
      runs.push(new TextRun({
        text: tok.slice(2, -2),
        bold: true,
        font: 'Microsoft YaHei',
        size: 22,
      }))
    } else if (tok.startsWith('`')) {
      runs.push(new TextRun({
        text: tok.slice(1, -1),
        font: 'Consolas',
        size: 20,
      }))
    }
    last = match.index + tok.length
  }
  pushPlain(text.slice(last))
  return runs.length ? runs : [new TextRun({ text, font: 'Microsoft YaHei', size: 22 })]
}

const children = []
let inCode = false
const codeBuf = []

function flushCode() {
  if (!codeBuf.length) return
  children.push(new Paragraph({
    spacing: { before: 80, after: 80 },
    children: [new TextRun({
      text: codeBuf.join('\n'),
      font: 'Consolas',
      size: 18,
    })],
  }))
  codeBuf.length = 0
}

for (const line of lines) {
  if (line.trim().startsWith('```')) {
    if (inCode) {
      flushCode()
      inCode = false
    } else {
      inCode = true
    }
    continue
  }
  if (inCode) {
    codeBuf.push(line)
    continue
  }

  const imgMatch = line.match(/^!\[(.*?)\]\((.*?)\)/)
  if (imgMatch) {
    const data = loadPng(imgMatch[2])
    if (data) {
      children.push(new Paragraph({
        spacing: { before: 140, after: 140 },
        alignment: AlignmentType.CENTER,
        children: [new ImageRun({
          type: 'png',
          data,
          transformation: { width: 520, height: 292 },
          altText: {
            title: imgMatch[1] || 'screenshot',
            description: imgMatch[1] || 'screenshot',
            name: imgMatch[1] || 'screenshot',
          },
        })],
      }))
    } else {
      children.push(new Paragraph({
        children: [new TextRun({
          text: `[图片缺失: ${imgMatch[2]}]`,
          italics: true,
          color: '999999',
          font: 'Microsoft YaHei',
          size: 20,
        })],
      }))
    }
    continue
  }

  if (line.startsWith('# ')) {
    children.push(new Paragraph({
      heading: HeadingLevel.TITLE,
      spacing: { after: 200 },
      children: [new TextRun({
        text: line.slice(2),
        bold: true,
        font: 'Microsoft YaHei',
        size: 36,
      })],
    }))
    continue
  }
  if (line.startsWith('## ')) {
    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 280, after: 120 },
      children: [new TextRun({
        text: line.slice(3),
        bold: true,
        font: 'Microsoft YaHei',
        size: 28,
      })],
    }))
    continue
  }
  if (line.startsWith('### ')) {
    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 200, after: 80 },
      children: [new TextRun({
        text: line.slice(4),
        bold: true,
        font: 'Microsoft YaHei',
        size: 24,
      })],
    }))
    continue
  }
  if (line.startsWith('> ')) {
    children.push(new Paragraph({
      spacing: { before: 60, after: 60 },
      border: {
        left: { style: BorderStyle.SINGLE, size: 24, color: 'CCCCCC', space: 8 },
      },
      indent: { left: 200 },
      children: parseInline(line.slice(2)),
    }))
    continue
  }
  if (line.trim() === '---') continue
  if (line.includes('|') && line.trim().startsWith('|')) {
    const cells = line.split('|').map((s) => s.trim()).filter(Boolean)
    if (cells.every((c) => /^[-:]+$/.test(c))) continue
    children.push(new Paragraph({
      spacing: { before: 40, after: 40 },
      children: [new TextRun({
        text: cells.join('  ·  '),
        font: 'Microsoft YaHei',
        size: 20,
        color: '333333',
      })],
    }))
    continue
  }
  if (/^[-*] /.test(line)) {
    children.push(new Paragraph({
      numbering: { reference: 'bullets', level: 0 },
      spacing: { before: 40, after: 40 },
      children: parseInline(line.replace(/^[-*] /, '')),
    }))
    continue
  }
  if (/^\d+\. /.test(line)) {
    children.push(new Paragraph({
      numbering: { reference: 'numbers', level: 0 },
      spacing: { before: 40, after: 40 },
      children: parseInline(line.replace(/^\d+\. /, '')),
    }))
    continue
  }
  if (!line.trim()) {
    children.push(new Paragraph({ children: [] }))
    continue
  }
  children.push(new Paragraph({
    spacing: { before: 60, after: 60 },
    children: parseInline(line),
  }))
}

const doc = new Document({
  styles: {
    default: { document: { run: { font: 'Microsoft YaHei', size: 22 } } },
  },
  numbering: {
    config: [
      {
        reference: 'bullets',
        levels: [{
          level: 0,
          format: LevelFormat.BULLET,
          text: '•',
          alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } },
        }],
      },
      {
        reference: 'numbers',
        levels: [{
          level: 0,
          format: LevelFormat.DECIMAL,
          text: '%1.',
          alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } },
        }],
      },
    ],
  },
  sections: [{
    properties: {
      page: {
        size: { width: 11906, height: 16838 },
        margin: { top: 1134, right: 1134, bottom: 1134, left: 1134 },
      },
    },
    children,
  }],
})

Packer.toBuffer(doc).then((buf) => {
  try {
    fs.writeFileSync(outPath, buf)
    console.log('Wrote', outPath, `(${buf.length} bytes)`)
  } catch (error) {
    if (error && (error.code === 'EBUSY' || error.code === 'EPERM')) {
      fs.writeFileSync(outPathAlt, buf)
      console.warn('Primary docx locked; wrote alternate:', outPathAlt, `(${buf.length} bytes)`)
      return
    }
    throw error
  }
}).catch((error) => {
  console.error(error)
  process.exit(1)
})
