import { parentPort } from 'worker_threads'
import { getErrorMessage } from '../shared/errors'
import type { SearchGroupedResponse } from '../shared/types'
import { initReadOnlyWorkerDatabase } from './database'
import { withLibraryProjectContext } from './library-projects'
import { querySearchV2 } from './semantic-search'
import type {
  SearchExportQueryWorkerProgress,
  SearchExportQueryWorkerStage,
  SearchExportQueryWorkerTask,
} from './search-export-query-worker-client'

type WorkerRequest = { type?: 'query'; task?: SearchExportQueryWorkerTask }

function postProgress(stage: SearchExportQueryWorkerStage, message: string): void {
  const progress: SearchExportQueryWorkerProgress = { stage, message }
  parentPort?.postMessage({ type: 'progress', progress })
}

function runQuery(task: SearchExportQueryWorkerTask): SearchGroupedResponse {
  postProgress('initializing', '正在启动后台全文检索。')
  initReadOnlyWorkerDatabase({
    databasePath: task.databasePath,
    dataDir: task.dataDir,
  })
  postProgress('searching', '正在扫描全文索引并核对完整命中。')
  const response = withLibraryProjectContext(task.projectId, () => querySearchV2(task.keyword, {
    ...task.options,
    autoReindex: false,
  }))
  postProgress('finalizing', '全文检索完成，正在整理导出数据。')
  return response
}

parentPort?.on('message', (message: WorkerRequest) => {
  if (message?.type !== 'query' || !message.task) return
  try {
    parentPort?.postMessage({ type: 'result', result: runQuery(message.task) })
  } catch (error: unknown) {
    parentPort?.postMessage({ type: 'error', error: getErrorMessage(error) })
  }
})
