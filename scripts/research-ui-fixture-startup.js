const assert = require('node:assert/strict')

async function enterResearchFixture(page, initialize = false) {
  await page.locator('[data-project-gate-ready="true"]').waitFor()
  // Research fixtures use a configured user's state; onboarding has its own tests.
  if (initialize) {
    await page.evaluate(async () => {
      for (const step of ['welcome', 'paddle_ocr', 'ai_model', 'vision_ocr', 'finish']) {
        await window.api.completeOnboardingStep(step)
      }
    })
  }
  assert(await page.evaluate(() => window.api.isOnboardingCompleted()), 'fixture onboarding must persist across reloads')
  await page.locator('[data-library-project-choice="true"]').first().click()
  await page.locator('main.app-content').waitFor()
}

module.exports = { enterResearchFixture }
