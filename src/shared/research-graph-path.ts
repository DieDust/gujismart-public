import cytoscape from 'cytoscape'
import type { ResearchGraph } from './research-graph'

export function findResearchGraphPath(graph: ResearchGraph, sourceId: string, targetId: string): string[] | null {
  if (!graph.nodes.some((node) => node.id === sourceId) || !graph.nodes.some((node) => node.id === targetId)) return null
  const cy = cytoscape({
    headless: true, styleEnabled: false,
    elements: [...graph.nodes.map((node) => ({ data: { id: node.id } })), ...graph.edges.map((edge) => ({ data: edge }))],
  })
  try {
    const result = cy.elements().aStar({ root: cy.getElementById(sourceId), goal: cy.getElementById(targetId), directed: false })
    return result.found ? result.path.map((element) => element.id()) : null
  } finally {
    cy.destroy()
  }
}
