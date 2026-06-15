const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

function assertIncludes(source, needle, label) {
  if (!source.includes(needle)) {
    throw new Error(`${label}: missing ${needle}`)
  }
}

const sourcePageReader = read('src/renderer/src/components/SourcePageReader.tsx')
const ocrText = read('src/renderer/src/utils/ocrText.ts')
const ocrMain = read('src/main/ocr.ts')

assertIncludes(sourcePageReader, 'mergeAiLayoutElementsWithSourceStructure', 'AI reading layout should merge source structure')
assertIncludes(sourcePageReader, "const sourceImages = sourceElements.filter((element) => element.type === 'image')", 'AI reading layout should detect source image elements')
assertIncludes(sourcePageReader, 'for (const sourceImage of sourceImages)', 'AI reading layout should reinsert source images')
assertIncludes(sourcePageReader, "label: sourceImage.label || 'source_image'", 'reinserted source images should keep a readable label')
assertIncludes(sourcePageReader, 'insertSourceElementBySourceOrder(next, sourceElements, sourceImage, imageElement)', 'source images should be inserted near their original OCR order')
assertIncludes(sourcePageReader, "charEnd: element.type === 'image' ? charStart : charStart + textLength", 'image elements should not create fake text spans')
assertIncludes(sourcePageReader, 'return mergeAiLayoutElementsWithSourceStructure(page, aiLayoutTextToElements(aiText))', 'display elements should use source-structure merge')
assertIncludes(sourcePageReader, 'const pageImagePath = String(page?.image_path || \'\').trim()', 'reader images should keep page-image fallback path')
assertIncludes(sourcePageReader, 'const usePageImage = () =>', 'reader images should fall back to page image crop')
assertIncludes(sourcePageReader, '? window.api.readRemoteImageAsDataURL(imagePath)', 'remote OCR images should be fetched through main-process data URL conversion')
assertIncludes(sourcePageReader, 'if (/^https:\\/\\//i.test(directImagePath))', 'remote OCR image elements should not be assigned directly to img src')
assertIncludes(sourcePageReader, "const isLocalDirectImage = directImagePath && !/^(?:imgs?|images?)\\//i.test(directImagePath)", 'relative OCR asset paths should not block page-image fallback')
assertIncludes(sourcePageReader, 'if (!cancelled) usePageImage()', 'failed direct image reads should fall back to page image crop')
assertIncludes(sourcePageReader, 'src && usingDirectImage', 'direct images and cropped page images should render through separate branches')

assertIncludes(ocrText, 'function getBlockImagePath', 'reader text extraction should inspect existing layout image asset paths')
assertIncludes(ocrText, 'function isRenderableImagePath', 'reader text extraction should distinguish remote/local image assets from unresolved OCR relative paths')
assertIncludes(ocrText, 'const enrichedBlocks = blocks.map((block) =>', 'reader text extraction should enrich existing layout image blocks')
assertIncludes(ocrText, 'const markdownImage = markdownImageBlocks.find((imageBlock) => rectOverlapRatio(rect, imageBlock.rect) >= 0.6)', 'reader text extraction should match markdown images to overlapping layout image blocks')
assertIncludes(ocrText, 'image_asset_path: imagePath', 'reader text extraction should preserve resolved markdown image URLs on layout image blocks')
assertIncludes(ocrText, '&& isRenderableImagePath(getBlockImagePath(block))', 'resolved layout images should suppress duplicate markdown image insertion only when they have a renderable path')

assertIncludes(ocrMain, 'function getLayoutBlockImagePath', 'OCR post-processing should inspect existing layout image asset paths')
assertIncludes(ocrMain, 'function isRenderableOcrImagePath', 'OCR post-processing should distinguish resolved image assets from unresolved relative OCR paths')
assertIncludes(ocrMain, 'const overlappingImageBox = regionBoxes.find((box) => (', 'OCR post-processing should match markdown images to existing layout image blocks')
assertIncludes(ocrMain, 'overlappingImageBox.image_asset_path = imagePath', 'OCR post-processing should enrich overlapping image layout blocks with resolved markdown image URLs')

const preload = read('src/preload/index.ts')
const settingsIpc = read('src/main/ipc/settings.ts')
assertIncludes(preload, 'readRemoteImageAsDataURL: (imageUrl: string): Promise<string>', 'preload should expose remote OCR image reader')
assertIncludes(preload, "ipcRenderer.invoke('fs:readRemoteImageAsDataURL', imageUrl)", 'preload should call remote image IPC')
assertIncludes(settingsIpc, "ipcMain.handle('fs:readRemoteImageAsDataURL'", 'main process should register remote image IPC')
assertIncludes(settingsIpc, 'assertAllowedRemoteImageUrl', 'remote image IPC should validate OCR image URLs')
assertIncludes(settingsIpc, "hostname !== 'pplines-online.bj.bcebos.com' && !hostname.endsWith('.bcebos.com')", 'remote image IPC should allow only trusted OCR image hosts')
assertIncludes(settingsIpc, 'REMOTE_IMAGE_MAX_BYTES', 'remote image IPC should enforce a size limit')

console.log('Source reader image regression checks passed')
