// Exercise the built application without creating a window or opening a user database.
const assert = require('node:assert/strict')
const { mkdtempSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { spawnSync } = require('node:child_process')
const root = join(__dirname, '..')
const temp = mkdtempSync(join(tmpdir(), 'gujismart-headless-error-'))
const blockedProfile = join(temp, 'profile-is-a-file')
writeFileSync(blockedProfile, 'fixture')

for (const mode of ['mcp', 'headless', 'smoke']) {
  const env = {
    ...process.env, GUJISMART_PROFILE_DIR: blockedProfile, GUJISMART_DATA_DIR: join(temp, 'data'),
    GUJISMART_HEADLESS: mode === 'headless' ? '1' : '0', GUJISMART_SMOKE: mode === 'smoke' ? '1' : '0',
  }
  delete env.ELECTRON_RUN_AS_NODE
  const result = spawnSync(require('electron'), ['.', ...(mode === 'mcp' ? ['--mcp'] : [])], {
    cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 8000,
  })
  assert(!result.error, `${mode}: process must exit instead of blocking on a modal: ${result.error}`)
  assert.equal(result.status, 1, `${mode}: expected a controlled startup failure`)
  assert.match(result.stderr, /Failed to prepare profile directory/)
  assert.match(result.stderr, /EEXIST|ENOTDIR/)
}
console.log('Built-app startup errors exit without dialogs in MCP, headless and smoke modes.')
