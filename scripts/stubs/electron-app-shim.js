/**
 * Minimal Electron `app` shim for MCP host under ELECTRON_RUN_AS_NODE.
 * Real BrowserWindow / IPC are not available; only paths needed by database init.
 */
const { homedir } = require('os')
const { join, dirname } = require('path')

const appName = '文献管理'
const exePath = process.execPath
const userData = process.env.GUJISMART_USER_DATA
  || join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), appName)

const app = {
  isPackaged: process.env.GUJISMART_MCP_PACKAGED === '1',
  getName: () => appName,
  getVersion: () => process.env.npm_package_version || '0.0.0',
  getAppPath: () => process.env.GUJISMART_APP_PATH || process.cwd(),
  getPath: (name) => {
    if (name === 'exe') return exePath
    if (name === 'userData' || name === 'appData') return name === 'appData'
      ? dirname(userData)
      : userData
    if (name === 'temp') return require('os').tmpdir()
    if (name === 'home') return homedir()
    if (name === 'desktop') return join(homedir(), 'Desktop')
    if (name === 'documents') return join(homedir(), 'Documents')
    return userData
  },
  whenReady: () => Promise.resolve(),
  isReady: () => true,
  on: () => app,
  once: () => app,
  removeListener: () => app,
  exit: (code = 0) => {
    process.exit(code)
  },
  quit: () => {
    process.exit(0)
  },
  disableHardwareAcceleration: () => {},
  requestSingleInstanceLock: () => true,
  commandLine: {
    appendSwitch: () => {},
  },
}

module.exports = {
  app,
  BrowserWindow: class BrowserWindow {},
  dialog: {
    showErrorBox: () => {},
    showMessageBox: async () => ({ response: 0 }),
  },
  ipcMain: {
    handle: () => {},
    on: () => {},
    removeHandler: () => {},
  },
  protocol: {
    registerSchemesAsPrivileged: () => {},
    handle: () => {},
  },
  shell: {
    openExternal: async () => {},
    openPath: async () => '',
  },
  nativeImage: {
    createEmpty: () => ({}),
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value) => Buffer.from(String(value || ''), 'utf8'),
    decryptString: (buffer) => Buffer.from(buffer || []).toString('utf8'),
  },
}
