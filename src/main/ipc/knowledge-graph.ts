import { ipcMain } from 'electron'
import type { KnowledgeGraphDataQuery } from '../../shared/types'
import { getKnowledgeGraphData } from '../knowledge-graph'

export function registerKnowledgeGraphIpc(): void {
  ipcMain.handle('knowledgeGraph:getData', (_event, query: KnowledgeGraphDataQuery) => getKnowledgeGraphData(query))
}
