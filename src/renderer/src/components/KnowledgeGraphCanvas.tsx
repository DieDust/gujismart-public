import { useEffect, useRef, useState } from 'react'
import { Button, Menu, Space, Tooltip, theme, message } from 'antd'
import { AimOutlined, CopyOutlined, FileSearchOutlined, LockOutlined, MinusOutlined, NodeIndexOutlined, PlusOutlined, ReloadOutlined, UnlockOutlined } from '@ant-design/icons'
import cytoscape, { type Core } from 'cytoscape'
import type { ResearchGraph } from '@shared/research-graph'
import { clampGraphZoom, graphWheelZoomFactor } from '../utils/graphZoom'

export const GRAPH_KIND_COLORS = { person: '#318bb8', place: '#379677', time: '#ac6699', event: '#bd8b3f' } as const

interface Props {
  graph: ResearchGraph
  selectedId?: string
  pathIds?: string[] | null
  onSelect: (id?: string) => void
  onFocus: (id: string) => void
  onPathTarget: (id: string) => void
  canSetPathTarget: boolean
}

export default function KnowledgeGraphCanvas({ graph, selectedId, pathIds, onSelect, onFocus, onPathTarget, canSetPathTarget }: Props) {
  const container = useRef<HTMLDivElement>(null)
  const instance = useRef<Core | null>(null)
  const callbacks = useRef({ onSelect, onFocus, onPathTarget })
  callbacks.current = { onSelect, onFocus, onPathTarget }
  const zoomLabel = useRef<HTMLSpanElement>(null)
  const wheelFrame = useRef(0)
  const autoFit = useRef(true)
  const positions = useRef(new Map<string, { x: number; y: number; locked: boolean }>())
  const viewport = useRef<{ zoom: number; pan: { x: number; y: number } }>()
  const [hover, setHover] = useState<{ id: string; x: number; y: number }>()
  const [menu, setMenu] = useState<{ id: string; x: number; y: number; locked: boolean }>()
  const { token } = theme.useToken()
  useEffect(() => {
    if (!menu) return
    const close = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest('.knowledge-node-menu')) setMenu(undefined)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [menu])

  const fit = (cy: Core) => {
    autoFit.current = true
    cy.stop()
    cy.resize()
    cy.fit(undefined, 45)
    if (cy.zoom() > 1) cy.zoom(1)
    cy.center()
  }
  const layout = (cy: Core) => {
    cy.layout({
      name: 'cose', animate: false, randomize: true, fit: false, numIter: 600,
      initialTemp: 200, coolingFactor: 0.98,
      nodeDimensionsIncludeLabels: true, nodeRepulsion: () => 4500, idealEdgeLength: () => 60, componentSpacing: 50,
    }).run()
    fit(cy)
  }

  useEffect(() => {
    if (!container.current) return
    const element = container.current
    let targetZoom = 1
    let anchor = { x: 0, y: 0 }
    let lastDirection = 0
    let previousTime = 0
    const cancelWheel = () => {
      cancelAnimationFrame(wheelFrame.current)
      wheelFrame.current = 0
    }
    const tick = (time: number) => {
      const cy = instance.current
      if (!cy) return
      const elapsed = Math.min(40, Math.max(8, time - previousTime))
      previousTime = time
      const current = cy.zoom()
      const next = current + (targetZoom - current) * (1 - Math.exp(-elapsed / 32))
      if (Math.abs(targetZoom - next) < 0.001) {
        cy.zoom({ level: targetZoom, renderedPosition: anchor })
        wheelFrame.current = 0
      } else {
        cy.zoom({ level: next, renderedPosition: anchor })
        wheelFrame.current = requestAnimationFrame(tick)
      }
    }
    const wheel = (event: WheelEvent) => {
      const cy = instance.current
      if (!cy || !event.deltaY) return
      autoFit.current = false
      event.preventDefault()
      event.stopImmediatePropagation()
      setHover(undefined)
      setMenu(undefined)
      cy.stop()
      const bounds = element.getBoundingClientRect()
      anchor = { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
      if (event.shiftKey) {
        cancelWheel()
        cy.panBy({ x: -event.deltaY, y: 0 })
        return
      }
      const direction = Math.sign(event.deltaY)
      if (!wheelFrame.current || direction !== lastDirection) targetZoom = cy.zoom()
      lastDirection = direction
      targetZoom = clampGraphZoom(targetZoom * graphWheelZoomFactor(event.deltaY, event.deltaMode, element.clientHeight))
      if (!wheelFrame.current) {
        previousTime = performance.now()
        wheelFrame.current = requestAnimationFrame(tick)
      }
    }
    // Register before the renderer: its device-sampling clamp makes initial wheel notches nearly inert.
    element.addEventListener('wheel', wheel, { passive: false, capture: true })
    const preventMenu = (event: MouseEvent) => event.preventDefault()
    element.addEventListener('contextmenu', preventMenu)
    const cy = cytoscape({
      container: element,
      elements: [],
      style: [
        { selector: 'node', style: {
          width: 24, height: 24, 'background-color': 'data(color)', label: 'data(displayLabel)',
          'font-family': 'sans-serif', 'font-size': 13, color: token.colorText,
          'text-valign': 'bottom', 'text-margin-y': 6, 'text-wrap': 'wrap',
          'text-background-color': token.colorBgContainer, 'text-background-opacity': 0.9,
          'text-background-padding': '3px', 'min-zoomed-font-size': 6, 'text-max-width': '190px',
        } },
        { selector: 'edge', style: {
          width: 1.1, 'line-color': token.colorTextQuaternary, 'target-arrow-color': token.colorTextQuaternary,
          'target-arrow-shape': (edge) => edge.data('arrow') === 'triangle' ? 'triangle' : 'none',
          'line-style': (edge) => edge.data('line') === 'dashed' ? 'dashed' : 'solid', 'curve-style': 'bezier', opacity: 0.65,
        } },
        { selector: '.muted', style: { opacity: 0.1 } },
        { selector: '.highlight', style: { opacity: 1, 'border-color': token.colorText, 'border-width': 2, 'line-color': token.colorPrimary } },
        { selector: 'edge.highlight', style: {
          label: 'data(label)', 'font-size': 11, color: token.colorText, 'text-rotation': 'autorotate',
          'text-background-color': token.colorBgContainer, 'text-background-opacity': 1, 'text-background-padding': '3px',
        } },
      ],
      layout: { name: 'preset' },
      minZoom: 0.08, maxZoom: 4, boxSelectionEnabled: false,
    })
    instance.current = cy
    cy.on('zoom', () => {
      if (zoomLabel.current) zoomLabel.current.textContent = `${Math.round(cy.zoom() * 100)}%`
    })
    cy.on('grab pan', () => { setMenu(undefined); setHover(undefined) })
    cy.on('grab', cancelWheel)
    cy.on('tap', 'node, edge', (event) => {
      element.focus({ preventScroll: true })
      setMenu(undefined)
      callbacks.current.onSelect(event.target.id())
    })
    cy.on('mousedown touchstart', cancelWheel)
    cy.on('mousedown touchstart grab', () => { autoFit.current = false })
    cy.on('tap', (event) => {
      if (event.target === cy) { setMenu(undefined); callbacks.current.onSelect(undefined) }
    })
    cy.on('dbltap', 'node', (event) => {
      cancelWheel()
      callbacks.current.onFocus(event.target.id())
      cy.stop().animate({ center: { eles: event.target }, duration: 180 })
    })
    cy.on('mouseover', 'node, edge', (event) => {
      const point = event.renderedPosition
      setHover({ id: event.target.id(), x: Math.min(point.x + 14, Math.max(4, element.clientWidth - 244)), y: Math.max(4, Math.min(point.y + 16, element.clientHeight - 90)) })
    })
    cy.on('mouseout', 'node, edge', () => setHover(undefined))
    cy.on('cxttap', 'node, edge', (event) => {
      cancelWheel()
      element.focus({ preventScroll: true })
      setHover(undefined)
      const point = event.renderedPosition
      setMenu({
        id: event.target.id(), locked: event.target.isNode() && event.target.locked(),
        x: Math.min(point.x, Math.max(0, element.clientWidth - 210)),
        y: Math.max(0, Math.min(point.y, element.clientHeight - 260)),
      })
    })
    let resizeFrame = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame)
      resizeFrame = requestAnimationFrame(() => {
        cy.resize()
        if (autoFit.current && cy.nodes().length && element.clientWidth && element.clientHeight) fit(cy)
      })
    })
    observer.observe(element)
    return () => {
      cancelWheel()
      cancelAnimationFrame(resizeFrame)
      observer.disconnect()
      element.removeEventListener('wheel', wheel, true)
      element.removeEventListener('contextmenu', preventMenu)
      viewport.current = { zoom: cy.zoom(), pan: { ...cy.pan() } }
      cy.nodes().forEach((node) => { positions.current.set(node.id(), { ...node.position(), locked: node.locked() }) })
      cy.destroy()
      instance.current = null
    }
  }, [token.colorText, token.colorTextQuaternary, token.colorBgContainer, token.colorPrimary])

  useEffect(() => {
    const cy = instance.current
    if (!cy) return
    cancelAnimationFrame(wheelFrame.current)
    wheelFrame.current = 0
    setHover(undefined)
    setMenu(undefined)
    const nodeIds = new Set(graph.nodes.map((node) => node.id))
    const edgeIds = new Set(graph.edges.map((edge) => edge.id))
    const hasSharedNodes = graph.nodes.some((node) => cy.getElementById(node.id).length > 0 || positions.current.has(node.id))
    cy.nodes().forEach((node) => { positions.current.set(node.id(), { ...node.position(), locked: node.locked() }) })
    cy.batch(() => {
      cy.edges().filter((edge) => !edgeIds.has(edge.id())).remove()
      cy.nodes().filter((node) => !nodeIds.has(node.id())).remove()
      graph.nodes.forEach((node, index) => {
        // Keep the complete identity/evidence; only the overview caption is abbreviated.
        const characters = Array.from(node.label)
        const caption = characters.slice(0, 28).join('') + (characters.length > 28 ? '…' : '')
        const displayLabel = Array.from(caption).reduce((text, char, i) => text + (i && i % 14 === 0 ? '\n' : '') + char, '')
        const data = { id: node.id, label: node.label, displayLabel, color: GRAPH_KIND_COLORS[node.kind] }
        const existing = cy.getElementById(node.id)
        if (existing.length) existing.data(data)
        else {
          const saved = positions.current.get(node.id)
          cy.add({ data, position: saved || { x: (index % 8) * 150, y: Math.floor(index / 8) * 100 }, locked: saved?.locked || false })
        }
      })
      graph.edges.forEach((edge) => {
        const data = { id: edge.id, source: edge.source, target: edge.target, label: edge.label, arrow: edge.directed ? 'triangle' : 'none', line: edge.kind === 'cooccurrence' ? 'dashed' : 'solid' }
        const existing = cy.getElementById(edge.id)
        if (existing.length) existing.data(data)
        else cy.add({ data })
      })
    })
    if (viewport.current) {
      cy.viewport(viewport.current)
      viewport.current = undefined
    } else if (graph.nodes.length && !hasSharedNodes) layout(cy)
    // Retain recent filtered positions without accumulating every entity ever browsed.
    if (positions.current.size > 2000) {
      for (const id of positions.current.keys()) {
        if (!nodeIds.has(id)) positions.current.delete(id)
        if (positions.current.size <= 2000) break
      }
    }
  }, [graph, token.colorText, token.colorTextQuaternary, token.colorBgContainer, token.colorPrimary])

  useEffect(() => {
    const cy = instance.current
    if (!cy) return
    cy.batch(() => {
      cy.elements().removeClass('muted highlight')
      if (pathIds?.length) {
        cy.elements().addClass('muted')
        pathIds.forEach((id) => cy.getElementById(id).removeClass('muted').addClass('highlight'))
      } else if (selectedId) {
        const selected = cy.getElementById(selectedId)
        if (!selected.length) return
        cy.elements().addClass('muted')
        selected.closedNeighborhood().removeClass('muted')
        selected.addClass('highlight')
      }
    })
  }, [graph, selectedId, pathIds, token.colorText, token.colorTextQuaternary, token.colorBgContainer, token.colorPrimary])

  const hovered = hover && (graph.nodes.find((node) => node.id === hover.id) || graph.edges.find((edge) => edge.id === hover.id))
  const menuNode = menu && graph.nodes.find((node) => node.id === menu.id)
  const menuItem = menuNode || (menu && graph.edges.find((edge) => edge.id === menu.id))
  const zoomBy = (factor: number) => {
    const cy = instance.current
    if (!cy) return
    autoFit.current = false
    cancelAnimationFrame(wheelFrame.current)
    wheelFrame.current = 0
    cy.stop().zoom({ level: clampGraphZoom(cy.zoom() * factor), renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } })
  }
  return <div className="knowledge-canvas-stage" onKeyDown={(event) => {
    if (event.key === 'Escape') { setMenu(undefined); setHover(undefined); onSelect(undefined) }
    if (event.target === container.current && ['+', '=', '-'].includes(event.key)) {
      event.preventDefault(); zoomBy(event.key === '-' ? 1 / 1.4 : 1.4)
    }
  }}>
    <div ref={container} className="knowledge-canvas" tabIndex={0} role="img" aria-label="知识图谱网络" />
    {hover && hovered && <div className="knowledge-node-tooltip" role="tooltip" style={{ left: hover.x, top: hover.y, background: token.colorBgElevated, color: token.colorText, borderColor: token.colorBorder }}>
      <strong>{hovered.label}</strong><span>{hovered.recordIds.length} 条关联材料</span>
    </div>}
    {menu && menuItem && <div className="knowledge-node-menu" style={{ left: menu.x, top: menu.y }}>
      <Menu selectable={false} items={[
        { key: 'evidence', icon: <FileSearchOutlined />, label: '查看关联证据' },
        ...(menuNode ? [
          { key: 'focus', icon: <AimOutlined />, label: '设为中心实体' },
          { key: 'target', icon: <NodeIndexOutlined />, label: '设为路径终点', disabled: !canSetPathTarget },
          { key: 'lock', icon: menu.locked ? <UnlockOutlined /> : <LockOutlined />, label: menu.locked ? '解除位置固定' : '固定节点位置' },
        ] : []),
        { key: 'copy', icon: <CopyOutlined />, label: '复制名称' },
        { key: 'copy-id', icon: <CopyOutlined />, label: '复制实体或关系 ID' },
      ]} onClick={({ key }) => {
        const id = menu.id
        setMenu(undefined)
        if (key === 'evidence') onSelect(id)
        if (key === 'focus') onFocus(id)
        if (key === 'target') onPathTarget(id)
        if (key === 'lock') {
          const node = instance.current?.getElementById(id)
          if (node?.locked()) node.unlock()
          else node?.lock()
        }
        if (key === 'copy' || key === 'copy-id') {
          void navigator.clipboard.writeText(key === 'copy' ? menuItem.label : id).then(() => message.success('已复制'))
            .catch(() => message.error('复制失败'))
        }
      }} />
    </div>}
    <Space className="knowledge-canvas-tools" size={4}>
      <Tooltip title="缩小"><Button aria-label="缩小图谱" icon={<MinusOutlined />} onClick={() => zoomBy(1 / 1.4)} /></Tooltip>
      <Tooltip title="放大"><Button aria-label="放大图谱" icon={<PlusOutlined />} onClick={() => zoomBy(1.4)} /></Tooltip>
      <Button aria-label="缩放到100%" onClick={() => { const cy = instance.current; if (cy) zoomBy(1 / cy.zoom()) }}><span ref={zoomLabel}>100%</span></Button>
      <Tooltip title="适应画布"><Button aria-label="适应画布" icon={<AimOutlined />} onClick={() => {
        cancelAnimationFrame(wheelFrame.current); wheelFrame.current = 0
        if (instance.current) fit(instance.current)
      }} /></Tooltip>
      <Tooltip title="重新布局"><Button aria-label="重新布局图谱" icon={<ReloadOutlined />} onClick={() => {
        cancelAnimationFrame(wheelFrame.current); wheelFrame.current = 0
        if (instance.current) layout(instance.current)
      }} /></Tooltip>
    </Space>
  </div>
}
