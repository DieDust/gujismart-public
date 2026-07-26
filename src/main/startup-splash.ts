/**
 * Startup diagnostic splash was a temporary remote-debug window (phase timings + screenshot).
 * It is disabled for normal product builds. Keep no-op exports so any leftover call sites stay safe.
 */

export function openStartupSplash(): void {
  // Intentionally disabled — do not show the diagnostic window on startup.
}

export function keepStartupSplashForDiagnostics(_options?: { reason?: string }): void {
  // Intentionally disabled.
}

export function closeStartupSplash(_options?: { delayMs?: number }): void {
  // No window to close.
}

export function isStartupSplashOpen(): boolean {
  return false
}

export function isStartupDiagnosticsReady(): boolean {
  return false
}
