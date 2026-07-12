const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8')

const settingsView = read('src/renderer/src/views/SettingsView.tsx')
const onboarding = read('src/renderer/src/components/OnboardingWizard.tsx')
const library = read('src/renderer/src/views/LibraryView.tsx')
const folders = read('src/renderer/src/views/FoldersView.tsx')
const ocrIpc = read('src/main/ipc/ocr.ts')
const settingsIpc = read('src/main/ipc/settings.ts')

for (const [name, source] of [
  ['SettingsView', settingsView],
  ['OnboardingWizard', onboarding],
  ['LibraryView', library],
  ['FoldersView', folders],
]) {
  assert.ok(!source.includes("key: 'ocr:local_paddle'"), `${name} must not offer local OCR actions`)
  assert.ok(!source.includes("key: 'ocr_force:local_paddle'"), `${name} must not offer local OCR overwrite actions`)
  assert.ok(!source.includes("key: 'rerun_ocr_book:local_paddle'"), `${name} must not offer whole-book local OCR actions`)
}

assert.ok(!settingsView.includes("{ id: 'local_paddle', label: '本地 PaddleOCR'"), 'SettingsView must not list local OCR as a provider')
assert.ok(!onboarding.includes('下载本地 OCR'), 'Onboarding must not offer local OCR installation')
assert.ok(!library.includes("{ value: 'local_paddle', label: '本地 OCR' }"), 'Library import OCR selector must not list local OCR')
assert.ok(ocrIpc.includes("if (engine === 'local_paddle') return 'paddle'"), 'main OCR routing must map legacy local OCR requests to cloud PaddleOCR')
assert.ok(settingsIpc.includes("const normalizedEngine: OcrEngine = engine === 'local_paddle' || engine === 'hybrid' ? 'paddle' : engine"), 'default OCR settings must migrate legacy local OCR to cloud PaddleOCR')
assert.ok(settingsIpc.includes('本地 OCR 功能当前已停用'), 'local OCR install/download IPC must be disabled')

console.log('Local OCR retirement regression passed.')
