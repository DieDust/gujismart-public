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

function assertNotIncludes(source, needle, label) {
  if (source.includes(needle)) {
    throw new Error(`${label}: unexpected ${needle}`)
  }
}

const wizard = read('src/renderer/src/components/OnboardingWizard.tsx')
const store = read('src/renderer/src/stores/useOnboardingStore.ts')
const app = read('src/renderer/src/App.tsx')
const onboardingIpc = read('src/main/ipc/onboarding.ts')
const settingsIpc = read('src/main/ipc/settings.ts')

for (const key of ['welcome', 'paddle_ocr', 'ai_model', 'vision_ocr', 'finish']) {
  assertIncludes(wizard, key, 'wizard step keys')
  assertIncludes(store, key, 'store step keys')
  assertIncludes(app, key, 'app onboarding completion keys')
  assertIncludes(onboardingIpc, key, 'main onboarding completion keys')
}

for (const oldKey of ['api_key', 'api_guide', 'citation_format']) {
  assertNotIncludes(store, oldKey, 'store should not use legacy onboarding keys')
  assertNotIncludes(onboardingIpc, oldKey, 'main should not use legacy onboarding keys')
}

for (const apiName of [
  'getAllSettings',
  'isOnboardingCompleted',
  'completeOnboardingStep',
  'upsertLlmProviderProfile',
  'switchLlmProviderProfile',
  'upsertVisionOcrProviderProfile',
  'switchVisionOcrProviderProfile',
  'listPaddleOcrModels',
  'listModels',
]) {
  assertIncludes(wizard + app, apiName, 'onboarding API reuse')
}

assertIncludes(wizard, "if (token) await window.api.setSetting('paddleocr_api_key', token)", 'PaddleOCR skip must not clear token')
assertIncludes(wizard, "paddleApiKey.trim() || String(settings?.paddleocr_api_key || '').trim()", 'PaddleOCR model fetch should fall back to saved token')
assertIncludes(wizard, 'window.api.listPaddleOcrModels(apiKey || undefined)', 'PaddleOCR model fetch should reuse main-process saved-token fallback')
assertIncludes(wizard, "if (!baseUrl.trim() || !apiKey.trim())", 'AI model fetch should not fail when optional API key is omitted during onboarding')
assertIncludes(settingsIpc, 'comparePaddleOcrModelsNewestFirst', 'PaddleOCR model list should use newest-first model sorting')
assertIncludes(settingsIpc, '.sort(comparePaddleOcrModelsNewestFirst)', 'PaddleOCR model list should not use plain alphabetical sorting')
assertIncludes(wizard, "'vision_ocr_use_llm_config', 'true'", 'vision OCR follow-AI setting')
assertIncludes(app, 'store.open(0)', 'first-run auto open')
assertIncludes(app, 'ONBOARDING_SETTINGS_TIMEOUT', 'onboarding auto-open should distinguish settings timeout from missing config')
assertIncludes(app, 'if (settings === ONBOARDING_SETTINGS_TIMEOUT) return', 'settings timeout should not auto-open onboarding for upgraded users')
assertIncludes(app, "gujismart:onboarding-action", 'finish action bridge')
assertNotIncludes(settingsIpc, "logMetadataTagCleanup('Cleared stale metadata tag bindings while loading settings'", 'settings:getAll should not run heavy metadata cleanup while reading settings')
assertNotIncludes(settingsIpc, "logMetadataTagRebuild('Rebuilt stale metadata tag bindings while loading settings'", 'settings:getAll should not run heavy metadata rebuild while reading settings')

console.log('Onboarding wizard regression checks passed')
