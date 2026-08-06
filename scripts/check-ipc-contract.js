const fs = require('fs')
const path = require('path')
const ts = require('typescript')

const rootDir = path.resolve(__dirname, '..')
const preloadPath = path.join(rootDir, 'src', 'preload', 'index.ts')
const mainDir = path.join(rootDir, 'src', 'main')
const rendererDir = path.join(rootDir, 'src', 'renderer', 'src')

function toRepoPath(filePath) {
  return path.relative(rootDir, filePath).replace(/\\/g, '/')
}

function listSourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'out' || entry.name === 'dist') continue
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      listSourceFiles(fullPath, out)
      continue
    }
    if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      out.push(fullPath)
    }
  }
  return out
}

function createSourceFile(filePath) {
  const sourceText = fs.readFileSync(filePath, 'utf8')
  const scriptKind = filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  return ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, scriptKind)
}

function getNameText(nameNode) {
  if (!nameNode) return null
  if (ts.isIdentifier(nameNode) || ts.isStringLiteral(nameNode) || ts.isNumericLiteral(nameNode)) {
    return nameNode.text
  }
  return null
}

function getLine(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
}

function formatLocation(item) {
  return `${item.file}:${item.line}`
}

function collectPreloadContract() {
  const sourceFile = createSourceFile(preloadPath)
  const apiProps = new Map()
  const invokeChannels = []

  function visit(node) {
    if (
      ts.isVariableDeclaration(node)
      && node.name.getText(sourceFile) === 'api'
      && node.initializer
      && ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const prop of node.initializer.properties) {
        const name = getNameText(prop.name)
        if (name) {
          apiProps.set(name, { name, file: toRepoPath(preloadPath), line: getLine(sourceFile, prop.name) })
        }
      }
    }

    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.expression.getText(sourceFile) === 'ipcRenderer'
      && node.expression.name.text === 'invoke'
    ) {
      const channel = node.arguments[0]
      if (channel && ts.isStringLiteralLike(channel)) {
        invokeChannels.push({ channel: channel.text, file: toRepoPath(preloadPath), line: getLine(sourceFile, channel) })
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return { apiProps, invokeChannels }
}

function collectMainHandlers() {
  const handlers = []

  for (const filePath of listSourceFiles(mainDir)) {
    const sourceFile = createSourceFile(filePath)

    function visit(node) {
      if (
        ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && node.expression.expression.getText(sourceFile) === 'ipcMain'
        && node.expression.name.text === 'handle'
      ) {
        const channel = node.arguments[0]
        if (channel && ts.isStringLiteralLike(channel)) {
          handlers.push({ channel: channel.text, file: toRepoPath(filePath), line: getLine(sourceFile, channel) })
        }
      }

      ts.forEachChild(node, visit)
    }

    visit(sourceFile)
  }

  return handlers
}

function collectRendererApiUsages() {
  const usages = []
  const optionalProbes = []

  for (const filePath of listSourceFiles(rendererDir)) {
    const sourceFile = createSourceFile(filePath)

    function visit(node) {
      if (
        ts.isPropertyAccessExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && node.expression.expression.getText(sourceFile) === 'window'
        && node.expression.name.text === 'api'
      ) {
        usages.push({ name: node.name.text, file: toRepoPath(filePath), line: getLine(sourceFile, node.name) })
      }

      if (
        ts.isPropertyAccessExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && ts.isPropertyAccessExpression(node.expression.expression)
        && node.expression.expression.expression.getText(sourceFile) === 'window'
        && node.expression.expression.name.text === 'api'
      ) {
        const apiName = node.expression.name.text
        const sourceText = node.getText(sourceFile)
        if (
          sourceText.includes('?.')
          || sourceText.startsWith(`typeof window.api.${apiName}`)
          || sourceText.startsWith(`!window.api.${apiName}`)
        ) {
          optionalProbes.push({ name: apiName, file: toRepoPath(filePath), line: getLine(sourceFile, node.expression.name) })
        }
      }

      ts.forEachChild(node, visit)
    }

    visit(sourceFile)
  }

  return { usages, optionalProbes }
}

function collectDuplicates(items, key) {
  const grouped = new Map()
  for (const item of items) {
    const value = item[key]
    grouped.set(value, [...(grouped.get(value) || []), item])
  }
  return [...grouped.entries()].filter(([, group]) => group.length > 1)
}

function printIssue(title, items, render) {
  if (items.length === 0) return
  console.error(`\n${title}`)
  for (const item of items) {
    console.error(`- ${render(item)}`)
  }
}

const { apiProps, invokeChannels } = collectPreloadContract()
const mainHandlers = collectMainHandlers()
const { usages: rendererUsages, optionalProbes } = collectRendererApiUsages()

const requiredManualImageApis = ['cropManualPageImage', 'selectManualBlockImage']
const missingRequiredManualImageApis = requiredManualImageApis.filter((name) => !apiProps.has(name))
const requiredManualImageChannels = ['pages:cropManualImage', 'pages:selectManualImage']
const missingRequiredManualImageChannels = requiredManualImageChannels.filter((channel) => (
  !invokeChannels.some((item) => item.channel === channel)
  || !mainHandlers.some((item) => item.channel === channel)
))
const requiredManualPageApis = ['insertManualPage']
const missingRequiredManualPageApis = requiredManualPageApis.filter((name) => !apiProps.has(name))
const requiredManualPageChannels = ['pages:insertManual']
const missingRequiredManualPageChannels = requiredManualPageChannels.filter((channel) => (
  !invokeChannels.some((item) => item.channel === channel)
  || !mainHandlers.some((item) => item.channel === channel)
))

const mainChannels = new Set(mainHandlers.map((item) => item.channel))
const preloadChannels = new Set(invokeChannels.map((item) => item.channel))
const missingMainHandlers = invokeChannels.filter((item) => !mainChannels.has(item.channel))
const rendererMissingApi = rendererUsages.filter((item) => !apiProps.has(item.name))
const duplicateMainHandlers = collectDuplicates(mainHandlers, 'channel')
const duplicatePreloadInvokes = collectDuplicates(invokeChannels, 'channel')
const unusedMainHandlers = mainHandlers.filter((item) => !preloadChannels.has(item.channel))

let failed = false
function failIfAny(title, items, render) {
  if (items.length === 0) return
  failed = true
  printIssue(title, items, render)
}

failIfAny('Preload invokes channels without a main ipcMain.handle:', missingMainHandlers, (item) => `${item.channel} at ${formatLocation(item)}`)
failIfAny('Renderer uses window.api members not exposed by preload:', rendererMissingApi, (item) => `${item.name} at ${formatLocation(item)}`)
failIfAny('Duplicate main ipcMain.handle channels:', duplicateMainHandlers, ([channel, group]) => `${channel} at ${group.map(formatLocation).join(', ')}`)
failIfAny('Duplicate preload ipcRenderer.invoke channels:', duplicatePreloadInvokes, ([channel, group]) => `${channel} at ${group.map(formatLocation).join(', ')}`)
failIfAny('Main ipcMain.handle channels not exposed through preload:', unusedMainHandlers, (item) => `${item.channel} at ${formatLocation(item)}`)
failIfAny('Renderer optional probes for required window.api members:', optionalProbes, (item) => `${item.name} at ${formatLocation(item)}`)
failIfAny('Required manual image preload APIs are missing:', missingRequiredManualImageApis, (name) => name)
failIfAny('Required manual image IPC channels are incomplete:', missingRequiredManualImageChannels, (channel) => channel)
failIfAny('Required manual page preload APIs are missing:', missingRequiredManualPageApis, (name) => name)
failIfAny('Required manual page IPC channels are incomplete:', missingRequiredManualPageChannels, (channel) => channel)

if (failed) {
  process.exit(1)
}

console.log(`IPC contract OK: ${apiProps.size} preload APIs, ${invokeChannels.length} preload invokes, ${mainHandlers.length} main handlers, ${new Set(rendererUsages.map((item) => item.name)).size} renderer API members.`)
