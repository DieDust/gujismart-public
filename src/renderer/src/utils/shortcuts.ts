export type ShortcutAction =
  | 'back'
  | 'previousPage'
  | 'nextPage'
  | 'translate'
  | 'search'
  | 'selectAll'
  | 'invertSelection'
  | 'copyDirectQuote'

export type ShortcutMap = Record<ShortcutAction, string>

export const SHORTCUTS_CHANGED_EVENT = 'gujismart:shortcuts-changed'

export const DEFAULT_SHORTCUTS: ShortcutMap = {
  back: 'Esc',
  previousPage: 'ArrowLeft',
  nextPage: 'ArrowRight',
  translate: 'Alt+A',
  search: 'Ctrl+F',
  selectAll: 'Ctrl+A',
  invertSelection: 'Ctrl+I',
  copyDirectQuote: 'Ctrl+D',
}

export const SHORTCUT_SETTING_KEYS: Record<ShortcutAction, string> = {
  back: 'shortcut_back',
  previousPage: 'shortcut_previous_page',
  nextPage: 'shortcut_next_page',
  translate: 'shortcut_translate',
  search: 'shortcut_search',
  selectAll: 'shortcut_select_all',
  invertSelection: 'shortcut_invert_selection',
  copyDirectQuote: 'shortcut_copy_direct_quote',
}

const KEY_ALIASES: Record<string, string> = {
  esc: 'Escape',
  escape: 'Escape',
  left: 'ArrowLeft',
  arrowleft: 'ArrowLeft',
  right: 'ArrowRight',
  arrowright: 'ArrowRight',
  up: 'ArrowUp',
  arrowup: 'ArrowUp',
  down: 'ArrowDown',
  arrowdown: 'ArrowDown',
  space: ' ',
  spacebar: ' ',
  enter: 'Enter',
  return: 'Enter',
  del: 'Delete',
  delete: 'Delete',
}

function normalizeKeyToken(token: string): string {
  const trimmed = token.trim()
  if (!trimmed) return ''
  const compact = trimmed.toLowerCase().replace(/\s+/g, '')
  if (KEY_ALIASES[compact]) return KEY_ALIASES[compact]
  if (/^key[a-z]$/i.test(trimmed)) return trimmed.slice(-1).toUpperCase()
  if (/^[a-z]$/i.test(trimmed)) return trimmed.toUpperCase()
  if (/^f\d{1,2}$/i.test(trimmed)) return trimmed.toUpperCase()
  return trimmed.length === 1 ? trimmed.toUpperCase() : trimmed
}

export function normalizeShortcutInput(value: string): string {
  const raw = String(value || '').trim()
  if (!raw) return ''
  const tokens = raw
    .replace(/[＋+]/g, '+')
    .split('+')
    .map((token) => token.trim())
    .filter(Boolean)
  const modifiers: string[] = []
  let key = ''

  for (const token of tokens) {
    const normalized = token.toLowerCase().replace(/\s+/g, '')
    if (normalized === 'ctrl' || normalized === 'control') modifiers.push('Ctrl')
    else if (normalized === 'alt' || normalized === 'option') modifiers.push('Alt')
    else if (normalized === 'shift') modifiers.push('Shift')
    else if (normalized === 'meta' || normalized === 'cmd' || normalized === 'command' || normalized === 'win') modifiers.push('Meta')
    else key = normalizeKeyToken(token)
  }

  const ordered = ['Ctrl', 'Alt', 'Shift', 'Meta'].filter((item) => modifiers.includes(item))
  return [...ordered, key].filter(Boolean).join('+')
}

export function shortcutFromKeyboardEvent(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>): string {
  const key = normalizeKeyToken(event.key)
  if (!key || key === 'Dead' || key === 'Process') return ''
  const modifiers = [
    event.ctrlKey ? 'Ctrl' : '',
    event.altKey ? 'Alt' : '',
    event.shiftKey ? 'Shift' : '',
    event.metaKey ? 'Meta' : '',
  ].filter(Boolean)
  if (['Control', 'Ctrl', 'Alt', 'Shift', 'Meta'].includes(key)) return modifiers.join('+')
  return normalizeShortcutInput([...modifiers, key].join('+'))
}

export function normalizeShortcutMap(settings: Record<string, string> = {}): ShortcutMap {
  return (Object.keys(DEFAULT_SHORTCUTS) as ShortcutAction[]).reduce((map, action) => {
    const stored = normalizeShortcutInput(settings[SHORTCUT_SETTING_KEYS[action]] || '')
    map[action] = stored || DEFAULT_SHORTCUTS[action]
    return map
  }, {} as ShortcutMap)
}

export function shortcutMatches(event: KeyboardEvent, shortcut: string): boolean {
  const normalized = normalizeShortcutInput(shortcut)
  if (!normalized) return false
  const parts = normalized.split('+')
  const expectedKey = parts[parts.length - 1]
  const wantsCtrl = parts.includes('Ctrl')
  const wantsAlt = parts.includes('Alt')
  const wantsShift = parts.includes('Shift')
  const wantsMeta = parts.includes('Meta')
  const actualKey = normalizeKeyToken(event.key)

  return actualKey === expectedKey
    && event.ctrlKey === wantsCtrl
    && event.altKey === wantsAlt
    && event.shiftKey === wantsShift
    && event.metaKey === wantsMeta
}

export function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const editable = target.closest('input, textarea, select, [contenteditable="true"], .ant-input, .ant-select, .ant-picker')
  return !!editable
}

export function hasShortcutBlockingOverlay(): boolean {
  return !!document.querySelector(
    '.ant-modal-content, .ant-drawer-content, .ant-popover, .ant-dropdown:not(.ant-dropdown-hidden), .ant-select-dropdown:not(.ant-select-dropdown-hidden)',
  )
}

export async function loadShortcutSettings(): Promise<ShortcutMap> {
  try {
    const settings = await window.api.getAllSettings()
    return normalizeShortcutMap(settings)
  } catch {
    return { ...DEFAULT_SHORTCUTS }
  }
}
