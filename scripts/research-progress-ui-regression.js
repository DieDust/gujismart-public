// Isolated profile and synthetic IPC responses: no model calls or user data writes.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { _electron: electron } = require('playwright')

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gujismart-progress-ui-'))
  const app = await electron.launch({
    args: ['--disable-gpu', `--user-data-dir=${path.join(root, 'user')}`, '.'],
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, GUJISMART_SMOKE: '1', GUJISMART_DATA_DIR: path.join(root, 'data'), GUJISMART_PROFILE_DIR: path.join(root, 'profile') },
  })
  let page
  try {
    page = await app.firstWindow()
    page.setDefaultTimeout(12000)
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.locator('[data-project-gate-ready="true"]').waitFor()
    await page.locator('[data-library-project-choice="true"]').first().click()
    await page.locator('main').waitFor()
    await page.waitForTimeout(800)
    for (let attempt = 0; attempt < 4; attempt++) {
      const close = page.locator('.ant-modal-wrap:visible .ant-modal-close').first()
      if (!await close.count()) break
      await close.click()
      await page.waitForTimeout(200)
    }
    await app.evaluate(() => {
      const require = process.getBuiltinModule('module').createRequire(`${process.cwd()}/package.json`)
      const path = require('node:path')
      const Database = require('better-sqlite3')
      const db = new Database(path.join(process.env.GUJISMART_DATA_DIR, 'db', 'gujismart.db'))
      try {
        const projectId = db.prepare('SELECT id FROM library_projects ORDER BY created_at LIMIT 1').get().id
        db.prepare("INSERT INTO ai_research_tasks (id, library_project_id, title, goal, status) VALUES ('report-persistence', ?, 'Fixture', 'Fixture', 'completed')").run(projectId)
        db.prepare("INSERT INTO ai_research_datasets (id, library_project_id, task_id, name) VALUES ('empty-fixture', ?, 'report-persistence', 'Fixture')").run(projectId)
      } finally { db.close() }
    })
    // Empty data fails before model invocation, exercising the real handler and SQLite persistence.
    const persisted = await page.evaluate(async () => {
      let failure = ''
      try { await window.api.generateAiResearchReport({ datasetId: 'empty-fixture' }) } catch (error) { failure = String(error) }
      return { failure, steps: await window.api.listAiResearchTaskSteps('report-persistence'), task: await window.api.getAiResearchTask('report-persistence') }
    })
    assert(persisted.failure.includes('没有可用于生成报告的记录'))
    assert.equal(persisted.steps.find((step) => step.step_key === 'report').status, 'error')
    assert.equal(persisted.task.status, 'completed', 'report failure must not overwrite extraction completion')
    // Exercise the real report handler and transport with intercepted HTTP, never the network.
    await app.evaluate(() => {
      const require = process.getBuiltinModule('module').createRequire(`${process.cwd()}/package.json`)
      const Database = require('better-sqlite3')
      const db = new Database(require('node:path').join(process.env.GUJISMART_DATA_DIR, 'db', 'gujismart.db'))
      try {
        const projectId = db.prepare('SELECT library_project_id FROM ai_research_tasks WHERE id = ?').get('report-persistence').library_project_id
        db.prepare("INSERT INTO documents (id, title) VALUES ('report-doc', 'Synthetic report source')").run()
        db.prepare("INSERT INTO ai_research_records (id, library_project_id, dataset_id, task_id, doc_id, excerpt, values_json, status) VALUES ('report-source', ?, 'empty-fixture', 'report-persistence', 'report-doc', ?, '{}', 'pending')").run(projectId, 'Synthetic evidence. '.repeat(2000) + ' UNTRUNCATED_TAIL_MARKER')
      } finally { db.close() }
      global.reportTransportFixture = { attempts: 0, prompts: [], originalFetch: global.fetch }
      global.fetch = async (_url, options) => {
        if (!String(_url).startsWith('https://synthetic.invalid/')) throw new Error('Unexpected network request in isolated regression')
        const state = global.reportTransportFixture
        state.attempts++
        state.prompts.push(JSON.parse(options.body).messages[0].content)
        if (state.attempts === 1) return new Response(JSON.stringify({ error: { message: 'Synthetic overload' } }), { status: 503 })
        return new Response(JSON.stringify({ choices: [{ message: { content: 'Synthetic source-backed report.' } }] }), { status: 200 })
      }
    })
    await page.evaluate(async () => {
      await window.api.saveCredential('llm_api_key', 'synthetic-test-key')
      await window.api.setSetting('llm_base_url', 'https://synthetic.invalid/v1')
    })
    const realReport = await page.evaluate(() => window.api.generateAiResearchReport({ datasetId: 'empty-fixture' }))
    assert.equal(realReport.content, 'Synthetic source-backed report.')
    const transport = await app.evaluate(() => {
      const state = global.reportTransportFixture
      global.fetch = state.originalFetch
      return { attempts: state.attempts, prompts: state.prompts }
    })
    assert(transport.attempts >= 4, 'transient retry, source batches, and final merge should run')
    assert(transport.prompts.every((prompt) => Buffer.byteLength(prompt) <= 24000))
    assert(transport.prompts.some((prompt) => prompt.includes('UNTRUNCATED_TAIL_MARKER')))
    assert.equal((await page.evaluate(() => window.api.listAiResearchTaskSteps('report-persistence'))).find((step) => step.step_key === 'report').status, 'completed')
    await app.evaluate(({ ipcMain }) => {
      global.progressFixture = { failure: 'report', stage: '', release: false, progress: 0.25, runs: 0, reports: 0 }
      const state = global.progressFixture
      const wait = async (stage) => {
        state.stage = stage
        state.release = false
        while (!state.release) await new Promise((resolve) => setTimeout(resolve, 40))
        if (state.failure === stage) throw new Error(`Synthetic ${stage} failure`)
      }
      const replace = (channel, handler) => { ipcMain.removeHandler(channel); ipcMain.handle(channel, handler) }
      const fields = [{ key: 'person', label: '人物', type: 'person' }]
      const stats = { plan: { queries: [] }, readableSegmentCount: 4, totalDocumentCount: 1, totalPageCount: 1, totalHitCount: 4, queryStats: [], cooccurringTerms: [] }
      const task = { id: 'fixture-task', status: 'draft', fieldSchema: fields, goal: '提取人物', title: 'Fixture', error_message: '' }
      replace('aiResearch:planTask', async () => { await wait('plan'); return { goal: '提取人物', title: 'Fixture', fields, suggestedQueries: ['人物'], kind: 'extraction' } })
      replace('aiResearch:previewRetrieval', async () => { await wait('preview'); return stats })
      replace('aiResearch:createTask', () => task)
      replace('aiResearch:listTaskSteps', () => [{ id: 'extract-step', task_id: task.id, step_key: 'extract', title: '结构化抽取', status: 'running', progress: state.progress, message: `已处理 ${state.progress * 4}/4 条候选证据` }])
      replace('aiResearch:runTask', async () => {
        state.runs++
        await wait('extract')
        return { task: { ...task, status: 'completed' }, dataset: { id: 'fixture-dataset', fieldSchema: fields }, records: [{ id: 'record', values: { person: '示例人物' }, status: 'pending', excerpt: '虚构证据' }], retrievalStats: stats }
      })
      replace('aiResearch:generateReport', async () => { state.reports++; await wait('report'); return { content: 'Synthetic report', outputId: null } })
    })
    await page.locator('[title="打开 AI 助手"]').click()
    const panel = page.locator('.ai-floating-panel .ai-panel')
    await panel.getByRole('tab', { name: '数据抽取' }).click()
    const input = panel.locator('.ai-chat-input-wrapper textarea')
    const status = panel.getByRole('region', { name: '研究分析进度' })
    const release = () => app.evaluate(() => { global.progressFixture.release = true })
    const stage = (name) => app.evaluate(() => global.progressFixture.stage).then((actual) => assert.equal(actual, name))
    const start = async () => { await input.fill('提取人物'); await input.press('Enter') }
    await start()
    await status.getByText('正在生成抽取方案', { exact: true }).waitFor()
    await stage('plan')
    assert.equal(await status.locator('progress').getAttribute('value'), null, 'unknown progress must be indeterminate')
    const before = await status.boundingBox()
    await input.press('Enter')
    await release()
    await status.getByText('正在检索与统计原文', { exact: true }).waitFor()
    await release()
    await status.getByText('已处理 1/4 条候选证据', { exact: true }).waitFor()
    await status.getByText('本阶段 25%', { exact: true }).waitFor()
    await app.evaluate(() => { global.progressFixture.progress = 0.75 })
    await status.getByText('本阶段 75%', { exact: true }).waitFor()
    const statusRect = await status.boundingBox()
    const panelRect = await panel.boundingBox()
    assert(statusRect.y >= panelRect.y && statusRect.y + statusRect.height <= panelRect.y + panelRect.height, 'progress fits within the panel')
    await page.screenshot({ path: path.join(root, 'extract-progress.png') })
    await panel.evaluate((el) => { const scroll = [...el.children].find((node) => getComputedStyle(node).overflowY === 'auto'); scroll.scrollTop = scroll.scrollHeight })
    assert(Math.abs((await status.boundingBox()).y - before.y) < 2, 'status stays outside scrolling content')
    await release()
    await status.getByText('正在生成研究报告', { exact: true }).waitFor()
    await release()
    await status.getByText('生成报告失败', { exact: true }).waitFor()
    await status.getByText('已保留 1 条抽取记录。', { exact: true }).waitFor()
    await page.waitForTimeout(3500)
    assert.equal(await page.getByText('已完成研究分析：生成 1 条记录和一份报告', { exact: true }).count(), 0)
    await status.locator('summary').click()
    await status.getByText(/Synthetic report failure/).waitFor()
    await page.screenshot({ path: path.join(root, 'report-failure.png') })
    await app.evaluate(() => { global.progressFixture.failure = '' })
    await status.getByRole('button', { name: '仅重试报告' }).click()
    await status.getByText('正在生成研究报告', { exact: true }).waitFor()
    await release()
    await status.getByText('分析与报告已完成', { exact: true }).waitFor()
    assert.equal(await app.evaluate(() => global.progressFixture.runs), 1, 'report retry does not repeat extraction')
    for (const failure of ['plan', 'extract']) {
      await app.evaluate((_electron, value) => { global.progressFixture.failure = value }, failure)
      await start()
      await status.getByText('正在生成抽取方案', { exact: true }).waitFor()
      await release()
      if (failure === 'extract') {
        await status.getByText('正在检索与统计原文', { exact: true }).waitFor()
        await release()
        await status.getByText('结构化抽取', { exact: true }).waitFor()
        await release()
      }
      await status.getByText(failure === 'plan' ? '生成抽取方案失败' : '结构化抽取失败', { exact: true }).waitFor()
    }
    assert.deepEqual(errors, [])
    console.log(`Research progress, persistent errors, and report-only retry passed. Screenshots: ${root}`)
  } catch (error) {
    if (page) console.error(await page.locator('body').innerText().catch(() => 'Page unavailable'))
    if (page) await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {})
    console.error('Failure screenshot:', path.join(root, 'failure.png'))
    throw error
  } finally { await app.close() }
}
run().catch((error) => { console.error(error); process.exit(1) })
