const fs = require('fs')
const path = require('path')
const ts = require('typescript')

const root = path.resolve(__dirname, '..')
const targets = [
  path.join(root, 'README.md'),
  path.join(root, 'package.json'),
  path.join(root, 'src', 'renderer', 'src'),
  path.join(root, 'src', 'main'),
  path.join(root, 'src', 'shared'),
]
const extensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.css', '.md', '.json'])

const mojibakeToken = /[绠鐞鏂囩尞闈㈠悜閫氱敤彜绫嶈祫鏂欐櫤兘爺绌惰緟鍔╁伐鍏妫€绱㈤〉闈鍙栨湇鍔℃椂寮€鍏ラ粯璁ょ姸鎬佸厓鏁版嵁缁勪欢鈥滄帴鍙ｆ潈闄掓嫙鍙傛暟]+/g
const replacementToken = /\uFFFD|\?{3,}/g
const suspiciousLatinBridge = /(?:Ã.|Â.|â€|â€™|â€œ|â€�|ï¼|ðŸ)/g
const knownMojibakeSequence = /(?:绗\?|椤电|椤佃|灏戦|鍥撅|鏃犳硶|瑙嗚|妯″瀷|锛涜瘖|鏂棩蹇|妗ｆ|鎵嬬|棣嗚|鍗峰|鍗扮|妗堝|鏂囦欢|璁颁|绨\?)/

function walk(target, files = []) {
  if (!fs.existsSync(target)) return files
  const stat = fs.statSync(target)
  if (stat.isFile()) {
    if (extensions.has(path.extname(target))) files.push(target)
    return files
  }

  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const fullPath = path.join(target, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'out' || entry.name === 'dist') continue
      walk(fullPath, files)
    } else if (extensions.has(path.extname(entry.name))) {
      files.push(fullPath)
    }
  }
  return files
}

function extractStringLiterals(source, fileName) {
  const ext = path.extname(fileName)
  if (!['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
    const lines = source.split(/\r?\n/)
    let index = 0
    return lines.map((line) => {
      const literal = { text: line, index }
      index += line.length
      if (source.slice(index, index + 2) === '\r\n') {
        index += 2
      } else if (source[index] === '\n') {
        index += 1
      }
      return literal
    }).filter((line) => line.text.trim())
  }

  const literals = []
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )

  function visit(node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const text = node.getText(sourceFile)
      if (text.trim()) literals.push({ text, index: node.getStart(sourceFile) })
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return literals
}

function lineCol(source, index) {
  const before = source.slice(0, index)
  const lines = before.split(/\r?\n/)
  return { line: lines.length, column: lines[lines.length - 1].length + 1 }
}

function countMatches(pattern, text) {
  pattern.lastIndex = 0
  return [...text.matchAll(pattern)].reduce((sum, match) => sum + match[0].length, 0)
}

function isSuspicious(text) {
  const stripped = String(text || '').replace(/[A-Za-z0-9_./:@#?&=%${}\\[\]'"`<>|*+\-()[\]\s]/g, '')
  if (replacementToken.test(text) || suspiciousLatinBridge.test(text) || knownMojibakeSequence.test(text)) {
    replacementToken.lastIndex = 0
    suspiciousLatinBridge.lastIndex = 0
    return true
  }
  replacementToken.lastIndex = 0
  suspiciousLatinBridge.lastIndex = 0

  const mojibakeChars = countMatches(mojibakeToken, stripped)
  mojibakeToken.lastIndex = 0
  if (mojibakeChars >= 6) return true
  if (mojibakeChars >= 3 && stripped.length > 0 && mojibakeChars / stripped.length >= 0.35) return true
  return false
}

const findings = []
const files = Array.from(new Set(targets.flatMap((target) => walk(target))))

for (const file of files) {
  const source = fs.readFileSync(file, 'utf8')
  for (const literal of extractStringLiterals(source, file)) {
    if (!isSuspicious(literal.text)) continue
    const loc = lineCol(source, literal.index)
    findings.push({
      file: path.relative(root, file),
      line: loc.line,
      column: loc.column,
      sample: literal.text.slice(0, 120).replace(/\s+/g, ' '),
    })
  }
}

if (findings.length > 0) {
  console.error(`Found ${findings.length} suspicious mojibake occurrence(s):`)
  findings.slice(0, 160).forEach((item) => {
    console.error(`${item.file}:${item.line}:${item.column} ${item.sample}`)
  })
  if (findings.length > 160) console.error(`...and ${findings.length - 160} more`)
  process.exit(1)
}

console.log('No suspicious mojibake occurrences found.')
