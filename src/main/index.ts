import { app, BrowserWindow, dialog, protocol, shell } from 'electron'
import { join, resolve } from 'path'
import { is } from '@electron-toolkit/utils'
import { closeDatabase, initDatabase, isLargeLibraryForAutomaticMaintenance, listStoredLocalResourcePaths, resolveProfileDir, runDeferredStartupDatabaseMaintenance } from './database'
import { registerAllIpcHandlers } from './ipc'
import { createReadStream, existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { Readable } from 'stream'
import { startAutoBackupScheduler, stopAutoBackupScheduler } from './backup'
import { backfillLibraryFileFingerprints, shutdownPdfAssetRuntime } from './pdf-assets'
import { scheduleStartupMetadataReclassification } from './metadata-reclassifier'
import { allowFileAccessPaths, assertAllowedLocalResourceUrl, assertHttpUrl } from './file-access'
import { shutdownHealthReportWorkers } from './health-report-worker-client'
import { shutdownSearchIndexWorkers } from './search-index-worker-client'
import { ensureDisabledMetadataTagBindingsCleared, ensureEnabledMetadataTagBindingsRebuilt } from './metadata-tags'
import { scheduleStartupRecovery, shutdownStartupRecovery } from './startup-recovery'
import { shutdownOcrRuntime } from './ipc/ocr'
import { shutdownBookTranslationRuntime, shutdownDocumentDeleteRuntime, shutdownDocumentImportRuntime } from './ipc/documents'
import { batchProcessor } from './batch-processor'

let mainWindow: BrowserWindow | null = null
let quitConfirmed = false
let quitPromptOpen = false
let runtimeShutdownStarted = false
let runtimeShutdownPromise: Promise<void> | null = null
let startupMaintenanceScheduled = false
const STARTUP_MAINTENANCE_DELAY_MS = 15_000

type ConsoleMethodName = 'log' | 'info' | 'warn' | 'error' | 'debug'

function getLocalResourceMimeType(filePath: string): string {
  const lower = filePath.toLowerCase()
  if (lower.endsWith('.pdf')) return 'application/pdf'
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  return 'application/octet-stream'
}

function parseRangeHeader(rangeHeader: string | null, fileSize: number): { start: number; end: number } | null {
  if (!rangeHeader) return null
  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim())
  if (!match) return null

  const [, rawStart, rawEnd] = match
  if (!rawStart && !rawEnd) return null

  if (!rawStart) {
    const suffixLength = Number.parseInt(rawEnd, 10)
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null
    return {
      start: Math.max(0, fileSize - suffixLength),
      end: Math.max(0, fileSize - 1),
    }
  }

  const start = Number.parseInt(rawStart, 10)
  const end = rawEnd ? Number.parseInt(rawEnd, 10) : fileSize - 1
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= fileSize) return null
  return {
    start,
    end: Math.min(end, fileSize - 1),
  }
}

function streamFileResponse(filePath: string, request: Request): Response {
  const fileStat = statSync(filePath)
  if (!fileStat.isFile() || fileStat.size <= 0) {
    return new Response('Local resource is not a readable file', { status: 404 })
  }

  const range = parseRangeHeader(request.headers.get('range'), fileStat.size)
  const headers = new Headers({
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'Content-Type': getLocalResourceMimeType(filePath),
  })

  if (request.headers.get('range') && !range) {
    headers.set('Content-Range', `bytes */${fileStat.size}`)
    return new Response(null, { status: 416, headers })
  }

  const start = range?.start ?? 0
  const end = range?.end ?? fileStat.size - 1
  const contentLength = Math.max(0, end - start + 1)
  headers.set('Content-Length', String(contentLength))
  if (range) headers.set('Content-Range', `bytes ${start}-${end}/${fileStat.size}`)

  if (request.method === 'HEAD') {
    return new Response(null, { status: range ? 206 : 200, headers })
  }

  const nodeStream = createReadStream(filePath, { start, end })
  const body = Readable.toWeb(nodeStream) as unknown as BodyInit
  return new Response(body, { status: range ? 206 : 200, headers })
}

function isBrokenPipeError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && String((error as { code?: unknown }).code) === 'EPIPE'
}

function installConsolePipeGuards(): void {
  const methods: ConsoleMethodName[] = ['log', 'info', 'warn', 'error', 'debug']
  for (const method of methods) {
    const original = console[method].bind(console) as (...data: unknown[]) => void
    Object.defineProperty(console, method, {
      configurable: true,
      writable: true,
      value: (...data: unknown[]) => {
        try {
          original(...data)
        } catch (error) {
          if (!isBrokenPipeError(error)) throw error
        }
      },
    })
  }

  const ignoreBrokenPipe = (error: unknown) => {
    if (isBrokenPipeError(error)) return
    throw error
  }
  process.stdout?.on('error', ignoreBrokenPipe)
  process.stderr?.on('error', ignoreBrokenPipe)
}

installConsolePipeGuards()

const profileRoot = process.env.GUJISMART_PROFILE_DIR
  ? resolve(process.env.GUJISMART_PROFILE_DIR)
  : is.dev
    ? join(process.cwd(), 'data', 'profile')
    : resolveProfileDir()

try {
  if (!existsSync(profileRoot)) {
    mkdirSync(profileRoot, { recursive: true })
  }
  const profileWriteProbe = join(profileRoot, '.write-test')
  writeFileSync(profileWriteProbe, 'ok')
  unlinkSync(profileWriteProbe)
} catch (error) {
  const softwareDir = is.dev ? process.cwd() : resolve(profileRoot, '..', '..')
  dialog.showErrorBox(
    '无法打开文献库数据目录',
    `当前软件目录不可写，GujiSmart 无法在当前目录保存数据库和缓存。\n\n请把软件目录移动到可写位置，或调整目录权限后重试。\n\n软件目录：${softwareDir}`,
  )
  console.error('[App] Failed to prepare profile directory', error)
  app.exit(1)
  throw error
}

app.setPath('userData', profileRoot)
app.commandLine.appendSwitch('disable-logging')
app.commandLine.appendSwitch('log-level', '3')

if (process.platform === 'win32' || process.env.GUJISMART_SMOKE === '1') {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('disable-gpu-compositing')
  app.commandLine.appendSwitch('disable-gpu-rasterization')
  app.commandLine.appendSwitch('disable-gpu-sandbox')
  app.commandLine.appendSwitch('disable-gpu-watchdog')
  app.commandLine.appendSwitch('disable-gpu-process-crash-limit')
  app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')
  app.commandLine.appendSwitch('use-angle', 'swiftshader')
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    backgroundColor: '#0a0a0a',
    autoHideMenuBar: true,
    title: '文献管理',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  let windowShownInitialized = false
  let windowShowFallbackTimer: NodeJS.Timeout | null = null
  let rendererRecoveryAttempts = 0
  let rendererRecoveryResetTimer: NodeJS.Timeout | null = null
  const showWindowIfNeeded = (win: BrowserWindow): void => {
    if (!win.isVisible()) {
      win.show()
      win.focus()
    }
  }
  const showMainWindowFallback = (reason: string): void => {
    const win = mainWindow
    if (!win || win.isDestroyed()) return
    if (windowShownInitialized) return
    windowShownInitialized = true
    if (windowShowFallbackTimer) {
      clearTimeout(windowShowFallbackTimer)
      windowShowFallbackTimer = null
    }
    console.log(`[Main] Showing main window via ${reason}`)
    showWindowIfNeeded(win)
    batchProcessor.setMainWindow(win)
    scheduleStartupRecovery()
    scheduleStartupMaintenance()
  }

  mainWindow.on('ready-to-show', () => {
    if (!mainWindow || mainWindow.isDestroyed() || windowShownInitialized) return
    scheduleStartupRecovery()
    scheduleStartupMaintenance()
    windowShownInitialized = true
    if (windowShowFallbackTimer) {
      clearTimeout(windowShowFallbackTimer)
      windowShowFallbackTimer = null
    }
    console.log('[Main] Showing main window via ready-to-show')
    const win = mainWindow
    showWindowIfNeeded(win)
    batchProcessor.setMainWindow(win)
  })

  mainWindow.webContents.on('did-finish-load', () => {
    console.log(`[Main] Renderer finished loading: ${mainWindow?.webContents.getURL() || ''}`)
    showMainWindowFallback('did-finish-load')
    if (rendererRecoveryResetTimer) {
      clearTimeout(rendererRecoveryResetTimer)
    }
    rendererRecoveryResetTimer = setTimeout(() => {
      rendererRecoveryAttempts = 0
      rendererRecoveryResetTimer = null
    }, 15000)
    rendererRecoveryResetTimer.unref?.()
  })

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`[Main] Failed to load renderer (${errorCode}): ${errorDescription} ${validatedURL}`)
    showMainWindowFallback('did-fail-load')
  })

  if (is.dev || process.env.GUJISMART_SMOKE === '1') {
    mainWindow.webContents.on('console-message', (details) => {
      console.log(`[Renderer:${details.level}] ${details.message} (${details.sourceId}:${details.lineNumber})`)
    })
  }

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[Main] Renderer process gone: reason=${details.reason}; exitCode=${details.exitCode}`)
    const win = mainWindow
    if (
      !win
      || win.isDestroyed()
      || quitConfirmed
      || details.reason === 'clean-exit'
    ) {
      return
    }
    if (rendererRecoveryResetTimer) {
      clearTimeout(rendererRecoveryResetTimer)
      rendererRecoveryResetTimer = null
    }
    if (rendererRecoveryAttempts >= 2) {
      void dialog.showMessageBox(win, {
        type: 'error',
        title: '页面渲染失败',
        message: '界面连续加载失败，请重启软件。',
        detail: '文献库数据仍保存在本地，不会因本次界面异常而丢失。',
        buttons: ['关闭软件'],
        defaultId: 0,
        noLink: true,
      }).finally(() => {
        quitConfirmed = true
        app.quit()
      })
      return
    }
    rendererRecoveryAttempts += 1
    setTimeout(() => {
      if (!win.isDestroyed()) {
        console.warn(`[Main] Reloading renderer after process failure (attempt ${rendererRecoveryAttempts}/2)`)
        win.webContents.reload()
      }
    }, 500).unref?.()
  })

  const windowShowFallbackDelayMs = is.dev ? 12000 : 8000
  windowShowFallbackTimer = setTimeout(() => {
    showMainWindowFallback(`startup fallback after ${windowShowFallbackDelayMs}ms`)
  }, windowShowFallbackDelayMs)
  windowShowFallbackTimer.unref?.()

  setTimeout(() => {
    const win = mainWindow
    if (!win || win.isDestroyed()) return
    win.webContents.executeJavaScript(`
      (() => {
        const root = document.getElementById('root')
        return {
          url: location.href,
          title: document.title,
          rootTextLength: root?.textContent?.trim().length || 0,
          rootHtmlLength: root?.innerHTML?.length || 0,
          bodyTextLength: document.body?.textContent?.trim().length || 0,
        }
      })()
    `).then((state) => {
      if (!state?.rootTextLength && !state?.rootHtmlLength) {
        console.warn(`[Main] Renderer root is still empty after startup: ${JSON.stringify(state)}`)
      }
    }).catch((error) => {
      console.warn('[Main] Failed to inspect renderer startup state', error)
    })
  }, is.dev ? 6000 : 10000).unref?.()

  mainWindow.on('close', (event) => {
    if (quitConfirmed || process.env.GUJISMART_SMOKE === '1') return
    const win = mainWindow
    if (!win || win.isDestroyed()) return
    event.preventDefault()
    if (quitPromptOpen) return
    quitPromptOpen = true
    void dialog.showMessageBox(win, {
      type: 'question',
      title: '退出文献管理？',
      message: '确认退出文献管理程序吗？',
      detail: '这会关闭所有窗口。如果只是退出当前文献，请使用页面左上角的“返回”。',
      buttons: ['退出程序', '取消'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    }).then(({ response }) => {
      quitPromptOpen = false
      if (response !== 0) return
      quitConfirmed = true
      app.quit()
    }).catch(() => {
      quitPromptOpen = false
    })
  })

  mainWindow.setMenuBarVisibility(false)
  mainWindow.removeMenu()

  mainWindow.webContents.setWindowOpenHandler((details) => {
    try {
      shell.openExternal(assertHttpUrl(details.url))
    } catch (error) {
      console.warn('[Main] Blocked external navigation:', details.url, error)
    }
    return { action: 'deny' }
  })

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

async function shutdownApplicationRuntime(): Promise<void> {
  if (runtimeShutdownPromise) return runtimeShutdownPromise
  runtimeShutdownStarted = true
  runtimeShutdownPromise = (async () => {
    stopAutoBackupScheduler()
    await shutdownStartupRecovery().catch((error) => {
      console.warn('[Main] Failed to shutdown startup recovery cleanly', error)
    })
    await shutdownOcrRuntime().catch((error) => {
      console.warn('[Main] Failed to shutdown OCR runtime cleanly', error)
    })
    await shutdownDocumentImportRuntime().catch((error) => {
      console.warn('[Main] Failed to shutdown document import runtime cleanly', error)
    })
    await batchProcessor.shutdownRuntime().catch((error) => {
      console.warn('[Main] Failed to shutdown batch processor cleanly', error)
    })
    await shutdownBookTranslationRuntime().catch((error) => {
      console.warn('[Main] Failed to shutdown book translation runtime cleanly', error)
    })
    await shutdownDocumentDeleteRuntime().catch((error) => {
      console.warn('[Main] Failed to shutdown document delete runtime cleanly', error)
    })
    await shutdownPdfAssetRuntime().catch((error) => {
      console.warn('[Main] Failed to shutdown PDF asset runtime cleanly', error)
    })
    await Promise.allSettled([
      shutdownHealthReportWorkers(),
      shutdownSearchIndexWorkers(),
    ])
    closeDatabase()
  })()
  return runtimeShutdownPromise
}

function scheduleStartupMaintenance(): void {
  if (startupMaintenanceScheduled) return
  startupMaintenanceScheduled = true
  setTimeout(() => {
    void (async () => {
      try {
        runDeferredStartupDatabaseMaintenance()
      } catch (error) {
        console.warn('[Main] Failed to run deferred database maintenance', error)
      }

      try {
        if (isLargeLibraryForAutomaticMaintenance()) {
          console.log('[Main] Skipping automatic metadata tag reconciliation during startup because the library is large.')
        } else {
          const cleanup = ensureDisabledMetadataTagBindingsCleared()
          if (cleanup && (cleanup.removedRelations > 0 || cleanup.keptManualRelations > 0 || cleanup.removedTags > 0)) {
            console.log(
              `[Main] Cleared stale metadata tag bindings: removed=${cleanup.removedRelations}, keptManual=${cleanup.keptManualRelations}, removedTags=${cleanup.removedTags}`,
            )
          }
          const rebuild = await ensureEnabledMetadataTagBindingsRebuilt()
          if (rebuild && (rebuild.syncedDocuments > 0 || rebuild.createdOrUpdatedRelations > 0)) {
            console.log(
              `[Main] Rebuilt metadata tag bindings: processed=${rebuild.processedDocuments}, synced=${rebuild.syncedDocuments}, skipped=${rebuild.skippedDocuments}, relations=${rebuild.createdOrUpdatedRelations}`,
            )
          }
        }
      } catch (error) {
        console.warn('[Main] Failed to reconcile metadata tag bindings', error)
      }

      scheduleStartupMetadataReclassification()
    })()
  }, STARTUP_MAINTENANCE_DELAY_MS).unref?.()
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'local-resource',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      bypassCSP: true,
      corsEnabled: true
    }
  }
])

app.whenReady()
  .then(async () => {
    protocol.handle('local-resource', (request) => {
      const filePath = assertAllowedLocalResourceUrl(request.url)
      return streamFileResponse(filePath, request)
    })

    await initDatabase()
    registerAllIpcHandlers()
    createWindow()
    setTimeout(() => {
      try {
        allowFileAccessPaths(listStoredLocalResourcePaths({ includePageImages: false }))
      } catch (error) {
        console.warn('[Main] Failed to preload stored local resource paths', error)
      }
    }, STARTUP_MAINTENANCE_DELAY_MS).unref?.()
    startAutoBackupScheduler()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow()
      }
    })
  })
  .catch((error) => {
    console.error('[Main] Failed to initialize application', error)
    app.quit()
  })

app.on('window-all-closed', () => {
  void shutdownApplicationRuntime().finally(() => {
    app.quit()
  })
})

app.on('before-quit', (event) => {
  if (runtimeShutdownStarted) return
  event.preventDefault()
  void shutdownApplicationRuntime().finally(() => {
    quitConfirmed = true
    app.quit()
  })
})

