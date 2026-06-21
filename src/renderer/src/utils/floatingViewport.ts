export type FloatingPanelState = {
  x: number
  y: number
  w: number
  h: number
}

export type FloatingButtonPosition = {
  x: number
  y: number
}

const PANEL_MARGIN = 16
const PANEL_DEFAULT_WIDTH = 420
const PANEL_DEFAULT_HEIGHT = 600
const PANEL_DEFAULT_TOP = 80
const PANEL_DEFAULT_RIGHT = 24
const BUTTON_MARGIN = 12
const BUTTON_BASE_RIGHT = 24
const BUTTON_BASE_BOTTOM = 24
const BUTTON_WIDTH = 64
const BUTTON_HEIGHT = 44

function clampValue(value: number, min: number, max: number): number {
  if (max < min) return min
  return Math.min(Math.max(value, min), max)
}

export function clampFloatingPanelState(
  state: FloatingPanelState,
  viewportW = window.innerWidth,
  viewportH = window.innerHeight,
): FloatingPanelState {
  const minW = Math.min(320, Math.max(240, viewportW - PANEL_MARGIN * 2))
  const minH = Math.min(400, Math.max(280, viewportH - PANEL_MARGIN * 2))
  const maxW = Math.max(minW, viewportW - PANEL_MARGIN * 2)
  const maxH = Math.max(minH, viewportH - PANEL_MARGIN * 2)
  const w = clampValue(state.w, minW, maxW)
  const h = clampValue(state.h, minH, maxH)
  const x = clampValue(state.x, PANEL_MARGIN, Math.max(PANEL_MARGIN, viewportW - w - PANEL_MARGIN))
  const y = clampValue(state.y, PANEL_MARGIN, Math.max(PANEL_MARGIN, viewportH - h - PANEL_MARGIN))
  return { x, y, w, h }
}

export function getDefaultFloatingPanelState(
  viewportW = window.innerWidth,
  viewportH = window.innerHeight,
): FloatingPanelState {
  return clampFloatingPanelState({
    x: viewportW - PANEL_DEFAULT_WIDTH - PANEL_DEFAULT_RIGHT,
    y: PANEL_DEFAULT_TOP,
    w: PANEL_DEFAULT_WIDTH,
    h: PANEL_DEFAULT_HEIGHT,
  }, viewportW, viewportH)
}

export function clampAiButtonPosition(
  pos: FloatingButtonPosition,
  viewportW = window.innerWidth,
  viewportH = window.innerHeight,
): FloatingButtonPosition {
  const minX = -(Math.max(0, viewportW - BUTTON_BASE_RIGHT - BUTTON_WIDTH - BUTTON_MARGIN))
  const maxX = BUTTON_BASE_RIGHT - BUTTON_MARGIN
  const minY = -(Math.max(0, viewportH - BUTTON_BASE_BOTTOM - BUTTON_HEIGHT - BUTTON_MARGIN))
  const maxY = BUTTON_BASE_BOTTOM - BUTTON_MARGIN
  return {
    x: clampValue(pos.x, minX, maxX),
    y: clampValue(pos.y, minY, maxY),
  }
}
