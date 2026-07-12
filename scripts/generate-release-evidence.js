const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const root = path.resolve(__dirname, '..')
const outputDir = path.resolve(process.env.GUJISMART_RELEASE_EVIDENCE_DIR || path.join(root, 'tmp', 'package-metadata'))

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function listFiles(directory) {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name)
    return entry.isDirectory() ? listFiles(fullPath) : [fullPath]
  }).sort()
}

function git(args, fallback = '') {
  try { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim() } catch { return fallback }
}

function packageNameFromLockPath(lockPath, metadata) {
  if (metadata.name) return metadata.name
  const marker = 'node_modules/'
  const index = lockPath.lastIndexOf(marker)
  return index >= 0 ? lockPath.slice(index + marker.length) : lockPath || 'gujismart'
}

fs.mkdirSync(outputDir, { recursive: true })
const lockPath = path.join(root, 'package-lock.json')
const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
const packages = Object.entries(lock.packages || {}).filter(([lockPath]) => lockPath !== '').map(([lockPath, metadata]) => ({
  SPDXID: `SPDXRef-Package-${crypto.createHash('sha1').update(lockPath).digest('hex')}`,
  name: packageNameFromLockPath(lockPath, metadata),
  versionInfo: metadata.version || 'NOASSERTION',
  downloadLocation: metadata.resolved || 'NOASSERTION',
  filesAnalyzed: false,
  licenseConcluded: metadata.license || 'NOASSERTION',
  licenseDeclared: metadata.license || 'NOASSERTION',
  copyrightText: 'NOASSERTION'
}))
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const namespaceHash = crypto.createHash('sha256').update(`${packageJson.name}@${packageJson.version}:${sha256File(lockPath)}`).digest('hex')
const sbom = {
  spdxVersion: 'SPDX-2.3',
  dataLicense: 'CC0-1.0',
  SPDXID: 'SPDXRef-DOCUMENT',
  name: `${packageJson.name}-${packageJson.version}`,
  documentNamespace: `https://gujismart.local/spdx/${namespaceHash}`,
  creationInfo: { created: new Date().toISOString(), creators: ['Tool: GujiSmart generate-release-evidence.js'] },
  packages
}
fs.writeFileSync(path.join(outputDir, 'sbom.spdx.json'), `${JSON.stringify(sbom, null, 2)}\n`)

const vendorRoot = path.join(root, 'resources', 'vendor')
const vendor = listFiles(vendorRoot).map((filePath) => ({
  path: path.relative(vendorRoot, filePath).split(path.sep).join('/'),
  bytes: fs.statSync(filePath).size,
  sha256: sha256File(filePath)
}))
fs.writeFileSync(path.join(outputDir, 'vendor-manifest.json'), `${JSON.stringify({ schemaVersion: 'gujismart-vendor-manifest/v1', files: vendor }, null, 2)}\n`)

const distRoot = path.join(root, 'dist')
const buildFiles = (fs.existsSync(distRoot)
  ? fs.readdirSync(distRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(distRoot, entry.name))
    .sort()
  : [])
  .filter((filePath) => fs.statSync(filePath).size > 0)
  .map((filePath) => ({
  path: path.relative(root, filePath).split(path.sep).join('/'),
  bytes: fs.statSync(filePath).size,
  sha256: sha256File(filePath)
}))
const rcManifest = {
  schemaVersion: 'gujismart-local-rc/v1',
  generatedAt: new Date().toISOString(),
  releaseStatus: 'local-test-pending',
  commit: git(['rev-parse', 'HEAD'], 'unavailable'),
  branch: git(['branch', '--show-current'], 'unavailable'),
  dirty: Boolean(git(['status', '--porcelain'], 'unknown')),
  packageLockSha256: sha256File(lockPath),
  fixtureManifestSha256: sha256File(path.join(root, 'tests', 'fixtures', 'synthetic', 'manifest.json')),
  sbomSha256: sha256File(path.join(outputDir, 'sbom.spdx.json')),
  vendorManifestSha256: sha256File(path.join(outputDir, 'vendor-manifest.json')),
  buildFiles,
  publicationApproved: false
}
fs.writeFileSync(path.join(outputDir, 'local-rc-manifest.json'), `${JSON.stringify(rcManifest, null, 2)}\n`)
console.log(`Release evidence generated in ${outputDir}`)
