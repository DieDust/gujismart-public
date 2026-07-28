const assert = require('assert')
const { readFileSync } = require('fs')
const { join } = require('path')

const root = join(__dirname, '..')
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const releaseWorkflow = readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8')
const packagedSmoke = readFileSync(join(root, 'scripts', 'packaged-smoke.js'), 'utf8')

const rendererOnlyDependencies = [
  '@ant-design/icons',
  '@types/archiver',
  '@types/better-sqlite3',
  'antd',
  'epubjs',
  'marked',
  'nanoid',
  'react',
  'react-dom',
  'react-markdown',
  'react-window',
  'rehype-raw',
  'remark-gfm',
  'zustand',
]
const packagedRuntimeDependencies = [
  '@electron-toolkit/utils',
  '@napi-rs/canvas',
  '@pdf-lib/fontkit',
  'archiver',
  'better-sqlite3',
  'extract-zip',
  'fast-xml-parser',
  'flexsearch',
  'jszip',
  'opencc-js',
  'pdf-lib',
  'pdfjs-dist',
]

for (const dependency of rendererOnlyDependencies) {
  assert(
    packageJson.devDependencies?.[dependency] && !packageJson.dependencies?.[dependency],
    `${dependency} must remain a build-only dependency so its Vite-bundled source is not duplicated in the package.`,
  )
}
for (const dependency of packagedRuntimeDependencies) {
  assert(
    packageJson.dependencies?.[dependency],
    `${dependency} is loaded by the packaged main process and must remain a production dependency.`,
  )
}

assert.deepStrictEqual(
  packageJson.build?.electronLanguages,
  ['zh-CN', 'en-US'],
  'The Windows package should retain Chinese plus the English fallback Electron locale.',
)

const packageFiles = new Set(packageJson.build?.files || [])
const requiredExclusions = [
  '!node_modules/**/*.map',
  '!node_modules/better-sqlite3/build/Release/obj/**/*',
  '!node_modules/better-sqlite3/deps/**/*',
  '!node_modules/pdf-lib/dist/**/*',
  '!node_modules/pdfjs-dist/build/**/*',
  '!node_modules/pdfjs-dist/types/**/*',
  '!node_modules/@pdf-lib/fontkit/dist/fontkit.es.js',
  '!node_modules/opencc-js/dist/esm/**/*',
]
for (const exclusion of requiredExclusions) {
  assert(packageFiles.has(exclusion), `Missing package footprint exclusion: ${exclusion}`)
}

assert(
  packageFiles.has('out/**/*') && packageFiles.has('resources/**/*'),
  'Compiled application output and product resources must remain included.',
)
assert(
  packageJson.build?.extraResources?.some((entry) => entry.from === 'resources/vendor' && entry.to === 'vendor'),
  'Bundled vendor tools must remain available; package optimization must not remove QPDF or other runtime tools.',
)
assert(
  releaseWorkflow.includes('run: npm run build:win')
    && releaseWorkflow.includes('run: npm run smoke:packaged'),
  'GitHub Actions must use the same optimized Windows build and packaged smoke test as local builds.',
)
assert(
  packagedSmoke.includes('packaged-runtime-probe.js')
    && packagedSmoke.includes("ELECTRON_RUN_AS_NODE: '1'"),
  'Packaged smoke must exercise the pruned database, PDF, font, canvas, and text-conversion runtime dependencies.',
)

console.log('Package footprint regression checks passed.')
