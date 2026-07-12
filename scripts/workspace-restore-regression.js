const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const esbuild = require('esbuild')

const root = path.resolve(__dirname, '..')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gujismart-workspace-'))
const bundlePath = path.join(tempRoot, 'app-workspace.cjs')

class MemoryStorage {
  constructor() {
    this.values = new Map()
  }

  getItem(key) {
    return this.values.get(key) || null
  }

  setItem(key, value) {
    this.values.set(key, String(value))
  }

  removeItem(key) {
    this.values.delete(key)
  }
}

async function main() {
  await esbuild.build({
    entryPoints: [path.join(root, 'src', 'renderer', 'src', 'utils', 'appWorkspace.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundlePath,
    logLevel: 'silent',
  })

  const {
    APP_WORKSPACE_STORAGE_KEY,
    APP_WORKSPACE_LAST_KNOWN_GOOD_KEY,
    APP_WORKSPACE_LEGACY_STORAGE_KEY,
    loadAppWorkspace,
    saveAppWorkspace,
  } = require(bundlePath)
  const storage = new MemoryStorage()
  const saved = saveAppWorkspace(storage, {
    activeTabId: 'doc:example:1',
    siderCollapsed: true,
    tabGroups: [
      { id: 'group-reading', title: '阅读组', color: '#7cb7ff', collapsed: true },
    ],
    tabs: [
      { id: 'home', kind: 'home', title: '首页' },
      {
        id: 'view:folders:1',
        kind: 'view',
        view: 'folders',
        title: '资料夹甲',
        singleton: false,
        groupId: 'group-reading',
        foldersState: {
          selectedFolderId: 'folder-1',
          selectedFolderName: '资料夹甲',
          scrollTop: 480,
        },
      },
      {
        id: 'doc:example:1',
        kind: 'document',
        groupId: 'group-reading',
        title: '示例文献',
        document: {
          docId: 'doc-1',
          target: {
            docId: 'doc-1',
            pageIndex: 12,
            keyword: '测试关键词',
            searchSession: {
              query: '不应写入工作区的大对象',
              hits: [{ id: 'hit-1' }],
              activeHitIndex: 0,
              status: 'ready',
            },
          },
        },
      },
    ],
  })
  assert.strictEqual(saved, true)

  const raw = storage.getItem(APP_WORKSPACE_STORAGE_KEY)
  assert.ok(raw)
  assert.ok(!raw.includes('searchSession'))
  assert.ok(!raw.includes('不应写入工作区的大对象'))

  const restored = loadAppWorkspace(storage)
  assert.deepStrictEqual(restored.tabs.map((tab) => tab.id), [
    'home',
    'view:folders:1',
    'doc:example:1',
  ])
  assert.deepStrictEqual(restored.tabGroups, [
    { id: 'group-reading', title: '阅读组', color: '#7cb7ff', collapsed: true },
  ])
  assert.strictEqual(restored.activeTabId, 'doc:example:1')
  assert.strictEqual(restored.siderCollapsed, true)
  assert.strictEqual(restored.tabs[1].foldersState.selectedFolderId, 'folder-1')
  assert.strictEqual(restored.tabs[1].foldersState.scrollTop, 480)
  assert.strictEqual(restored.tabs[2].document.target.pageIndex, 12)
  assert.strictEqual(restored.tabs[2].document.target.keyword, '测试关键词')

  const parsed = JSON.parse(raw)
  assert.strictEqual(parsed.version, 2)
  parsed.activeTabId = 'missing-tab'
  parsed.tabs.push(parsed.tabs[0])
  storage.setItem(APP_WORKSPACE_STORAGE_KEY, JSON.stringify(parsed))
  const repaired = loadAppWorkspace(storage)
  assert.strictEqual(repaired.activeTabId, 'home')
  assert.strictEqual(repaired.tabs.filter((tab) => tab.id === 'home').length, 1)

  storage.setItem(APP_WORKSPACE_STORAGE_KEY, '{bad json')
  const fallback = loadAppWorkspace(storage)
  assert.deepStrictEqual(fallback.tabs, [{ id: 'home', kind: 'home', title: '首页' }])
  assert.strictEqual(fallback.activeTabId, 'home')
  assert.strictEqual(storage.getItem(APP_WORKSPACE_STORAGE_KEY), null)

  storage.setItem(APP_WORKSPACE_LEGACY_STORAGE_KEY, JSON.stringify({
    version: 1,
    savedAt: '2026-01-01T00:00:00.000Z',
    activeTabId: 'home',
    siderCollapsed: false,
    tabs: [{ id: 'home', kind: 'home', title: 'Home' }],
  }))
  assert.strictEqual(loadAppWorkspace(storage).activeTabId, 'home')

  saveAppWorkspace(storage, { activeTabId: 'home', siderCollapsed: false, tabGroups: [], tabs: [{ id: 'home', kind: 'home', title: 'Home' }] })
  saveAppWorkspace(storage, { activeTabId: 'home', siderCollapsed: true, tabGroups: [], tabs: [{ id: 'home', kind: 'home', title: 'Home' }] })
  assert.ok(storage.getItem(APP_WORKSPACE_LAST_KNOWN_GOOD_KEY))
  storage.setItem(APP_WORKSPACE_STORAGE_KEY, '{corrupt')
  assert.strictEqual(loadAppWorkspace(storage).activeTabId, 'home')

  console.log('Workspace restore regression passed.')
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  })
