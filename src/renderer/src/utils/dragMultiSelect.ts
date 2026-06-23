import { useCallback, useRef, useState, type MouseEvent, type RefObject } from 'react'

export type DragSelectionRect = {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

export type DragMultiSelectState = {
  startX: number
  startY: number
  currentX: number
  currentY: number
  baseIds: string[]
  additive: boolean
  previewIds: string[]
}

type DragSession = DragMultiSelectState & {
  startContentX: number
  startContentY: number
  currentContentX: number
  currentContentY: number
  latestContentX: number
  latestContentY: number
  frame: number | null
  moved: boolean
  dragStarted: boolean
  latestX: number
  latestY: number
  scrollRoot: HTMLElement
  overlay: HTMLDivElement | null
  overlayLabel: HTMLSpanElement | null
  previewIdsSet: Set<string>
  accumulatedHitIds: Set<string>
  targetById: Map<string, HTMLElement>
  targets: Array<{ id: string; element: HTMLElement; rect: DragSelectionRect }>
  orderedIds: string[]
  orderedRank: Map<string, number>
}

type UseDragMultiSelectOptions<TElement extends HTMLElement> = {
  rootRef: RefObject<TElement | null>
  itemSelector: string
  selectedIds: string[]
  orderedIds: string[]
  enabled?: boolean
  minDistance?: number
  getItemId?: (element: HTMLElement) => string | undefined
  isBlockedTarget?: (target: EventTarget | null) => boolean
  activeClassName?: string
  overlayClassName?: string
  overlayLabel?: (selectedCount: number) => string
  previewClassName?: string
  includeOrderedRangeBetweenHits?: boolean
  reactPreview?: boolean
  onCommit: (selectedIds: string[]) => void
  onDragStart?: () => void
  onDragEnd?: (selectedIds: string[]) => void
}

export function getDragSelectionRect(
  selection: Pick<DragMultiSelectState, 'startX' | 'startY' | 'currentX' | 'currentY'>,
): DragSelectionRect {
  const left = Math.min(selection.startX, selection.currentX)
  const top = Math.min(selection.startY, selection.currentY)
  const right = Math.max(selection.startX, selection.currentX)
  const bottom = Math.max(selection.startY, selection.currentY)
  return { left, top, right, bottom, width: right - left, height: bottom - top }
}

export function rectsIntersect(left: DragSelectionRect, right: DragSelectionRect): boolean {
  return left.left <= right.right && left.right >= right.left && left.top <= right.bottom && left.bottom >= right.top
}

function getRootContentPoint(root: HTMLElement, clientX: number, clientY: number): { x: number; y: number } {
  const rootRect = root.getBoundingClientRect()
  return {
    x: clientX - rootRect.left + root.scrollLeft,
    y: clientY - rootRect.top + root.scrollTop,
  }
}

function getDragScrollRoot(root: HTMLElement, target: EventTarget | null): HTMLElement {
  let node = target instanceof HTMLElement ? target : null
  while (node && root.contains(node)) {
    const style = window.getComputedStyle(node)
    const overflow = `${style.overflow} ${style.overflowX} ${style.overflowY}`
    const scrollable = /(auto|scroll|overlay)/.test(overflow)
      && (node.scrollHeight > node.clientHeight + 1 || node.scrollWidth > node.clientWidth + 1)
    if (scrollable) return node
    if (node === root) break
    node = node.parentElement
  }
  return root
}

function getContentSelectionRect(session: DragSession): DragSelectionRect {
  return getDragSelectionRect({
    startX: session.startContentX,
    startY: session.startContentY,
    currentX: session.currentContentX,
    currentY: session.currentContentY,
  })
}

function getElementContentRect(root: HTMLElement, element: HTMLElement): DragSelectionRect {
  const rootRect = root.getBoundingClientRect()
  const elementRect = element.getBoundingClientRect()
  const left = elementRect.left - rootRect.left + root.scrollLeft
  const top = elementRect.top - rootRect.top + root.scrollTop
  const right = elementRect.right - rootRect.left + root.scrollLeft
  const bottom = elementRect.bottom - rootRect.top + root.scrollTop
  return { left, top, right, bottom, width: right - left, height: bottom - top }
}

function contentRectToVisibleViewportRect(root: HTMLElement, rect: DragSelectionRect): DragSelectionRect {
  const rootRect = root.getBoundingClientRect()
  const left = Math.max(rootRect.left, rootRect.left + rect.left - root.scrollLeft)
  const top = Math.max(rootRect.top, rootRect.top + rect.top - root.scrollTop)
  const right = Math.min(rootRect.right, rootRect.left + rect.right - root.scrollLeft)
  const bottom = Math.min(rootRect.bottom, rootRect.top + rect.bottom - root.scrollTop)
  return {
    left,
    top,
    right,
    bottom,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  }
}

export function sameStringArray(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  return left.every((item, index) => item === right[index])
}

function createOrderedRank(orderedIds: string[]): Map<string, number> {
  const rank = new Map<string, number>()
  orderedIds.forEach((id, index) => {
    rank.set(id, index)
  })
  return rank
}

function orderedSelection(ids: Iterable<string>, orderedRank: Map<string, number>): string[] {
  const next = Array.from(ids)
  if (orderedRank.size === 0) return next

  next.sort((left, right) => {
    const leftRank = orderedRank.get(left)
    const rightRank = orderedRank.get(right)
    if (leftRank !== undefined && rightRank !== undefined) return leftRank - rightRank
    if (leftRank !== undefined) return -1
    if (rightRank !== undefined) return 1
    return 0
  })
  return next
}

function mergeSelection(baseIds: string[], hitIds: string[], additive: boolean, orderedRank: Map<string, number>): string[] {
  if (!additive) return orderedSelection(new Set(hitIds), orderedRank)
  const next = new Set(baseIds)
  hitIds.forEach((id) => next.add(id))
  return orderedSelection(next, orderedRank)
}

function includeOrderedRange(hitIds: string[], orderedIds: string[], orderedRank: Map<string, number>): string[] {
  if (hitIds.length <= 1 || orderedIds.length === 0) return hitIds

  let minRank = Number.POSITIVE_INFINITY
  let maxRank = Number.NEGATIVE_INFINITY
  const extras: string[] = []
  hitIds.forEach((id) => {
    const rank = orderedRank.get(id)
    if (rank === undefined) {
      extras.push(id)
      return
    }
    minRank = Math.min(minRank, rank)
    maxRank = Math.max(maxRank, rank)
  })

  if (!Number.isFinite(minRank) || !Number.isFinite(maxRank)) return hitIds
  const ranged = orderedIds.slice(minRank, maxRank + 1)
  extras.forEach((id) => {
    if (!ranged.includes(id)) ranged.push(id)
  })
  return ranged
}

function clearNativeTextSelection(): void {
  try {
    window.getSelection()?.removeAllRanges()
  } catch {
    // Selection cleanup is best-effort; drag selection should still continue.
  }
}

export function useDragMultiSelect<TElement extends HTMLElement>({
  rootRef,
  itemSelector,
  selectedIds,
  orderedIds,
  enabled = true,
  minDistance = 4,
  getItemId = (element) => element.dataset.selectId,
  isBlockedTarget,
  activeClassName,
  overlayClassName = 'library-selection-marquee',
  overlayLabel = (selectedCount) => `已选 ${selectedCount}`,
  previewClassName,
  includeOrderedRangeBetweenHits = false,
  reactPreview = true,
  onCommit,
  onDragStart,
  onDragEnd,
}: UseDragMultiSelectOptions<TElement>) {
  const [selection, setSelection] = useState<DragMultiSelectState | null>(null)
  const sessionRef = useRef<DragSession | null>(null)

  const collectTargets = useCallback((scrollRoot?: HTMLElement) => {
    const root = rootRef.current
    if (!root) return []
    const coordinateRoot = scrollRoot || root
    const seen = new Set<string>()
    const targets: DragSession['targets'] = []
    root.querySelectorAll<HTMLElement>(itemSelector).forEach((element) => {
      const id = getItemId(element)
      if (!id || seen.has(id)) return
      seen.add(id)
      targets.push({ id, element, rect: getElementContentRect(coordinateRoot, element) })
    })
    return targets
  }, [getItemId, itemSelector, rootRef])

  const collectHitIds = useCallback((selectionRect: DragSelectionRect, targets?: DragSession['targets']): string[] => {
    const seen = new Set<string>()
    const hitIds: string[] = []
    const currentTargets = targets || sessionRef.current?.targets || collectTargets(sessionRef.current?.scrollRoot)
    currentTargets.forEach((target) => {
      if (seen.has(target.id)) return
      if (!rectsIntersect(selectionRect, target.rect)) return
      seen.add(target.id)
      hitIds.push(target.id)
    })
    return hitIds
  }, [collectTargets])

  const refreshSessionTargets = useCallback((session: DragSession): DragSession['targets'] => {
    const targets = collectTargets(session.scrollRoot)
    session.targets = targets
    targets.forEach((target) => {
      session.targetById.set(target.id, target.element)
    })
    return targets
  }, [collectTargets])

  const updateOverlay = useCallback((session: DragSession, rect: DragSelectionRect) => {
    if (!session.overlay) return
    const visibleRect = contentRectToVisibleViewportRect(session.scrollRoot, rect)
    session.overlay.style.left = `${visibleRect.left}px`
    session.overlay.style.top = `${visibleRect.top}px`
    session.overlay.style.width = `${visibleRect.width}px`
    session.overlay.style.height = `${visibleRect.height}px`
    if (session.overlayLabel) {
      const count = session.previewIds.length
      session.overlayLabel.textContent = count > 0 ? overlayLabel(count) : ''
      session.overlayLabel.style.display = count > 0 ? '' : 'none'
    }
  }, [overlayLabel])

  const applyPreviewClasses = useCallback((session: DragSession, previewIds: string[]) => {
    if (!previewClassName) return
    const nextSet = new Set(previewIds)
    session.previewIdsSet.forEach((id) => {
      if (nextSet.has(id)) return
      session.targetById.get(id)?.classList.remove(previewClassName)
    })
    nextSet.forEach((id) => {
      if (session.previewIdsSet.has(id)) return
      session.targetById.get(id)?.classList.add(previewClassName)
    })
    session.previewIdsSet = nextSet
  }, [previewClassName])

  const clearPreviewClasses = useCallback((session: DragSession) => {
    if (!previewClassName) return
    session.targetById.forEach((element) => {
      element.classList.remove(previewClassName)
    })
    session.targets.forEach((target) => {
      target.element.classList.remove(previewClassName)
    })
    session.previewIdsSet.clear()
  }, [previewClassName])

  const updatePreview = useCallback(() => {
    const session = sessionRef.current
    if (!session) return
    session.frame = null
    session.currentX = session.latestX
    session.currentY = session.latestY
    session.currentContentX = session.latestContentX
    session.currentContentY = session.latestContentY

    const rect = getContentSelectionRect(session)
    const moved = rect.width >= minDistance || rect.height >= minDistance
    session.moved = session.moved || moved

    if (!session.moved) {
      if (reactPreview) setSelection({ ...session })
      return
    }

    if (!session.dragStarted) {
      session.dragStarted = true
      onDragStart?.()
    }

    const targets = refreshSessionTargets(session)
    const currentHitIds = collectHitIds(rect, targets)
    currentHitIds.forEach((id) => session.accumulatedHitIds.add(id))
    const hitIds = includeOrderedRangeBetweenHits
      ? includeOrderedRange(Array.from(session.accumulatedHitIds), session.orderedIds, session.orderedRank)
      : currentHitIds
    const previewIds = mergeSelection(session.baseIds, hitIds, session.additive, session.orderedRank)
    if (!sameStringArray(session.previewIds, previewIds)) {
      applyPreviewClasses(session, previewIds)
      session.previewIds = previewIds
    }
    updateOverlay(session, rect)
    if (reactPreview) setSelection({ ...session })
  }, [applyPreviewClasses, collectHitIds, includeOrderedRangeBetweenHits, minDistance, onDragStart, reactPreview, refreshSessionTargets, updateOverlay])

  const schedulePreview = useCallback((clientX: number, clientY: number) => {
    const session = sessionRef.current
    if (!session) return
    const contentPoint = getRootContentPoint(session.scrollRoot, clientX, clientY)
    session.latestX = clientX
    session.latestY = clientY
    session.latestContentX = contentPoint.x
    session.latestContentY = contentPoint.y
    if (session.frame !== null) return
    session.frame = window.requestAnimationFrame(updatePreview)
  }, [updatePreview])

  const startDragSelect = useCallback((event: MouseEvent<TElement>) => {
    if (!enabled || event.button !== 0) return
    if (isBlockedTarget?.(event.target)) return
    const root = rootRef.current
    if (!root || !root.contains(event.target as Node)) return

    const additive = event.ctrlKey || event.metaKey || event.shiftKey
    const baseIds = additive ? selectedIds : []
    const initialPreview = additive ? selectedIds : []
    const scrollRoot = getDragScrollRoot(root, event.target)
    const startContentPoint = getRootContentPoint(scrollRoot, event.clientX, event.clientY)
    const session: DragSession = {
      startX: event.clientX,
      startY: event.clientY,
      currentX: event.clientX,
      currentY: event.clientY,
      latestX: event.clientX,
      latestY: event.clientY,
      scrollRoot,
      startContentX: startContentPoint.x,
      startContentY: startContentPoint.y,
      currentContentX: startContentPoint.x,
      currentContentY: startContentPoint.y,
      latestContentX: startContentPoint.x,
      latestContentY: startContentPoint.y,
      baseIds,
      additive,
      previewIds: initialPreview,
      previewIdsSet: new Set(initialPreview),
      accumulatedHitIds: new Set(),
      frame: null,
      moved: false,
      dragStarted: false,
      overlay: null,
      overlayLabel: null,
      targetById: new Map(),
      targets: [],
      orderedIds,
      orderedRank: createOrderedRank(orderedIds),
    }

    event.preventDefault()
    clearNativeTextSelection()
    sessionRef.current = session
    if (reactPreview) setSelection(session)
    if (activeClassName) root.classList.add(activeClassName)
    if (!reactPreview) {
      const overlay = document.createElement('div')
      overlay.className = overlayClassName
      const label = document.createElement('span')
      label.style.display = 'none'
      overlay.appendChild(label)
      document.body.appendChild(overlay)
      session.overlay = overlay
      session.overlayLabel = label
      updateOverlay(session, getContentSelectionRect(session))
    }

    const previousUserSelect = document.body.style.userSelect
    const previousRootUserSelect = root.style.userSelect
    const previousScrollRootUserSelect = scrollRoot.style.userSelect
    document.body.style.userSelect = 'none'
    root.style.userSelect = 'none'
    scrollRoot.style.userSelect = 'none'

    const cleanup = () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
      scrollRoot.removeEventListener('scroll', handleScroll)
      window.removeEventListener('scroll', handleScroll, true)
      clearNativeTextSelection()
      document.body.style.userSelect = previousUserSelect
      root.style.userSelect = previousRootUserSelect
      scrollRoot.style.userSelect = previousScrollRootUserSelect
      if (activeClassName) root.classList.remove(activeClassName)
    }

    const finish = () => {
      const activeSession = sessionRef.current
      if (!activeSession) return
      if (activeSession.frame !== null) {
        window.cancelAnimationFrame(activeSession.frame)
        activeSession.frame = null
        updatePreview()
      }
      const finalIds = activeSession.previewIds
      const shouldCommit = activeSession.moved
      clearPreviewClasses(activeSession)
      activeSession.overlay?.remove()
      sessionRef.current = null
      if (reactPreview) setSelection(null)
      cleanup()
      if (shouldCommit) {
        onCommit(finalIds)
        onDragEnd?.(finalIds)
      }
    }

    function handleMouseMove(moveEvent: globalThis.MouseEvent) {
      moveEvent.preventDefault()
      clearNativeTextSelection()
      schedulePreview(moveEvent.clientX, moveEvent.clientY)
    }

    function handleScroll() {
      const activeSession = sessionRef.current
      if (!activeSession || !activeSession.moved) return
      schedulePreview(activeSession.latestX, activeSession.latestY)
    }

    function handleMouseUp(upEvent: globalThis.MouseEvent) {
      upEvent.preventDefault()
      finish()
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp, { once: true })
    scrollRoot.addEventListener('scroll', handleScroll, { passive: true })
    window.addEventListener('scroll', handleScroll, true)
  }, [activeClassName, clearPreviewClasses, enabled, isBlockedTarget, onCommit, onDragEnd, orderedIds, overlayClassName, reactPreview, rootRef, schedulePreview, selectedIds, updateOverlay, updatePreview])

  return {
    selection,
    startDragSelect,
  }
}
