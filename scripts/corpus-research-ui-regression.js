// Synthetic IPC fixtures in an isolated profile; no model requests or private corpus.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { _electron: electron } = require('playwright')

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gujismart-corpus-ui-'))
  const app = await electron.launch({
    args: ['--disable-gpu', `--user-data-dir=${path.join(root, 'user')}`, '.'],
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, GUJISMART_SMOKE: '1', GUJISMART_TEST_BACKGROUND: '1',
      GUJISMART_DATA_DIR: path.join(root, 'data'), GUJISMART_PROFILE_DIR: path.join(root, 'profile') },
  })
  let page
  try {
    page = await app.firstWindow()
    page.setDefaultTimeout(15000)
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.locator('[data-project-gate-ready="true"]').waitFor()
    await page.locator('[data-library-project-choice="true"]').first().click()
    await page.locator('main').waitFor()
    await page.waitForTimeout(800)
    for (let i = 0; i < 4; i++) {
      const close = page.locator('.ant-modal-wrap:visible .ant-modal-close').first()
      if (!await close.count()) break
      await close.click()
      await page.waitForTimeout(200)
    }
    await app.evaluate(({ ipcMain }) => {
      const state = globalThis.corpusUiFixture = { task: null, calls: [], createFailures: 1, startFailures: 1, sourceStatus: 'current', sessions: [], turns: {} }
      const replace = (channel, handler) => { ipcMain.removeHandler(channel); ipcMain.handle(channel, handler) }
      const docs = Array.from({ length: 25 }, (_, index) => ({
        id: `example-${index}`, title: `测试文献 ${String(index).padStart(2, '0')}：跨地区教育政策、学术传播与历史记忆中的相反记载和不确定性研究（虚构长标题）`,
        doc_type: '书籍', tag_ids: '', folder_ids: '',
      }))
      replace('documents:list', (_event, options) => docs.slice(options.offset || 0, (options.offset || 0) + options.limit))
      replace('folders:list', () => [])
      replace('tags:list', () => [])
      replace('ai:previewScope', (_event, scope) => {
        const selected = docs.filter((doc) => scope.type === 'all' || scope.docIds?.includes(doc.id))
        return { count: selected.length, ocrReadyCount: selected.filter((doc) => doc.id !== 'example-0').length, documents: selected }
      })
      replace('research:createNote', (_event, payload) => { state.calls.push(['note', payload]); return { id: 'example-note', ...payload } })
      replace('corpusResearch:list', () => state.task ? [state.task] : [])
      state.entityRevision = 1
      state.entityMerged = false
      state.entityHistory = []
      replace('corpusResearch:entities', (_event, id, options) => {
        state.calls.push(['entities', id, options])
        const items = ['甲某', '甲某'].map((name, index) => ({ id: `mention-${index}`, groupId: state.entityMerged ? 'merged' : `group-${index}`,
          findingId: `entity-finding-${index}`, name, kind: 'person', aliases: ['乙某'], suggestedAliases: [], candidateCount: state.entityMerged ? 0 : 1,
          groupSize: state.entityMerged ? 2 : 1, reviewed: state.entityHistory.length > 0,
          source: { id: `entity-finding-${index}`, docId: `example-${index}`, title: `虚构人物考证文献 ${index}`, pageId: `page-${index}`, pageNum: 1,
            quote: '甲某，字乙某。', claim: '原文的字号记载，尚未确认跨文献身份。', uncertainty: '', sourceStatus: 'current', start: 0, end: 8, sourceHash: 'fixture', stance: 'context', dimension: 'names' },
        })).filter((item) => (!options.search || item.name.includes(options.search) || item.aliases.some((name) => name.includes(options.search)))
          && (!options.candidatesOnly || item.candidateCount) && (!options.groupId || item.groupId === options.groupId))
        return { items, total: items.length, revision: state.entityRevision, history: state.entityHistory, canUndo: state.entityHistory.length > 0, unprocessedFindings: 0 }
      })
      replace('corpusResearch:reviewEntities', (_event, id, payload) => {
        state.calls.push(['reviewEntities', id, payload])
        if (payload.revision !== state.entityRevision) throw new Error('实体结果已更新，请刷新后再核对')
        state.entityMerged = payload.action === 'merge' || payload.action === 'undo'
        state.entityHistory.unshift({ id: String(++state.entityRevision), action: payload.action, reason: payload.reason })
      })
      replace('corpusResearch:get', () => state.task)
      replace('corpusResearch:create', (_event, payload) => {
        state.calls.push(['create', payload])
        if (state.createFailures-- > 0) throw new Error('模拟创建失败')
        state.task = { id: 'example-run', question: payload.question, projectId: payload.projectId || null,
          status: 'paused', phase: 'ready', totalDocuments: 25, totalUnits: 50, completedUnits: 0, failedUnits: 0, pendingUnits: 50,
          findings: 25, requests: 0, maxRequests: payload.maxRequests, inputTokens: 0, outputTokens: 0, measuredRequests: 0,
          reservedInputBytes: 0, active: false, error: '', report: '', reportSources: [], createdAt: 1, updatedAt: 1 }
        return state.task
      })
      replace('corpusResearch:start', (_event, id, options) => {
        state.calls.push(['start', id, options])
        if (state.startFailures-- > 0) throw new Error('模拟启动失败')
        Object.assign(state.task, { status: 'running', phase: 'extract', active: true, updatedAt: state.task.updatedAt + 1 })
        if (options?.additionalRequests) state.task.maxRequests += options.additionalRequests
        return state.task
      })
      replace('corpusResearch:pause', (_event, id) => {
        state.calls.push(['pause', id])
        Object.assign(state.task, { status: 'paused', phase: 'budget', active: false, updatedAt: state.task.updatedAt + 1 })
        return state.task
      })
      replace('corpusResearch:documents', (_event, id, options) => {
        state.calls.push(['documents', id, options])
        const selected = docs.map((doc, index) => ({ docId: doc.id, title: doc.title, totalUnits: 2,
          completedUnits: index % 3, failedUnits: index === 0 ? 1 : 0, findings: index + 1, error: index === 0 ? '模拟 OCR 缺页' : '',
        })).filter((doc) => doc.title.includes(options.search || ''))
        const key = { title: 'title', completed: 'completedUnits', findings: 'findings', failed: 'failedUnits' }[options.sort || 'title']
        selected.sort((a, b) => (typeof a[key] === 'string' ? a[key].localeCompare(b[key]) : a[key] - b[key]) * (options.descending ? -1 : 1))
        return { items: selected.slice(options.offset, options.offset + options.limit), total: selected.length }
      })
      replace('corpusResearch:findings', (_event, id, options) => ({
        total: 1, items: [{ id: `example-finding-${state.sourceStatus}`, docId: options.docId, title: docs[0].title,
          pageId: 'example-stable-page', pageNum: 3, claim: '材料支持不同的政策解释，仍需核对作者归属与引文上下文。',
          quote: '完整原文引句（虚构）：甲记录政策已经实施，乙记录同一时期仍在讨论，二者的成文时间与事件时间尚待核对。'.repeat(8),
          stance: 'challenge', dimension: '主要分歧', uncertainty: '尚未人工核验', sourceHash: 'example-hash', start: 0, end: 32,
          sourceStatus: state.sourceStatus, stableLocator: { schemaVersion: 'stable-reader-locator/v2', precision: 'exact', documentId: options.docId,
            sourcePageId: 'example-stable-page', pageNum: 3, contentVersion: 'example-v1', sourceHash: 'example-hash',
            offsetUnit: 'utf16-code-unit', sourceRanges: [{ start: 0, end: 32 }], quote: '虚构原文', prefix: '', suffix: '', occurrenceIndex: 0, verificationStatus: 'legacy-unverified' } }],
      }))
      replace('ai:chatSessions:create', (_event, payload) => {
        const session = { id: 'example-session', title: payload.title, scope_json: JSON.stringify(payload.scope), mode: 'library' }
        state.sessions.push(session); state.turns[session.id] = []; return session
      })
      replace('ai:chatSessions:list', () => state.sessions)
      replace('ai:chatSessions:getTurns', (_event, id) => state.turns[id] || [])
      replace('ai:libraryAskStream', async (event, requestId, question, scope, options) => {
        state.calls.push(['qa', question, scope])
        const turn = { id: 'example-turn', prompt: question, result: '普通问答仍然使用原流式接口。', sources: [], warnings: [], created_at: new Date().toISOString() }
        state.turns[options.sessionId].push(turn)
        event.sender.send('ai:streamEvent', { requestId, type: 'done', payload: { answer: turn.result, sources: [], warnings: [], turn } })
        return { requestId, sessionId: options.sessionId }
      })
      for (const channel of ['aiResearch:planTask', 'aiResearch:runTask', 'ai:libraryAsk']) {
        replace(channel, () => { throw new Error(`Unexpected paid entry point: ${channel}`) })
      }
    })
    const fixture = () => app.evaluate(() => globalThis.corpusUiFixture)
    const metrics = await page.context().newCDPSession(page)
    await metrics.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
    await page.locator('.ant-menu-item').filter({ hasText: /^知识图谱$/ }).click()
    const view = page.locator('.knowledge-question')
    const panel = page.getByRole('region', { name: '全范围专题研究' })
    await page.locator('.knowledge-context-bar').getByRole('button', { name: '选择文献' }).click()
    const picker = page.getByRole('dialog', { name: '选择要分析的文献' })
    await picker.getByRole('button', { name: '全选当前筛选' }).click()
    await picker.getByRole('button', { name: /使用所选文献/ }).click()
    await picker.waitFor({ state: 'hidden' })
    const question = '比较全部文献在教育政策变迁、不同地区的实践、作者归属和事件时间方面的解释，保留少数观点、相反记载及需要重新核验的研究缺口。'
    await view.getByRole('textbox', { name: '想研究的问题' }).fill(question)
    await view.getByRole('button', { name: '全范围专题研究' }).click()
    let modal = page.getByRole('dialog', { name: '确认全范围专题研究' })
    assert.equal(await modal.getByRole('spinbutton').inputValue(), '20')
    assert(await modal.getByRole('checkbox').isChecked())
    await modal.getByRole('checkbox').uncheck()
    assert((await modal.innerText()).includes('1 篇未检测到可用文本'))
    assert.equal((await fixture()).calls.filter((call) => call[0] === 'create').length, 0)
    await modal.getByRole('button', { name: '确认并开始' }).click()
    await modal.getByText(/模拟创建失败/).waitFor()
    await modal.getByRole('button', { name: '确认并开始' }).click()
    await modal.getByText(/模拟启动失败/).waitFor()
    const creates = (await fixture()).calls.filter((call) => call[0] === 'create')
    assert.equal(creates[0][1].requestKey, creates[1][1].requestKey)
    assert.equal(creates[0][1].reuseCompleted, false)
    assert.equal(creates[0][1].scope.docIds.length, 25)
    await modal.getByRole('button', { name: '重试启动' }).click()
    await modal.waitFor({ state: 'hidden' })
    assert.equal((await fixture()).calls.filter((call) => call[0] === 'create').length, 2)
    await panel.getByRole('button', { name: '暂停' }).click()
    await panel.getByRole('button', { name: '继续研究' }).click()
    modal = page.getByRole('dialog', { name: '确认继续研究' })
    await modal.getByRole('spinbutton').fill('3')
    await modal.getByRole('button', { name: '确认继续' }).click()
    await modal.waitFor({ state: 'hidden' })
    assert.equal((await fixture()).task.maxRequests, 23)
    await panel.locator('.ant-table-row-expand-icon').first().click()
    await panel.getByRole('button', { name: '收藏摘录' }).click()
    await panel.getByRole('button', { name: '已收藏' }).waitFor()
    const note = (await fixture()).calls.find((call) => call[0] === 'note')[1]
    assert.equal(note.excerpt, await panel.locator('blockquote').innerText())
    assert.equal(note.locator.precision, 'exact')
    assert.equal(note.locator.sourcePageId, 'example-stable-page')
    assert(note.note.includes('待核验'))
    for (const sourceStatus of ['stale', 'missing']) {
      await app.evaluate((_electron, value) => { globalThis.corpusUiFixture.sourceStatus = value }, sourceStatus)
      await panel.getByRole('button', { name: '刷新专题研究' }).click()
      await panel.getByText(sourceStatus === 'stale' ? '正文已修改' : '来源不可用', { exact: true }).waitFor()
      assert(await panel.getByRole('button', { name: '收藏摘录' }).isDisabled())
      assert(await panel.getByRole('button', { name: /文件第 3 页/ }).isEnabled())
    }
    await panel.getByRole('columnheader', { name: '发现' }).click()
    await panel.getByRole('columnheader', { name: '发现' }).click()
    await page.waitForTimeout(300)
    assert((await fixture()).calls.some((call) => call[0] === 'documents' && call[2].sort === 'findings' && call[2].descending && call[2].offset === 0))
    await panel.locator('.ant-pagination-item-2').click()
    await page.waitForTimeout(300)
    assert((await fixture()).calls.some((call) => call[0] === 'documents' && call[2].offset === 20))
    await panel.getByPlaceholder('搜索文献').fill('测试文献 24')
    await page.waitForTimeout(500)
    assert((await fixture()).calls.some((call) => call[0] === 'documents' && call[2].search === '测试文献 24' && call[2].offset === 0))
    await app.evaluate(() => {
      Object.assign(globalThis.corpusUiFixture.task, { status: 'completed', active: false, completedUnits: 49, failedUnits: 1, pendingUnits: 0,
        error: '缺失正文，不能视为完整处理', report: '## 阶段发现\n\n各地政策解释存在分歧，作者归属与事件时间需要进一步核验。[1](#source-1)', updatedAt: 99,
        reportSources: [{ doc_id: 'example-0', doc_title: '虚构报告来源', page_num: 3, snippet: '完整原文引句', locator: { docId: 'example-0', pageId: 'example-stable-page', pageNum: 3, pageIndex: 2 } }] })
    })
    await panel.getByRole('button', { name: '刷新专题研究' }).click()
    await panel.getByText('阶段结果，不代表完整覆盖', { exact: true }).waitFor()
    await panel.locator('.ai-citation-link').waitFor()
    assert.equal(await panel.getByText('全文处理与报告已结束', { exact: true }).count(), 0)
    await panel.getByRole('button', { name: '重试失败项' }).click()
    modal = page.getByRole('dialog', { name: '确认重试失败阶段' })
    await modal.getByRole('button', { name: '确认继续' }).click()
    await modal.waitFor({ state: 'hidden' })
    const lastStart = (await fixture()).calls.filter((call) => call[0] === 'start').at(-1)
    assert.equal(lastStart[2].retryFailed, true)
    assert.equal(lastStart[2].additionalRequests, undefined)
    await panel.getByRole('button', { name: '暂停' }).click()
    const starts = (await fixture()).calls.filter((call) => call[0] === 'start').length
    await view.getByRole('textbox', { name: '想研究的问题' }).fill('普通问题')
    await view.getByRole('button', { name: '查找并回答' }).click()
    await view.getByText('普通问答仍然使用原流式接口。', { exact: true }).waitFor()
    assert.equal((await fixture()).calls.filter((call) => call[0] === 'start').length, starts)
    await page.locator('.ant-menu-item').filter({ hasText: /^文献库$/ }).click()
    await page.locator('.ant-menu-item').filter({ hasText: /^知识图谱$/ }).click()
    await panel.getByText(question, { exact: true }).last().waitFor()
    assert.equal((await fixture()).calls.filter((call) => call[0] === 'start').length, starts, 'remount never starts paid work')
    await panel.getByPlaceholder('搜索文献').fill('')
    await panel.locator('.ant-table-row-expand-icon').first().click()
    await panel.locator('blockquote').waitFor()
    for (const [width, height] of [[1440, 1000], [1024, 900], [3840, 2032]]) {
      await metrics.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
      await view.evaluate((element) => { element.scrollTop = 0 })
      await page.waitForTimeout(300)
      const geometry = await view.evaluate((element) => {
        const overlap = (selector) => {
          const children = [...element.querySelector(selector).children].map((child) => child.getBoundingClientRect())
          return children.some((a, index) => children.slice(index + 1).some((b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1))
        }
        return { overflow: element.scrollWidth > element.clientWidth + 1,
          headingOverlap: overlap('.corpus-research-heading'), tableHeadingOverlap: overlap('.corpus-research-table-heading'), composeOverlap: overlap('.knowledge-question-submit') }
      })
      assert.deepEqual(geometry, { overflow: false, headingOverlap: false, tableHeadingOverlap: false, composeOverlap: false }, `${width}x${height} geometry`)
      const screenshot = async (name) => {
        const covered = await page.evaluate(() => {
          const visibleRect = (element) => {
            const initial = element.getBoundingClientRect()
            const rect = { left: Math.max(0, initial.left), right: Math.min(innerWidth, initial.right), top: Math.max(0, initial.top), bottom: Math.min(innerHeight, initial.bottom) }
            for (let parent = element.parentElement; parent; parent = parent.parentElement) {
              const style = getComputedStyle(parent)
              const bounds = parent.getBoundingClientRect()
              if (/auto|scroll|hidden|clip/.test(style.overflowX)) { rect.left = Math.max(rect.left, bounds.left); rect.right = Math.min(rect.right, bounds.right) }
              if (/auto|scroll|hidden|clip/.test(style.overflowY)) { rect.top = Math.max(rect.top, bounds.top); rect.bottom = Math.min(rect.bottom, bounds.bottom) }
            }
            return rect
          }
          const floats = [...document.querySelectorAll('.import-float-button, .ai-float-button-rect')].filter((element) => element.getClientRects().length)
          const targets = [...document.querySelectorAll('.corpus-research button, .corpus-research input, .corpus-research .ant-table-cell, .corpus-research .ant-select, .corpus-findings blockquote, .ant-modal button, .ant-modal input')]
          const overlaps = []
          for (const target of targets) {
            if (!target.getClientRects().length) continue
            const rect = visibleRect(target)
            for (const floating of floats) {
              const bounds = floating.getBoundingClientRect()
              const left = Math.max(rect.left, bounds.left), right = Math.min(rect.right, bounds.right)
              const top = Math.max(rect.top, bounds.top), bottom = Math.min(rect.bottom, bounds.bottom)
              if (right - left <= 1 || bottom - top <= 1) continue
              // A modal may overlap geometrically while correctly painting above the float.
              const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2)
              if (hit && floating.contains(hit)) overlaps.push({ target: target.getAttribute('aria-label') || target.textContent?.slice(0, 100), floating: floating.className })
            }
          }
          return overlaps
        })
        assert.deepEqual(covered, [], `${width}x${height} ${name}: floating actions must not cover study content or modal controls`)
        const bytes = await page.screenshot({ path: path.join(root, `corpus-${name}-${width}x${height}.png`), scale: 'css' })
        assert.equal(bytes.readUInt32BE(16), width, 'screenshot width is CSS viewport width, independent of Windows display scale')
        assert.equal(bytes.readUInt32BE(20), height)
      }
      await screenshot('overview')
      await panel.locator('.corpus-research-table-heading').evaluate((element) => element.scrollIntoView({ block: 'start' }))
      await screenshot('table')
      await view.evaluate((element) => {
        const input = element.querySelector('.corpus-research-table-heading input').getBoundingClientRect()
        const floating = document.querySelector('.ai-float-button-rect').getBoundingClientRect()
        element.scrollTop += input.top + input.height / 2 - floating.top - floating.height / 2
      })
      await screenshot('search-clearance')
      await view.getByRole('textbox', { name: '想研究的问题' }).fill(question)
      await view.getByRole('button', { name: '全范围专题研究' }).click()
      modal = page.getByRole('dialog', { name: '确认全范围专题研究' })
      await modal.waitFor()
      const rect = await modal.boundingBox()
      assert(rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= width + 1 && rect.y + rect.height <= height + 1)
      await screenshot('confirm')
      await modal.getByRole('button', { name: /取\s*消/ }).click()
      await modal.waitFor({ state: 'hidden' })
    }
    await panel.getByText('实体核对 · 人物、地点、机构与别名', { exact: true }).click()
    const entityPanel = panel.getByRole('region', { name: '实体核对', exact: true })
    await entityPanel.getByRole('button', { name: '核对同名与别名' }).first().waitFor()
    await entityPanel.getByPlaceholder('名称、别名或文献').fill('乙某')
    await page.waitForTimeout(500)
    assert.equal(await entityPanel.locator('tbody .ant-table-row').count(), 2)
    await entityPanel.locator('thead input[type=checkbox]').check()
    await entityPanel.getByRole('button', { name: '确认为同一对象' }).click()
    modal = page.getByRole('dialog', { name: '确认对象归并' })
    assert(await modal.getByRole('button', { name: /确\s*定/ }).isDisabled())
    await modal.getByRole('textbox', { name: '实体核对依据' }).fill('虚构用例：核对字号与年代')
    await modal.getByRole('button', { name: /确\s*定/ }).click()
    await modal.waitFor({ state: 'hidden' })
    await entityPanel.getByRole('button', { name: '2 条记录', exact: true }).first().waitFor()
    assert((await fixture()).calls.some((call) => call[0] === 'reviewEntities' && call[2].action === 'merge' && call[2].mentionIds.length === 2))
    await entityPanel.locator('tr[data-row-key="mention-0"] .ant-checkbox-wrapper').click()
    await entityPanel.getByRole('button', { name: '独立保留' }).click()
    modal = page.getByRole('dialog', { name: '独立保留所选记录' })
    await modal.getByRole('textbox', { name: '实体核对依据' }).fill('虚构用例：年代冲突')
    await modal.getByRole('button', { name: /确\s*定/ }).click()
    await modal.waitFor({ state: 'hidden' })
    await entityPanel.getByRole('button', { name: '1 条记录', exact: true }).first().waitFor()
    await entityPanel.getByRole('button', { name: '撤销实体核对' }).click()
    modal = page.getByRole('dialog', { name: '撤销上次核对' })
    await modal.getByRole('textbox', { name: '实体核对依据' }).fill('虚构用例：撤销分离')
    await modal.getByRole('button', { name: /确\s*定/ }).click()
    await modal.waitFor({ state: 'hidden' })
    await entityPanel.getByRole('button', { name: '2 条记录', exact: true }).first().waitFor()
    await entityPanel.locator('.ant-table-row-expand-icon').first().click()
    await entityPanel.getByRole('button', { name: '查看原文 · 文件第 1 页' }).waitFor()
    for (const [width, height] of [[1440, 1000], [1024, 900], [3840, 2032]]) {
      await metrics.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
      await entityPanel.evaluate((element) => element.scrollIntoView({ block: 'start' }))
      await page.waitForTimeout(250)
      assert.equal(await view.evaluate((element) => element.scrollWidth > element.clientWidth + 1), false)
      await page.screenshot({ path: path.join(root, `corpus-entities-${width}x${height}.png`), scale: 'css' })
    }
    assert.equal((await fixture()).calls.filter((call) => call[0] === 'start').length, starts, 'Entity review never starts paid research')
    assert.deepEqual(errors, [])
    console.log(`Corpus research UI passed: confirmation, sticky failures, recovery, budgets, collection, stale sources, global sorting, pagination, Q&A and viewport geometry. Screenshots: ${root}`)
  } catch (error) {
    if (page) {
      await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {})
      console.error(await page.locator('body').innerText().catch(() => 'Page unavailable'))
    }
    console.error(`Failure screenshot: ${path.join(root, 'failure.png')}`)
    throw error
  } finally { await app.close() }
}
run().catch((error) => { console.error(error); process.exitCode = 1 })
