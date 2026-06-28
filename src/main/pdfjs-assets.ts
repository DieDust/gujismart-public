import { createRequire } from 'module'
import { dirname, join, sep } from 'path'

const moduleUrlOrPath = typeof import.meta.url === 'string' ? import.meta.url : __filename
const require = createRequire(moduleUrlOrPath)

function withTrailingSeparator(path: string): string {
  return path.endsWith('/') || path.endsWith('\\') ? path : `${path}${sep}`
}

function getPdfJsDistRoot(): string {
  return dirname(require.resolve('pdfjs-dist/package.json'))
}

export function getPdfJsNodeDocumentOptions(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const pdfjsDistRoot = getPdfJsDistRoot()
  return {
    cMapUrl: withTrailingSeparator(join(pdfjsDistRoot, 'cmaps')),
    cMapPacked: true,
    standardFontDataUrl: withTrailingSeparator(join(pdfjsDistRoot, 'standard_fonts')),
    useWorkerFetch: false,
    useSystemFonts: true,
    isEvalSupported: false,
    ...overrides,
  }
}
