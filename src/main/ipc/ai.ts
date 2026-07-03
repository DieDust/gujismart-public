import { ipcMain } from 'electron'
import { nanoid } from 'nanoid'
import {
  acceptMetadataCandidate,
  autoExtractAndApply,
  buildAiContextForDocuments,
  callLLMStream,
  classifyDocument,
  extractMetadata,
  extractMetadataStaged,
  getMetadataCandidates,
  hashPrompt,
  rejectMetadataCandidate,
  runAiTask,
  suggestTags,
  synthesizeDocumentIds,
  synthesizeDocumentIdsWithSources,
  synthesizeDocuments
} from '../ai'
import { queryAll, queryOne, run, saveDatabase } from '../database'
import { answerEvidenceStream, askDocumentWithEvidence, askWithEvidence, buildEvidenceForQuestion } from '../evidence-qa'
import { getActiveTranslationGlossary } from '../glossary-service'
import { previewLibraryAiScope } from '../semantic-search'
import { getErrorMessage } from '../../shared/errors'
import { buildAiResponseEnvelope } from '../../shared/ai-response-envelope'
import type {
  AiChatMode,
  AiChatSession,
  AiChatSessionCreatePayload,
  AiChatSessionListPayload,
  AiChatTurn,
  AiQuestionOptions,
  AiQuestionResponse,
  AiResult,
  AiStreamEventType,
  AiStreamStartResult,
  AiSummaryPayload,
  AiSummaryResult,
  AiSynthesisResult,
  AiSynthesisTemplate,
  AiTaskOptions,
  AiTaskType,
  AiTagSuggestion,
  BatchAutoExtractError,
  BatchAutoExtractResult,
  DocumentMetadataResult,
  EvidenceQaCluster,
  EvidenceQaPlan,
  EvidenceQaResponse,
  EvidenceQaSource,
  LibraryAiScope,
  LibraryAiScopePreview,
  MetadataCandidate,
  SummaryScope,
} from '../../shared/types'

const DEFAULT_BATCH_METADATA_CONCURRENCY = 3
const MAX_BATCH_METADATA_CONCURRENCY = 6
const CHAT_CONTEXT_TURNS = 6

type EnsureChatSessionPayload = AiChatSessionCreatePayload & {
  sessionId?: string | null
}
type JsonRecord = Record<string, unknown>

function clampBatchConcurrency(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_BATCH_METADATA_CONCURRENCY
  return Math.max(1, Math.min(MAX_BATCH_METADATA_CONCURRENCY, Math.floor(value)))
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJsonObject(value: string | null | undefined): JsonRecord {
  try {
    const parsed: unknown = value ? JSON.parse(value) : {}
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function getActiveAiProviderContext(): { provider: string; model: string } {
  return {
    provider: String(queryOne<{ value?: string | null }>("SELECT value FROM settings WHERE key = 'llm_provider'")?.value || 'AI').trim() || 'AI',
    model: String(queryOne<{ value?: string | null }>("SELECT value FROM settings WHERE key = 'llm_model'")?.value || 'deepseek-chat').trim() || 'deepseek-chat',
  }
}

function makeAiResponseEnvelope(payload: {
  taskType: string
  prompt: string
  resultText: unknown
  sources?: EvidenceQaSource[] | null
  warnings?: unknown[] | null
  startedAt: string
  startedMs: number
  hashParts?: Array<string | undefined>
}) {
  const context = getActiveAiProviderContext()
  return buildAiResponseEnvelope({
    taskType: payload.taskType,
    promptHash: hashPrompt(payload.taskType, payload.prompt, ...(payload.hashParts || [])),
    resultText: payload.resultText,
    sources: payload.sources || [],
    warnings: payload.warnings || [],
    startedAt: payload.startedAt,
    elapsedMs: Date.now() - payload.startedMs,
    ...context,
  })
}

function withAiResponseEnvelope<T extends EvidenceQaResponse>(payload: {
  response: T
  taskType: string
  prompt: string
  startedAt: string
  startedMs: number
  hashParts?: Array<string | undefined>
}): T {
  return {
    ...payload.response,
    aiResponseEnvelope: makeAiResponseEnvelope({
      taskType: payload.taskType,
      prompt: payload.prompt,
      resultText: payload.response.answer,
      sources: payload.response.sources,
      warnings: payload.response.warnings,
      startedAt: payload.startedAt,
      startedMs: payload.startedMs,
      hashParts: payload.hashParts,
    }),
  }
}

function requireQueryResult<T>(row: T | null, message: string): T {
  if (!row) throw new Error(message)
  return row
}

function getStringField(row: JsonRecord | null, key: string, fallback = ''): string {
  const value = row?.[key]
  return String(value || fallback)
}

function getArrayField<T>(metadata: JsonRecord, key: string): T[] {
  const value = metadata[key]
  return Array.isArray(value) ? value as T[] : []
}

function ensureChatTables(): void {
  run(`
    CREATE TABLE IF NOT EXISTS ai_chat_sessions (
      id TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
      doc_id TEXT,
      title TEXT NOT NULL,
      scope_json TEXT DEFAULT '',
      created_at TEXT,
      updated_at TEXT,
      FOREIGN KEY (doc_id) REFERENCES documents(id) ON DELETE CASCADE
    );
  `)
  run(`
    CREATE TABLE IF NOT EXISTS ai_chat_turns (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      result TEXT NOT NULL,
      task_type TEXT DEFAULT 'qa',
      metadata_json TEXT DEFAULT '',
      created_at TEXT,
      FOREIGN KEY (session_id) REFERENCES ai_chat_sessions(id) ON DELETE CASCADE
    );
  `)
  run('CREATE INDEX IF NOT EXISTS idx_ai_chat_sessions_mode_doc ON ai_chat_sessions(mode, doc_id, updated_at)')
  run('CREATE INDEX IF NOT EXISTS idx_ai_chat_turns_session ON ai_chat_turns(session_id, created_at)')
}

function rowToChatTurn(row: JsonRecord | null): AiChatTurn {
  const metadataJson = getStringField(row, 'metadata_json')
  const metadata = parseJsonObject(metadataJson)
  const plan = metadata.plan
  const aiResponseEnvelope = metadata.aiResponseEnvelope
  return {
    id: getStringField(row, 'id'),
    session_id: getStringField(row, 'session_id'),
    prompt: getStringField(row, 'prompt'),
    result: getStringField(row, 'result'),
    task_type: getStringField(row, 'task_type', 'qa'),
    metadata_json: metadataJson,
    created_at: getStringField(row, 'created_at'),
    sources: getArrayField<EvidenceQaSource>(metadata, 'sources'),
    plan: isRecord(plan) ? plan as unknown as EvidenceQaPlan : undefined,
    expandedQueries: getArrayField<string>(metadata, 'expandedQueries'),
    evidenceClusters: getArrayField<EvidenceQaCluster>(metadata, 'evidenceClusters'),
    warnings: getArrayField<string>(metadata, 'warnings'),
    aiResponseEnvelope: isRecord(aiResponseEnvelope) ? aiResponseEnvelope as unknown as AiChatTurn['aiResponseEnvelope'] : undefined,
  }
}

function listChatSessions(mode: AiChatMode, docId?: string | null): AiChatSession[] {
  ensureChatTables()
  if (mode === 'document') {
    return queryAll<AiChatSession>(
      `SELECT s.*, COUNT(t.id) as message_count
       FROM ai_chat_sessions s
       LEFT JOIN ai_chat_turns t ON t.session_id = s.id
       WHERE s.mode = 'document' AND s.doc_id = ?
       GROUP BY s.id
       ORDER BY s.updated_at DESC`,
      [docId || ''],
    )
  }
  return queryAll<AiChatSession>(
    `SELECT s.*, COUNT(t.id) as message_count
     FROM ai_chat_sessions s
     LEFT JOIN ai_chat_turns t ON t.session_id = s.id
     WHERE s.mode = 'library'
     GROUP BY s.id
     ORDER BY s.updated_at DESC`,
  )
}

function createChatSession(payload: AiChatSessionCreatePayload): AiChatSession {
  ensureChatTables()
  const id = nanoid()
  const now = new Date().toISOString()
  const mode = payload.mode === 'document' ? 'document' : 'library'
  const title = String(payload.title || (mode === 'document' ? '文献对话' : '全库对话')).trim() || 'AI 对话'
  run(
    'INSERT INTO ai_chat_sessions (id, mode, doc_id, title, scope_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, mode, payload.docId || null, title.slice(0, 80), payload.scope ? JSON.stringify(payload.scope) : '', now, now],
  )
  saveDatabase()
  return requireQueryResult(
    queryOne<AiChatSession>('SELECT *, 0 as message_count FROM ai_chat_sessions WHERE id = ?', [id]),
    'Created AI chat session was not found',
  )
}

function ensureChatSession(payload: EnsureChatSessionPayload): AiChatSession {
  ensureChatTables()
  if (payload.sessionId) {
    const existing = queryOne<AiChatSession>('SELECT * FROM ai_chat_sessions WHERE id = ?', [payload.sessionId])
    if (existing) return existing
  }
  const sessions = listChatSessions(payload.mode, payload.docId)
  const reusableSession = sessions.find((session) => Number(session.message_count || 0) > 0) || sessions[0]
  if (reusableSession) return reusableSession
  return createChatSession(payload)
}

function appendChatTurn(sessionId: string, prompt: string, response: EvidenceQaResponse, taskType: AiTaskType): AiChatTurn {
  ensureChatTables()
  const id = nanoid()
  const now = new Date().toISOString()
  const metadata = {
    sources: response.sources || [],
    plan: response.plan,
    expandedQueries: response.expandedQueries || [],
    evidenceClusters: response.evidenceClusters || [],
    warnings: response.warnings || [],
    aiResponseEnvelope: response.aiResponseEnvelope || null,
  }
  run(
    'INSERT INTO ai_chat_turns (id, session_id, prompt, result, task_type, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, sessionId, prompt, response.answer, taskType, JSON.stringify(metadata), now],
  )
  const title = prompt.trim().replace(/\s+/g, ' ').slice(0, 36) || 'AI 对话'
  run('UPDATE ai_chat_sessions SET title = CASE WHEN title IN (?, ?) THEN ? ELSE title END, updated_at = ? WHERE id = ?', [
    '文献对话',
    '全库对话',
    title,
    now,
    sessionId,
  ])
  saveDatabase()
  return rowToChatTurn(queryOne<JsonRecord>('SELECT * FROM ai_chat_turns WHERE id = ?', [id]))
}

function emitAiStream(event: Electron.IpcMainInvokeEvent, requestId: string, type: AiStreamEventType, payload: unknown): void {
  event.sender.send('ai:streamEvent', { requestId, type, payload })
}

function buildSelectionSummaryPrompt(payload: {
  text?: string
  scope?: SummaryScope
  title?: string
  instruction?: string
  format?: string
}): string {
  const scope = payload.scope || 'selection'
  const labelMap: Record<string, string> = {
    selection: '选中文字',
    paragraphs: '段落',
    page: '当前页',
    'toc-section': '当前目录节',
    document: '当前文献',
    basket: '摘要篮',
    project: '研究项目材料',
  }
  const format = payload.format || '要点摘要'
  return [
    '你是 GujiSmart 的文献摘要助手。请只根据给定材料生成中文 Markdown 摘要。',
    '输出必须包含：',
    '## 摘要',
    '## 要点',
    '## 可追问问题',
    '如果材料不足，请明确说明，不要编造。',
    `摘要范围：${labelMap[scope] || scope}`,
    `输出风格：${format}`,
    payload.title ? `文献/材料标题：${payload.title}` : '',
    payload.instruction ? `用户要求：${payload.instruction}` : '',
    '',
    '材料：',
    `"""${String(payload.text || '').slice(0, 12000)}"""`,
  ].filter(Boolean).join('\n')
}

function getRecentChatTurns(sessionId?: string): AiChatTurn[] {
  if (!sessionId) return []
  ensureChatTables()
  return queryAll<JsonRecord>('SELECT * FROM ai_chat_turns WHERE session_id = ? ORDER BY created_at DESC LIMIT ?', [sessionId, CHAT_CONTEXT_TURNS])
    .reverse()
    .map(rowToChatTurn)
}

function buildConversationContext(sessionId?: string): string {
  const turns = getRecentChatTurns(sessionId)
  if (!turns.length) return ''
  return turns
    .map((turn, index) => [
      `【上一轮 ${index + 1}】`,
      `用户：${turn.prompt}`,
      `AI：${String(turn.result || '').slice(0, 900)}`,
    ].join('\n'))
    .join('\n\n')
}

function withConversationContext(question: string, sessionId?: string): string {
  const context = buildConversationContext(sessionId)
  if (!context) return question
  return [
    '请结合下面的同一会话上下文理解用户追问；如果新问题与历史无关，则以新问题为准。',
    context,
    '',
    `当前问题：${question}`,
  ].join('\n')
}

export function registerAiIpc(): void {
  ipcMain.handle('ai:classify', async (_event, ocrText: string): Promise<string> => {
    try {
      return await classifyDocument(ocrText)
    } catch (error) {
      console.error('Document classification failed:', error)
      return 'unknown'
    }
  })

  ipcMain.handle('ai:extractMetadata', async (_event, ocrText: string, docType: string): Promise<DocumentMetadataResult> => {
    try {
      return await extractMetadata(ocrText, docType)
    } catch (error) {
      console.error('Metadata extraction failed:', error)
      return {}
    }
  })

  ipcMain.handle('ai:extractMetadataStaged', async (_event, docId: string): Promise<DocumentMetadataResult> => {
    try {
      return await extractMetadataStaged(docId)
    } catch (error) {
      console.error('Staged metadata extraction failed:', error)
      return {}
    }
  })

  ipcMain.handle('ai:autoExtract', async (_event, docId: string): Promise<DocumentMetadataResult> => {
    return autoExtractAndApply(docId)
  })

  ipcMain.handle('ai:batchAutoExtract', async (_event, docIds: string[]): Promise<BatchAutoExtractResult> => {
    const uniqueDocIds = [...new Set((docIds || []).filter(Boolean))]
    const errors: BatchAutoExtractError[] = []
    let successCount = 0
    let skippedCount = 0
    let nextIndex = 0
    const concurrency = Math.min(clampBatchConcurrency(Number(queryOne<{ value: string | null }>("SELECT value FROM settings WHERE key = 'metadata_batch_concurrency'")?.value || DEFAULT_BATCH_METADATA_CONCURRENCY)), uniqueDocIds.length || 1)

    const workers = Array.from({ length: concurrency }, async () => {
      while (nextIndex < uniqueDocIds.length) {
        const docId = uniqueDocIds[nextIndex]
        nextIndex += 1

        const doc = queryOne<{ title: string | null; metadata_status: string | null }>(
          'SELECT title, metadata_status FROM documents WHERE id = ?',
          [docId],
        )

        if (!doc) {
          errors.push({ docId, error: '文献不存在' })
          continue
        }

        // Confirmed metadata is treated as user-reviewed; batch jobs should not overwrite it silently.
        if (doc.metadata_status === 'confirmed') {
          skippedCount += 1
          continue
        }

        try {
          const metadata = await autoExtractAndApply(docId)
          if (metadata && Object.keys(metadata).length > 0) {
            successCount += 1
          } else {
            errors.push({ docId, title: doc.title || undefined, error: '未提取到有效元数据' })
          }
        } catch (error) {
          errors.push({
            docId,
            title: doc.title || undefined,
            error: (error as Error)?.message || '元数据抓取失败',
          })
        }
      }
    })

    await Promise.all(workers)

    return {
      totalCount: uniqueDocIds.length,
      successCount,
      skippedCount,
      failedCount: errors.length,
      concurrency,
      errors,
    }
  })

  ipcMain.handle('ai:getMetadataCandidates', async (_event, docId: string): Promise<MetadataCandidate[]> => {
    return getMetadataCandidates(docId)
  })

  ipcMain.handle('ai:acceptMetadataCandidate', async (_event, candidateId: string): Promise<boolean> => {
    return acceptMetadataCandidate(candidateId)
  })

  ipcMain.handle('ai:rejectMetadataCandidate', async (_event, candidateId: string): Promise<boolean> => {
    return rejectMetadataCandidate(candidateId)
  })

  ipcMain.handle('ai:suggestTags', async (_event, docId: string): Promise<AiTagSuggestion[]> => {
    return suggestTags(docId)
  })

  ipcMain.handle('ai:runTask', async (_event, docId: string, taskType: AiTaskType, text: string, options?: AiTaskOptions): Promise<string> => {
    try {
      const normalizedTaskType = String(taskType || '').trim() as AiTaskType
      const sourceText = String(text || '')
      const question = options?.question || ''
      const glossarySignature = normalizedTaskType === 'translate'
        ? getActiveTranslationGlossary({ text: sourceText, projectId: options?.glossaryProjectId }).signature
        : ''
      const promptHash = hashPrompt(normalizedTaskType, sourceText.slice(0, 6000), JSON.stringify(options || {}), glossarySignature)

      const cached = queryOne<Pick<AiResult, 'result'>>(
        'SELECT result FROM ai_results WHERE doc_id = ? AND task_type = ? AND prompt_hash = ? ORDER BY created_at DESC LIMIT 1',
        [docId, normalizedTaskType, promptHash]
      )
      if (cached?.result) {
        return cached.result
      }

      let result: string
      if (normalizedTaskType === 'summary') {
        result = await synthesizeDocumentIds([docId], 'summary')
      } else if (normalizedTaskType === 'qa' && question) {
        const context = await buildAiContextForDocuments([docId], question)
        result = await runAiTask('library_qa', question, {
          question,
          snippets: context.prompt,
        })
      } else {
        result = await runAiTask(normalizedTaskType, sourceText, options)
      }
      run(
        'INSERT INTO ai_results (id, doc_id, task_type, prompt, prompt_hash, result, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [nanoid(), docId, normalizedTaskType, question, promptHash, result, 'default', new Date().toISOString()]
      )
      saveDatabase()
      return result
    } catch (error) {
      console.error(`AI task failed: ${String(taskType || '').trim() || taskType}`, error)
      throw new Error((error as Error).message)
    }
  })

  ipcMain.handle('ai:getResults', async (_event, docId: string): Promise<AiResult[]> => {
    return queryAll<AiResult>('SELECT * FROM ai_results WHERE doc_id = ? ORDER BY created_at DESC', [docId])
  })

  ipcMain.handle('ai:chatSessions:list', async (_event, payload?: Partial<AiChatSessionListPayload>): Promise<AiChatSession[]> => {
    const mode = payload?.mode === 'document' ? 'document' : 'library'
    return listChatSessions(mode, payload?.docId || null)
  })

  ipcMain.handle('ai:chatSessions:create', async (_event, payload?: Partial<AiChatSessionCreatePayload>): Promise<AiChatSession> => {
    return createChatSession({
      mode: payload?.mode === 'document' ? 'document' : 'library',
      docId: payload?.docId || null,
      title: payload?.title,
      scope: payload?.scope,
    })
  })

  ipcMain.handle('ai:chatSessions:getTurns', async (_event, sessionId: string): Promise<AiChatTurn[]> => {
    return queryAll<JsonRecord>(
      'SELECT * FROM ai_chat_turns WHERE session_id = ? ORDER BY created_at DESC LIMIT 30',
      [sessionId],
    ).reverse().map(rowToChatTurn)
  })

  ipcMain.handle('ai:chatSessions:getTurnsPage', async (
    _event,
    sessionId: string,
    beforeCreatedAt?: string,
    limit?: number,
  ): Promise<AiChatTurn[]> => {
    const safeLimit = Math.max(1, Math.min(80, Number(limit || 30)))
    const params: unknown[] = [sessionId]
    let where = 'session_id = ?'
    if (beforeCreatedAt) {
      where += ' AND created_at < ?'
      params.push(beforeCreatedAt)
    }
    params.push(safeLimit)
    return queryAll<JsonRecord>(
      `SELECT * FROM ai_chat_turns WHERE ${where} ORDER BY created_at DESC LIMIT ?`,
      params,
    ).reverse().map(rowToChatTurn)
  })

  ipcMain.handle('ai:chatSessions:delete', async (_event, sessionId: string): Promise<boolean> => {
    run('DELETE FROM ai_chat_sessions WHERE id = ?', [sessionId])
    saveDatabase()
    return true
  })

  ipcMain.handle('ai:previewScope', async (_event, scope: LibraryAiScope): Promise<LibraryAiScopePreview> => {
    return previewLibraryAiScope(scope)
  })

  ipcMain.handle('ai:askDocument', async (_event, docId: string, question: string, options?: AiQuestionOptions): Promise<AiQuestionResponse> => {
    const startedMs = Date.now()
    const startedAt = new Date(startedMs).toISOString()
    const session = ensureChatSession({
      sessionId: options?.sessionId,
      mode: 'document',
      docId,
      title: options?.sessionTitle || '文献对话',
    })
    const contextualQuestion = withConversationContext(question, session.id)
    const response = withAiResponseEnvelope({
      response: await askDocumentWithEvidence(docId, contextualQuestion, options),
      taskType: 'document_qa',
      prompt: question,
      startedAt,
      startedMs,
      hashParts: [docId, contextualQuestion, JSON.stringify(options || {})],
    })
    const turn = appendChatTurn(session.id, question, response, 'document_qa')
    return { ...response, session, turn }
  })

  ipcMain.handle('ai:askDocumentStream', async (
    event,
    requestId: string,
    docId: string,
    question: string,
    options?: AiQuestionOptions,
  ): Promise<AiStreamStartResult> => {
    try {
      const startedMs = Date.now()
      const startedAt = new Date(startedMs).toISOString()
      const session = ensureChatSession({
        sessionId: options?.sessionId,
        mode: 'document',
        docId,
        title: options?.sessionTitle || '文献对话',
      })
      const contextualQuestion = withConversationContext(question, session.id)
      emitAiStream(event, requestId, 'phase', '检索证据中')
      const evidence = await buildEvidenceForQuestion(contextualQuestion, { type: 'documents', docIds: [docId] }, options)
      emitAiStream(event, requestId, 'sources', {
        sources: evidence.sources,
        plan: evidence.plan,
        expandedQueries: evidence.expandedQueries,
        evidenceClusters: evidence.clusters,
        warnings: evidence.warnings,
      })
      emitAiStream(event, requestId, 'phase', evidence.emptyAnswer ? '保存历史中' : '生成回答中')
      let answer = evidence.emptyAnswer || ''
      if (!answer) {
        try {
          answer = await answerEvidenceStream(evidence.trimmed, evidence.clusters, evidence.plan, evidence.expandedQueries, (delta) => {
            emitAiStream(event, requestId, 'delta', delta)
          })
        } catch (error) {
          console.warn('[AI] Stream failed, falling back to non-stream answer', error)
          const response = await askDocumentWithEvidence(docId, contextualQuestion, options)
          answer = response.answer
          emitAiStream(event, requestId, 'delta', answer)
        }
      } else {
        emitAiStream(event, requestId, 'delta', answer)
      }
      const response: EvidenceQaResponse = {
        answer,
        sources: evidence.sources,
        plan: evidence.plan,
        expandedQueries: evidence.expandedQueries,
        evidenceClusters: evidence.clusters,
        warnings: evidence.warnings,
      }
      const responseWithEnvelope = withAiResponseEnvelope({
        response,
        taskType: 'document_qa',
        prompt: question,
        startedAt,
        startedMs,
        hashParts: [docId, contextualQuestion, JSON.stringify(options || {})],
      })
      emitAiStream(event, requestId, 'phase', '保存历史中')
      const turn = appendChatTurn(session.id, question, responseWithEnvelope, 'document_qa')
      emitAiStream(event, requestId, 'done', { ...responseWithEnvelope, session, turn })
      return { requestId, sessionId: session.id }
    } catch (error) {
      const message = getErrorMessage(error, '文献 AI 问答失败')
      console.error('[AI] Document stream failed:', error)
      emitAiStream(event, requestId, 'error', message)
      throw new Error(message)
    }
  })

  ipcMain.handle('ai:libraryAsk', async (_event, question: string, scope: LibraryAiScope, options?: AiQuestionOptions): Promise<AiQuestionResponse> => {
    const startedMs = Date.now()
    const startedAt = new Date(startedMs).toISOString()
    const session = ensureChatSession({
      sessionId: options?.sessionId,
      mode: 'library',
      title: options?.sessionTitle || '全库对话',
      scope,
    })
    const contextualQuestion = withConversationContext(question, session.id)
    const response = withAiResponseEnvelope({
      response: await askWithEvidence(contextualQuestion, scope, options),
      taskType: 'library_qa',
      prompt: question,
      startedAt,
      startedMs,
      hashParts: [contextualQuestion, JSON.stringify(scope || {}), JSON.stringify(options || {})],
    })
    const turn = appendChatTurn(session.id, question, response, 'library_qa')
    return { ...response, session, turn }
  })

  ipcMain.handle('ai:libraryAskStream', async (
    event,
    requestId: string,
    question: string,
    scope: LibraryAiScope,
    options?: AiQuestionOptions,
  ): Promise<AiStreamStartResult> => {
    try {
      const startedMs = Date.now()
      const startedAt = new Date(startedMs).toISOString()
      const session = ensureChatSession({
        sessionId: options?.sessionId,
        mode: 'library',
        title: options?.sessionTitle || '全库对话',
        scope,
      })
      const contextualQuestion = withConversationContext(question, session.id)
      emitAiStream(event, requestId, 'phase', '检索证据中')
      const evidence = await buildEvidenceForQuestion(contextualQuestion, scope, options)
      emitAiStream(event, requestId, 'sources', {
        sources: evidence.sources,
        plan: evidence.plan,
        expandedQueries: evidence.expandedQueries,
        evidenceClusters: evidence.clusters,
        warnings: evidence.warnings,
      })
      emitAiStream(event, requestId, 'phase', evidence.emptyAnswer ? '保存历史中' : '生成回答中')
      let answer = evidence.emptyAnswer || ''
      if (!answer) {
        try {
          answer = await answerEvidenceStream(evidence.trimmed, evidence.clusters, evidence.plan, evidence.expandedQueries, (delta) => {
            emitAiStream(event, requestId, 'delta', delta)
          })
        } catch (error) {
          console.warn('[AI] Stream failed, falling back to non-stream answer', error)
          const response = await askWithEvidence(contextualQuestion, scope, options)
          answer = response.answer
          emitAiStream(event, requestId, 'delta', answer)
        }
      } else {
        emitAiStream(event, requestId, 'delta', answer)
      }
      const response: EvidenceQaResponse = {
        answer,
        sources: evidence.sources,
        plan: evidence.plan,
        expandedQueries: evidence.expandedQueries,
        evidenceClusters: evidence.clusters,
        warnings: evidence.warnings,
      }
      emitAiStream(event, requestId, 'phase', '保存历史中')
      const responseWithEnvelope = withAiResponseEnvelope({
        response,
        taskType: 'library_qa',
        prompt: question,
        startedAt,
        startedMs,
        hashParts: [contextualQuestion, JSON.stringify(scope || {}), JSON.stringify(options || {})],
      })
      const turn = appendChatTurn(session.id, question, responseWithEnvelope, 'library_qa')
      emitAiStream(event, requestId, 'done', { ...responseWithEnvelope, session, turn })
      return { requestId, sessionId: session.id }
    } catch (error) {
      const message = getErrorMessage(error, '全库 AI 问答失败')
      console.error('[AI] Library stream failed:', error)
      emitAiStream(event, requestId, 'error', message)
      throw new Error(message)
    }
  })

  ipcMain.handle('ai:summarizeSelection', async (_event, payload?: AiSummaryPayload): Promise<AiSummaryResult> => {
    const startedMs = Date.now()
    const startedAt = new Date(startedMs).toISOString()
    const text = String(payload?.text || '').trim()
    if (!text) throw new Error('请先选择或提供需要摘要的文本')
    const scope = (payload?.scope || 'selection') as SummaryScope
    const markdown = await callLLMStream([{ role: 'user', content: buildSelectionSummaryPrompt({ ...payload, text, scope }) }], () => {})
    const source = payload?.source
    const sources = source?.doc_id || source?.docId
      ? [{
          doc_id: String(source.doc_id || source.docId),
          doc_title: String(source.doc_title || source.docTitle || payload?.title || '当前文献'),
          page_num: source.page_num ?? source.pageNum ?? null,
          snippet: text.slice(0, 500),
          locator: source.locator,
          matched_query: '摘要选区',
        }]
      : []
    return {
      markdown,
      sources,
      scope,
      aiResponseEnvelope: makeAiResponseEnvelope({
        taskType: 'summary',
        prompt: JSON.stringify({
          scope,
          title: payload?.title || '',
          instruction: payload?.instruction || '',
          format: payload?.format || '',
          text: text.slice(0, 6000),
        }),
        resultText: markdown,
        sources,
        warnings: [],
        startedAt,
        startedMs,
      }),
    }
  })

  ipcMain.handle('ai:synthesize', async (_event, docIds: string[], templateType: AiSynthesisTemplate, customPrompt?: string): Promise<AiSynthesisResult> => {
    const startedMs = Date.now()
    const startedAt = new Date(startedMs).toISOString()
    const uniqueDocIds = [...new Set((docIds || []).filter(Boolean))]
    if (uniqueDocIds.length > 0) {
      const result = await synthesizeDocumentIdsWithSources(uniqueDocIds, templateType, customPrompt)
      return {
        ...result,
        aiResponseEnvelope: makeAiResponseEnvelope({
          taskType: 'synthesis',
          prompt: JSON.stringify({ docIds: uniqueDocIds, templateType, customPrompt: customPrompt || '' }),
          resultText: result.markdown,
          sources: result.sources,
          warnings: [],
          startedAt,
          startedMs,
        }),
      }
    }

    const texts: Array<{ title: string; text: string }> = []

    for (const docId of docIds) {
      const doc = queryOne<{ title: string }>('SELECT title FROM documents WHERE id = ?', [docId])
      if (!doc) continue
      const pages = queryAll<{ text: string }>(
        "SELECT COALESCE(proofed_text, ocr_text, '') as text FROM pages WHERE doc_id = ? ORDER BY page_num",
        [docId]
      )
      const fullText = pages.map((page) => page.text).join('\n\n').trim()
      if (fullText) {
        texts.push({ title: doc.title, text: fullText })
      }
    }

    if (texts.length === 0) {
      throw new Error('选中的文献中没有可用的 OCR 文本，请先完成 OCR 识别')
    }

    const markdown = await synthesizeDocuments(texts, templateType, customPrompt)
    return {
      markdown,
      sources: [],
      aiResponseEnvelope: makeAiResponseEnvelope({
        taskType: 'synthesis',
        prompt: JSON.stringify({ docIds: docIds || [], templateType, customPrompt: customPrompt || '' }),
        resultText: markdown,
        sources: [],
        warnings: [],
        startedAt,
        startedMs,
      }),
    }
  })
}
