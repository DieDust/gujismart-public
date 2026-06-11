const { _electron: electron } = require('playwright')
const fs = require('fs')
const os = require('os')
const path = require('path')

const LABEL_SETTINGS = '\u8bbe\u7f6e'
const LABEL_SAVE_SETTINGS = '\u4fdd\u5b58\u8bbe\u7f6e'
const LABEL_SLOT_COUNT = '\u81ea\u52a8\u5907\u4efd\u69fd\u4f4d\u6570\u91cf'
const LABEL_KEEP_TWO = '\u5f53\u524d\u4fdd\u7559 2 \u4e2a\u69fd\u4f4d'
const LABEL_KEEP_THREE = '\u5f53\u524d\u4fdd\u7559 3 \u4e2a\u69fd\u4f4d'

function fail(message, details) {
  const suffix = details ? `\n${JSON.stringify(details, null, 2)}` : ''
  throw new Error(`${message}${suffix}`)
}

async function clickMenu(window, label) {
  const items = window.locator('.ant-menu-item, .ant-menu-submenu-title')
  const index = await items.evaluateAll((nodes, target) => {
    return nodes.findIndex((node) => (node.textContent || '').trim() === target)
  }, label)
  if (index < 0) fail(`Missing menu item: ${label}`)
  await items.nth(index).click()
  await window.waitForTimeout(700)
}

async function waitForBackupSlotCount(window, slotCount, timeoutMs = 8000) {
  const startedAt = Date.now()
  let status = null
  while (Date.now() - startedAt < timeoutMs) {
    status = await window.evaluate(async () => window.api.getBackupStatus())
    if (status.slotCount === slotCount) return status
    await window.waitForTimeout(200)
  }
  fail(`Timed out waiting for backup slot count ${slotCount}`, status)
}

async function run() {
  const userDataDir = path.join(os.tmpdir(), `gujismart-slot-ui-${Date.now()}`)
  const dataDir = path.join(os.tmpdir(), `gujismart-slot-data-${Date.now()}`)
  const app = await electron.launch({
    args: ['--disable-gpu', `--user-data-dir=${userDataDir}`, '.'],
    cwd: process.cwd(),
    env: {
      ...process.env,
      GUJISMART_SMOKE: '1',
      GUJISMART_DATA_DIR: dataDir,
    },
  })

  try {
    const window = await app.firstWindow({ timeout: 20000 })
    await window.waitForLoadState('domcontentloaded')
    await window.waitForTimeout(1500)

    await clickMenu(window, LABEL_SETTINGS)
    await window.waitForFunction((label) => {
      return (document.querySelector('main')?.textContent || '').includes(label)
    }, LABEL_SLOT_COUNT)

    const initialStatus = await window.evaluate(async () => window.api.getBackupStatus())
    if (initialStatus.slotCount !== 3) {
      fail('Expected a fresh profile to start with 3 backup slots', initialStatus)
    }
    const extraSlotDir = path.join(initialStatus.autoBackupRoot, 'slot-3')
    fs.mkdirSync(extraSlotDir, { recursive: true })
    fs.writeFileSync(path.join(extraSlotDir, 'probe.txt'), 'extra slot should be removed')

    const slotInput = window.locator('input[role="spinbutton"][aria-valuemin="1"][aria-valuemax="3"]').first()
    await slotInput.fill('2')
    await slotInput.press('Tab')
    await window.waitForFunction((label) => {
      return (document.querySelector('main')?.textContent || '').includes(label)
    }, LABEL_KEEP_TWO)

    await window.getByRole('button', { name: new RegExp(LABEL_SAVE_SETTINGS) }).click()
    await waitForBackupSlotCount(window, 2)

    const result = await window.evaluate(async ({ keepTwo, keepThree }) => {
      const status = await window.api.getBackupStatus()
      const settings = await window.api.getAllSettings()
      const mainText = document.querySelector('main')?.textContent || ''
      return {
        status,
        settingsSlotCount: settings.auto_backup_slot_count,
        mainTextIncludesTwo: mainText.includes(keepTwo),
        mainTextIncludesThree: mainText.includes(keepThree),
        notices: Array.from(document.querySelectorAll('.ant-message-notice-content')).map((node) => node.textContent || ''),
      }
    }, { keepTwo: LABEL_KEEP_TWO, keepThree: LABEL_KEEP_THREE })

    const dbPath = path.join(dataDir, 'db', 'gujismart.db')
    if (!fs.existsSync(dbPath)) fail(`Database was not created: ${dbPath}`)
    if (result.status.slotCount !== 2) fail('getBackupStatus did not return slotCount=2 after saving', result)
    if (result.settingsSlotCount !== '2') fail('Setting auto_backup_slot_count was not saved as 2', result)
    if (!result.mainTextIncludesTwo || result.mainTextIncludesThree) fail('Settings UI did not stay on 2 slots after saving', result)
    if (fs.existsSync(extraSlotDir)) fail('slot-3 directory still exists after reducing backup slot count to 2', { extraSlotDir, result })

    console.log('Backup slot regression passed.')
    console.log(JSON.stringify({
      statusSlotCount: result.status.slotCount,
      settingsSlotCount: result.settingsSlotCount,
      removedExtraSlotDir: !fs.existsSync(extraSlotDir),
      notices: result.notices,
      dataDir,
    }, null, 2))
  } finally {
    await app.close()
  }
}

run().catch((error) => {
  console.error('Backup slot regression failed.')
  console.error(error)
  process.exit(1)
})
