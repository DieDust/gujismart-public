const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { buildSync } = require('esbuild')
const { Module } = require('module')

const root = path.resolve(__dirname, '..')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gujismart-settings-security-integration-'))
const dataDir = path.join(tempRoot, 'data')
const profileDir = path.join(tempRoot, 'profile')
const bundlePath = path.join(tempRoot, 'settings-security.cjs')
const entryPath = path.join(tempRoot, 'entry.js')
const electronStubPath = path.join(tempRoot, 'electron-stub.js')

process.env.GUJISMART_DATA_DIR = dataDir
process.env.GUJISMART_AUTO_REINDEX = '0'
process.env.NODE_PATH = path.join(root, 'node_modules')
Module._initPaths()

fs.writeFileSync(electronStubPath, `
  const path = require('path')
  exports.app = {
    getPath: (name) => name === 'userData' ? ${JSON.stringify(profileDir)} : ${JSON.stringify(tempRoot)},
    getAppPath: () => ${JSON.stringify(root)},
    isPackaged: false,
  }
  exports.safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from('os-protected:' + Buffer.from(value).toString('base64'), 'utf8'),
    decryptString: (value) => {
      const raw = Buffer.from(value).toString('utf8')
      if (!raw.startsWith('os-protected:')) throw new Error('invalid ciphertext')
      return Buffer.from(raw.slice('os-protected:'.length), 'base64').toString('utf8')
    },
  }
`)

fs.writeFileSync(entryPath, `
  const database = require(${JSON.stringify(path.join(root, 'src', 'main', 'database.ts'))})
  const security = require(${JSON.stringify(path.join(root, 'src', 'main', 'settings-security.ts'))})
  module.exports = { database, security }
`)

function allDatabaseBytesDoNotContain(needle) {
  const dbDir = path.join(dataDir, 'db')
  const files = fs.existsSync(dbDir) ? fs.readdirSync(dbDir) : []
  return files.every((name) => !fs.readFileSync(path.join(dbDir, name)).includes(Buffer.from(needle, 'utf8')))
}

async function run() {
  let database
  try {
    buildSync({
      entryPoints: [entryPath],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: bundlePath,
      external: ['better-sqlite3'],
      alias: {
        electron: electronStubPath,
        '@electron-toolkit/utils': path.join(root, 'scripts', 'stubs', 'electron-toolkit-utils.js'),
      },
      logLevel: 'silent',
    })

    const modules = require(bundlePath)
    database = modules.database
    await database.initDatabase()
    const secrets = {
      llm_api_key: ['legacy', 'llm', 'unique', 'secret'].join('-'),
      paddleocr_api_key: ['legacy', 'paddle', 'unique', 'secret'].join('-'),
      vision_ocr_api_key: ['legacy', 'vision', 'unique', 'secret'].join('-'),
    }
    const profileSecret = ['legacy', 'profile', 'unique', 'secret'].join('-')
    for (const [key, value] of Object.entries(secrets)) {
      database.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, value])
    }
    database.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [
      'llm_provider_profiles',
      JSON.stringify([{ id: 'fixture-profile', name: 'Fixture', provider: 'Fixture', baseUrl: 'https://example.invalid/v1', apiKey: profileSecret, model: 'fixture' }]),
    ])
    database.getDatabase().pragma('wal_checkpoint(TRUNCATE)')

    const first = modules.security.initializeSettingsSecurity()
    assert.deepStrictEqual(first.migratedKeys.sort(), Object.keys(secrets).sort())
    assert.deepStrictEqual(first.migratedProfiles, ['llm_provider_profiles'])
    for (const [key, value] of Object.entries(secrets)) {
      assert.strictEqual(database.queryOne('SELECT value FROM settings WHERE key = ?', [key]), null)
      assert.strictEqual(modules.security.readProtectedSetting(key), value)
    }
    assert.strictEqual(modules.security.readProtectedSetting('llm_profile:fixture-profile'), profileSecret)

    const publicSnapshot = modules.security.getPublicSettingsMap()
    assert.strictEqual(publicSnapshot.llm_api_key_configured, 'true')
    assert.ok(!JSON.stringify(publicSnapshot).includes(secrets.llm_api_key))
    assert.ok(!JSON.stringify(publicSnapshot).includes(profileSecret))
    const storedProfiles = database.queryOne('SELECT value FROM settings WHERE key = ?', ['llm_provider_profiles']).value
    assert.ok(!storedProfiles.includes(profileSecret))

    const second = modules.security.initializeSettingsSecurity()
    assert.deepStrictEqual(second.migratedKeys, [], 'credential migration must be idempotent')
    assert.deepStrictEqual(second.migratedProfiles, [], 'profile migration must be idempotent')
    database.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', ['credentials_required_after_restore', 'true'])
    const restored = modules.security.initializeSettingsSecurity()
    assert.strictEqual(restored.credentialsReset, true)
    assert.strictEqual(modules.security.readProtectedSetting('llm_api_key'), '')
    assert.strictEqual(modules.security.readProtectedSetting('llm_profile:fixture-profile'), '')
    assert.strictEqual(database.queryOne('SELECT value FROM settings WHERE key = ?', ['credentials_required_after_restore']), null)
    database.closeDatabase()
    database = null

    for (const secret of [...Object.values(secrets), profileSecret]) {
      assert.ok(allDatabaseBytesDoNotContain(secret), `database and WAL must not retain plaintext secret: ${secret}`)
    }
    const sidecar = fs.readFileSync(path.join(profileDir, 'secrets', 'credentials.v1.json'), 'utf8')
    for (const secret of [...Object.values(secrets), profileSecret]) {
      assert.ok(!sidecar.includes(secret), `sidecar must not contain plaintext secret: ${secret}`)
    }

    console.log('Settings security SQLite integration regression checks passed.')
  } finally {
    database?.closeDatabase()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
