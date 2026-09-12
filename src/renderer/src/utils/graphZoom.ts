export function graphWheelZoomFactor(deltaY: number, deltaMode: number, pageHeight: number): number {
  const pixels = deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? pageHeight : 1)
  return Math.exp(-Math.max(-240, Math.min(240, pixels)) * 0.0028)
}

export function clampGraphZoom(zoom: number): number {
  return Math.max(0.08, Math.min(4, zoom))
}
