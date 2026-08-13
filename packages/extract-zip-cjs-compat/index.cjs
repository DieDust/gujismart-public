'use strict'

// Electron 39 loads its extractor with require(), while Electron's hardened
// replacement is ESM-only. Keep the old install-time call shape without
// retaining the vulnerable extract-zip implementation.
module.exports = async function extractZipCompat(archivePath, options) {
  const { default: extract } = await import('@electron-internal/extract-zip')
  return extract(archivePath, { dir: options.dir })
}
