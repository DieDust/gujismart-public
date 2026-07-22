import { app, BrowserWindow, screen } from 'electron'
import type { StartupTimingUiSnapshot } from './startup-timing'
import {
  getStartupTimingUiSnapshot,
  markStartupDiagnosticsSession,
  setStartupTimingUiPublisher,
} from './startup-timing'

let splashWindow: BrowserWindow | null = null
let elapsedTimer: ReturnType<typeof setInterval> | null = null
let closed = false
let diagnosticsReady = false

function buildSplashHtml(): string {
  const appVersion = (() => {
    try {
      return String(app.getVersion() || '').trim() || 'unknown'
    } catch {
      return 'unknown'
    }
  })()
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:;" />
  <title>文献管理 · 启动诊断（测试）</title>
  <style>
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      font-family: "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
      background: #0a0a0a;
      color: #e8e2d9;
      user-select: text;
    }
    .wrap {
      height: 100%;
      padding: 24px 28px 20px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .title-row {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
    }
    h1 {
      margin: 0;
      font-size: 20px;
      font-weight: 600;
      color: #f0e6d8;
      letter-spacing: 0.02em;
    }
    .elapsed {
      font-size: 13px;
      color: #c4ad84;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .banner {
      display: none;
      padding: 12px 14px;
      border-radius: 10px;
      border: 1px solid rgba(129, 199, 132, 0.45);
      background: rgba(129, 199, 132, 0.12);
      color: #d7f0d9;
      font-size: 13px;
      line-height: 1.55;
    }
    .banner.is-visible { display: block; }
    .banner strong { color: #b8efbc; }
    .hint {
      margin: 0;
      font-size: 13px;
      line-height: 1.55;
      color: #9a9186;
    }
    .hint strong { color: #d4ad84; font-weight: 600; }
    .current {
      padding: 14px 16px;
      border-radius: 10px;
      border: 1px solid rgba(212, 173, 132, 0.28);
      background: rgba(212, 173, 132, 0.08);
    }
    body.is-ready .current {
      border-color: rgba(129, 199, 132, 0.4);
      background: rgba(129, 199, 132, 0.1);
    }
    .current-label {
      font-size: 16px;
      font-weight: 600;
      color: #f3e7d7;
      margin-bottom: 4px;
    }
    .current-detail {
      font-size: 12px;
      color: #b8ae9f;
      word-break: break-all;
    }
    .bar {
      height: 4px;
      border-radius: 99px;
      background: rgba(255,255,255,0.06);
      overflow: hidden;
    }
    body.is-ready .bar { display: none; }
    .bar > i {
      display: block;
      height: 100%;
      width: 36%;
      border-radius: 99px;
      background: linear-gradient(90deg, rgba(212,173,132,0.2), #d4ad84, rgba(212,173,132,0.2));
      animation: slide 1.2s ease-in-out infinite;
    }
    @keyframes slide {
      0% { transform: translateX(-120%); }
      100% { transform: translateX(320%); }
    }
    .stats {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: 8px;
    }
    .stat {
      padding: 10px 12px;
      border-radius: 8px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(255,255,255,0.03);
    }
    .stat-k { font-size: 11px; color: #8a8176; margin-bottom: 4px; }
    .stat-v { font-size: 13px; color: #e8c9a0; font-variant-numeric: tabular-nums; font-weight: 600; }
    .list-title {
      font-size: 12px;
      color: #8a8176;
      margin-top: 2px;
      display: flex;
      justify-content: space-between;
      gap: 8px;
    }
    .list {
      flex: 1;
      min-height: 0;
      overflow: auto;
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 10px;
      background: rgba(0,0,0,0.28);
      padding: 8px 0;
      font-size: 12px;
      font-variant-numeric: tabular-nums;
    }
    .row {
      display: grid;
      grid-template-columns: 72px 1fr auto;
      gap: 8px;
      padding: 6px 12px;
      color: #cfc6ba;
      align-items: baseline;
    }
    .row.is-open { color: #e8c9a0; }
    .row.is-slow { color: #ffcc80; background: rgba(255, 171, 64, 0.08); }
    .row.is-nested { opacity: 0.72; }
    .row .at { color: #8a8176; }
    .row .ms { color: #9a9186; white-space: nowrap; }
    .row.is-open .ms { color: #d4ad84; }
    .row.is-slow .ms { color: #ffb74d; font-weight: 600; }
    .footer {
      font-size: 11px;
      color: #6f675e;
      line-height: 1.5;
    }
    code {
      font-family: ui-monospace, Consolas, monospace;
      font-size: 11px;
      color: #b8ae9f;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="title-row">
      <h1 id="title">文献管理 · 启动诊断（测试版）</h1>
      <div class="elapsed" id="elapsed">已用时 0.0 秒</div>
    </div>
    <div class="banner" id="banner">
      <strong>启动诊断已可截图。</strong>
      请把<strong>整个本窗口</strong>截图发给开发者（含总用时与下方每一步毫秒）。主程序可正常使用；看完可关闭本窗口。
    </div>
    <p class="hint" id="hint">
      这是<strong>内部测试版</strong>诊断窗口，不会自动关闭。
      启动过程中请<strong>不要强关</strong>；全部结束后请<strong>截图本窗口</strong>反馈最慢的步骤。
    </p>
    <div class="stats">
      <div class="stat"><div class="stat-k">墙钟总用时</div><div class="stat-v" id="statWall">—</div></div>
      <div class="stat"><div class="stat-k">已计量工作</div><div class="stat-v" id="statWork">—</div></div>
      <div class="stat"><div class="stat-k">未计量间隔</div><div class="stat-v" id="statGap">—</div></div>
    </div>
    <div class="current">
      <div class="current-label" id="current">准备启动…</div>
      <div class="current-detail" id="detail">初始化中</div>
    </div>
    <div class="bar" id="bar"><i></i></div>
    <div class="list-title">
      <span>时间轴（起点相对启动；耗时=该步工作时间）</span>
      <span id="slowHint"></span>
    </div>
    <div class="list" id="list"></div>
    <div class="footer">
      墙钟总用时 ≠ 各步毫秒简单相加：中间有等待（如首屏后延迟恢复）、界面加载、以及嵌套子步骤（缩进行不重复计入「已计量工作」）。
      日志前缀 <code>[StartupTiming]</code> · 窗口保留到手动关闭 · 版本 <code id="appVersion">${appVersion}</code>
    </div>
  </div>
  <script>
    const { ipcRenderer } = require('electron');
    const elapsedEl = document.getElementById('elapsed');
    const currentEl = document.getElementById('current');
    const detailEl = document.getElementById('detail');
    const listEl = document.getElementById('list');
    const bannerEl = document.getElementById('banner');
    const titleEl = document.getElementById('title');
    const slowHintEl = document.getElementById('slowHint');
    const statWallEl = document.getElementById('statWall');
    const statWorkEl = document.getElementById('statWork');
    const statGapEl = document.getElementById('statGap');
    let bootAt = Date.now();
    let frozenElapsedMs = null;

    function formatDuration(ms) {
      const value = Math.max(0, Math.round(Number(ms) || 0));
      if (value < 1000) return value + ' ms';
      return (value / 1000).toFixed(2) + ' 秒（' + value + ' ms）';
    }

    function formatOffset(ms) {
      const value = Math.max(0, Number(ms) || 0);
      if (value < 1000) return '+' + Math.round(value) + 'ms';
      return '+' + (value / 1000).toFixed(2) + 's';
    }

    function render(snap) {
      if (!snap) return;
      if (typeof snap.bootAtMs === 'number' && snap.bootAtMs > 0) bootAt = snap.bootAtMs;
      const ready = !!snap.diagnosticsReady;
      const since = typeof snap.sinceBootMs === 'number' ? snap.sinceBootMs : (Date.now() - bootAt);
      const workMs = Number(snap.measuredLeafWorkMs || 0);
      const gapMs = Number(snap.unaccountedGapMs || Math.max(0, since - workMs));

      if (ready) {
        frozenElapsedMs = typeof snap.diagnosticsReadyAtMs === 'number'
          ? snap.diagnosticsReadyAtMs
          : (frozenElapsedMs == null ? since : frozenElapsedMs);
        document.body.classList.add('is-ready');
        bannerEl.classList.add('is-visible');
        titleEl.textContent = '文献管理 · 启动诊断完成（请截图）';
        document.title = '文献管理 · 启动诊断完成（请截图）';
        elapsedEl.textContent = '墙钟 ' + formatDuration(frozenElapsedMs);
        currentEl.textContent = snap.currentLabel || '启动与后台恢复已结束';
        detailEl.textContent = snap.currentDetail || '请截图本窗口发给开发者';
      } else {
        document.body.classList.remove('is-ready');
        bannerEl.classList.remove('is-visible');
        titleEl.textContent = '文献管理 · 启动诊断（测试版）';
        elapsedEl.textContent = '墙钟 ' + formatDuration(since);
        currentEl.textContent = snap.currentLabel || '正在启动…';
        detailEl.textContent = snap.currentDetail || snap.currentPhase || '';
      }

      const wallForStats = ready && frozenElapsedMs != null ? frozenElapsedMs : since;
      statWallEl.textContent = formatDuration(wallForStats);
      statWorkEl.textContent = formatDuration(workMs);
      statGapEl.textContent = formatDuration(ready ? Math.max(0, wallForStats - workMs) : gapMs);

      const phases = snap.phases || [];
      const leafPhases = phases.filter(function (p) { return !p.nested; });
      const maxMs = leafPhases.reduce(function (m, p) { return Math.max(m, Number(p.durationMs) || 0); }, 0);
      const slowThreshold = Math.max(500, maxMs * 0.35);
      if (maxMs > 0) {
        slowHintEl.textContent = '最慢工作步 ' + formatDuration(maxMs);
      } else {
        slowHintEl.textContent = '';
      }

      const rows = [];
      phases.forEach(function (p) {
        const slow = !p.nested && Number(p.durationMs) >= slowThreshold && Number(p.durationMs) >= 500;
        const nested = !!p.nested;
        const cls = 'row' + (slow ? ' is-slow' : '') + (nested ? ' is-nested' : '');
        const label = (nested ? '↳ ' : '') + (p.label || p.name);
        rows.push(
          '<div class="' + cls + '">'
          + '<span class="at">' + formatOffset(p.startedSinceBootMs) + '</span>'
          + '<span>' + escapeHtml(label) + '</span>'
          + '<span class="ms">' + formatDuration(p.durationMs) + '</span>'
          + '</div>'
        );
      });
      (snap.openPhases || []).forEach(function (p) {
        rows.push(
          '<div class="row is-open">'
          + '<span class="at">' + formatOffset(p.startedSinceBootMs) + '</span>'
          + '<span>进行中 · ' + escapeHtml(p.label || p.name) + '</span>'
          + '<span class="ms">…</span>'
          + '</div>'
        );
      });
      if (rows.length === 0) {
        rows.push('<div class="row"><span class="at">+0</span><span>等待阶段数据…</span><span class="ms">—</span></div>');
      }
      listEl.innerHTML = rows.join('');
      if (!ready) listEl.scrollTop = listEl.scrollHeight;
    }

    function escapeHtml(value) {
      return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    setInterval(function () {
      if (frozenElapsedMs != null) {
        elapsedEl.textContent = '墙钟 ' + formatDuration(frozenElapsedMs);
        return;
      }
      const ms = Date.now() - bootAt;
      elapsedEl.textContent = '墙钟 ' + formatDuration(ms);
    }, 200);

    ipcRenderer.on('startup:timing', function (_event, snap) {
      render(snap);
    });
    ipcRenderer.send('startup:splash-ready');
  </script>
</body>
</html>`
}

function publishToSplash(snapshot: StartupTimingUiSnapshot): void {
  if (!splashWindow || splashWindow.isDestroyed()) return
  splashWindow.webContents.send('startup:timing', snapshot)
}

export function openStartupSplash(): void {
  if (splashWindow && !splashWindow.isDestroyed()) return
  closed = false
  diagnosticsReady = false
  markStartupDiagnosticsSession({ diagnosticsReady: false })

  const display = screen.getPrimaryDisplay()
  const width = Math.min(620, Math.max(520, Math.floor(display.workAreaSize.width * 0.4)))
  const height = Math.min(640, Math.max(480, Math.floor(display.workAreaSize.height * 0.62)))

  splashWindow = new BrowserWindow({
    width,
    height,
    resizable: true,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    // Prevent accidental close during DB open (would trigger window-all-closed before main exists).
    closable: false,
    autoHideMenuBar: true,
    show: true,
    center: true,
    alwaysOnTop: true,
    backgroundColor: '#0a0a0a',
    title: '文献管理 · 启动诊断（测试版）',
    webPreferences: {
      // Splash is first-party HTML only; nodeIntegration enables ipcRenderer without a second preload bundle.
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
    },
  })

  splashWindow.setMenuBarVisibility(false)
  splashWindow.on('closed', () => {
    splashWindow = null
    setStartupTimingUiPublisher(null)
    if (elapsedTimer) {
      clearInterval(elapsedTimer)
      elapsedTimer = null
    }
  })

  setStartupTimingUiPublisher((snapshot) => {
    publishToSplash(snapshot)
  })

  const html = buildSplashHtml()
  void splashWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)

  // Keep elapsed clock / latest snapshot fresh even if no new phase marks arrive.
  elapsedTimer = setInterval(() => {
    if (!splashWindow || splashWindow.isDestroyed()) return
    publishToSplash(getStartupTimingUiSnapshot())
  }, 400)

  // Push current snapshot after the page can receive events.
  splashWindow.webContents.once('did-finish-load', () => {
    publishToSplash(getStartupTimingUiSnapshot())
  })
}

/**
 * Test-build diagnostic: keep the splash open after startup so remote users can screenshot
 * the full phase timing table. Main window can be used normally.
 * Smoke tests must not keep this window — Playwright firstWindow would grab it.
 */
export function keepStartupSplashForDiagnostics(options?: { reason?: string }): void {
  if (process.env.GUJISMART_SMOKE === '1') {
    closeStartupSplash({ delayMs: 0 })
    return
  }
  if (!splashWindow || splashWindow.isDestroyed()) return
  const reason = String(options?.reason || 'main-window-ready').trim()
  const alreadyReady = diagnosticsReady
  if (!alreadyReady) {
    diagnosticsReady = true
    markStartupDiagnosticsSession({
      diagnosticsReady: true,
      readyReason: reason,
    })
  }
  try {
    splashWindow.setAlwaysOnTop(false)
    splashWindow.setClosable(true)
    splashWindow.setTitle('文献管理 · 启动诊断完成（请截图）')
    // First time only: bring diagnostic window forward so the tester notices it.
    if (!alreadyReady && !splashWindow.isDestroyed()) {
      splashWindow.show()
      splashWindow.focus()
    }
  } catch {
    // ignore
  }
  publishToSplash(getStartupTimingUiSnapshot())
}

export function closeStartupSplash(options?: { delayMs?: number }): void {
  if (closed) return
  closed = true
  setStartupTimingUiPublisher(null)
  if (elapsedTimer) {
    clearInterval(elapsedTimer)
    elapsedTimer = null
  }
  const win = splashWindow
  if (!win || win.isDestroyed()) {
    splashWindow = null
    return
  }
  const delayMs = Math.max(0, Number(options?.delayMs || 0))
  const closeNow = () => {
    if (!win.isDestroyed()) {
      try {
        win.setClosable(true)
      } catch {
        // ignore
      }
      win.close()
    }
    if (splashWindow === win) splashWindow = null
  }
  if (delayMs <= 0) {
    closeNow()
    return
  }
  setTimeout(closeNow, delayMs).unref?.()
}

export function isStartupSplashOpen(): boolean {
  return !!splashWindow && !splashWindow.isDestroyed()
}

export function isStartupDiagnosticsReady(): boolean {
  return diagnosticsReady
}
