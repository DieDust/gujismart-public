// Uses synthetic IPC fixtures and an isolated Electron profile, never a user library.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { _electron: electron } = require('playwright')
const { enterResearchFixture } = require('./research-ui-fixture-startup')
process.on('uncaughtException', (error) => { console.error(error); process.exit(1) })

async function run() {
  const large = process.argv.includes('--large')
  const topic = process.argv.includes('--topic')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gujismart-graph-ui-'))
  const app = await electron.launch({
    args: ['--disable-gpu', `--user-data-dir=${path.join(root, 'user')}`, '.'],
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, GUJISMART_SMOKE: '1', GUJISMART_DATA_DIR: path.join(root, 'data'), GUJISMART_PROFILE_DIR: path.join(root, 'profile') },
  })
  try {
    const window = await app.firstWindow()
    const errors = []
    window.on('pageerror', (error) => errors.push(error.message))
    await enterResearchFixture(window, true)
    await app.evaluate(({ ipcMain }, { large, topic }) => {
      const project = (id, name) => ({
        id, name, description: '', tags: '', status: 'active', created_at: '', updated_at: '',
        document_count: 0, note_count: 0, ai_dataset_count: 1, output_count: 0, outline_count: 0,
      })
      const fields = [
        { key: 'person', label: '人物', type: 'person' }, { key: 'place', label: '地点', type: 'place' },
        { key: 'time', label: '时间', type: 'date' }, { key: 'event', label: '事件', type: 'text' },
      ]
      const dataset = (id) => ({
        id: `dataset-${id}`, project_id: id, name: id === 'fixture-a' ? '学术交游记录（示例）' : '迁徙记录（示例）',
        fieldSchema: fields, field_schema_json: JSON.stringify(fields), record_count: 3,
      })
      const fixtures = large ? Array.from({ length: 20 }, (_, index) => ({
        person: `人物${index}`, place: `地点${index}`, time: `${1800 + index}年`,
        event: `事件${index}：` + '这是一段用于验证长事件名称与证据区域尺寸的虚构记录，需要保留全文供研究者查阅。'.repeat(3),
      })) : [
        { person: '研究者甲;研究者乙', place: '北城;南城', time: '1900年', event: '书院讲学' },
        { person: '研究者甲;研究者丙', place: '南城', time: '1901年', event: '文献编纂' },
        { person: '排除对象', place: '未知地点', time: '1902年', event: '排除事件' },
      ]
      const replace = (channel, handler) => { ipcMain.removeHandler(channel); ipcMain.handle(channel, handler) }
      if (topic) {
        fixtures.push({ note: '只有原文证据，没有可映射实体的虚构材料' })
        globalThis.__topicFixture = { notes: [], updates: [], lists: [], failSave: true }
        replace('research:updateProject', (_event, id, payload) => {
          globalThis.__topicFixture.updates.push({ id, payload }); return true
        })
        replace('research:createNote', (_event, payload) => {
          if (globalThis.__topicFixture.failSave) { globalThis.__topicFixture.failSave = false; throw new Error('虚构保存失败，请重试') }
          globalThis.__topicFixture.notes.push(payload)
          return { id: 'saved-fixture-note', ...payload }
        })
        replace('documents:list', (_event, options) => {
          globalThis.__topicFixture.lists.push(options.offset)
          return Array.from({ length: 1003 }, (_, index) => ({ id: `picker-${index}`, title: `虚构文献${index}`, folder_ids: index === 1002 ? 'child-folder' : '', tag_ids: '', doc_type: '书籍' })).slice(options.offset, options.offset + options.limit)
        })
        replace('folders:list', () => [{ id: 'parent-folder', name: '父文件夹', parent_id: null }, { id: 'child-folder', name: '子文件夹', parent_id: 'parent-folder' }])
        replace('tags:list', () => [])
      }
      replace('research:listProjects', () => [project('fixture-a', '交游研究（示例）'), project('fixture-b', '迁徙研究（示例）')])
      replace('research:listOutline', async (_event, projectId) => {
        if (projectId === 'fixture-a') await new Promise((resolve) => setTimeout(resolve, 700))
        return [{ id: `outline-${projectId}`, project_id: projectId, title: projectId === 'fixture-a' ? '旧专题大纲' : '新专题大纲', parent_id: null, sort_order: 0 }]
      })
      replace('aiResearch:listDatasets', () => [dataset('fixture-a'), dataset('fixture-b')])
      const getRecords = async (datasetId) => {
        if (datasetId === 'dataset-fixture-a') await new Promise((resolve) => setTimeout(resolve, 80))
        return fixtures.map((values, index) => ({
          id: `${datasetId}-${index}`, dataset_id: datasetId, project_id: datasetId.slice(8), doc_id: `synthetic-doc-${index}`,
          doc_title: '示例文献', page_num: index + 1, values, values_json: JSON.stringify(values),
          status: !large && index === 2 ? 'excluded' : index === 1 ? 'confirmed' : 'pending',
          excerpt: '此为自动化测试使用的虚构材料。研究者甲与同人在书院交流，并整理相关文献。',
          locator_json: '{}', source_hash: '', confidence: 0.8,
        }))
      }
      replace('aiResearch:listRecords', async (_event, datasetId, options) => (await getRecords(datasetId)).slice(options.offset || 0, (options.offset || 0) + options.limit))
      replace('knowledgeGraph:getData', async (_event, query) => {
        const records = (await Promise.all(query.datasetIds.map(getRecords))).flat()
        return { libraryProjectId: 'fixture-library', datasets: query.datasetIds.map((id) => dataset(id.slice(8))), records, totalRecords: records.length, truncated: false }
      })
      replace('aiResearch:listTasks', () => [{ id: 'history-fixture', title: '虚构抽取任务', goal: '分析虚构材料', status: 'completed', record_count: 20, dataset_id: 'dataset-fixture-a', created_at: '2026-01-01', error_message: '' }])
      replace('aiResearch:listTaskSteps', () => [{ id: 'report-fixture', task_id: 'history-fixture', step_key: 'report', title: '生成报告', status: 'error', message: '测试服务暂不可用，已保存的抽取材料不受影响', progress: 0 }])
    }, { large, topic })
    // Keep clipboard export verification entirely inside this isolated renderer.
    await window.evaluate(() => Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: async (text) => { window.__graphExport = text } }, configurable: true,
    }))
    const researchMenu = window.locator('.ant-menu-item').filter({ hasText: /^知识图谱$/ })
    await researchMenu.click()
    await window.locator('.knowledge-workspace-header').getByText('资料浏览', { exact: true }).click()
    const graph = window.locator('.knowledge-workbench')
    const context = window.locator('.knowledge-context-bar')
    if (topic) {
      const materials = graph.getByRole('region', { name: '材料核验' })
      await materials.getByText('只有原文证据，没有可映射实体的虚构材料', { exact: false }).waitFor()
      assert.equal(await materials.locator('tbody tr.ant-table-row').count(), 3, 'source-only records must not disappear with graph mapping')
      await context.getByRole('combobox', { name: '研究专题', exact: true }).click()
      await window.locator('.ant-select-item-option').filter({ hasText: '交游研究（示例）' }).click()
      await context.getByRole('button', { name: '编辑专题与研究问题', exact: true }).click()
      const editTopic = window.getByRole('dialog', { name: '编辑研究专题', exact: true })
      await editTopic.getByRole('textbox', { name: '研究问题 / 专题说明' }).fill('书院讲学是否促进跨地交游？')
      await editTopic.locator('.ant-modal-footer .ant-btn-primary').click()
      await editTopic.waitFor({ state: 'hidden' })
      await materials.getByRole('textbox', { name: '搜索核验材料' }).fill('书院讲学')
      assert.equal(await materials.locator('tbody tr.ant-table-row').count(), 1)
      await materials.getByRole('button', { name: /核验 \/ 修订/ }).click()
      await graph.locator('.knowledge-evidence').getByText('原文与考证', { exact: true }).waitFor()
      await materials.getByRole('button', { name: /存入专题/ }).click()
      const collect = window.getByRole('dialog', { name: '存入研究专题', exact: true })
      await collect.getByText('待判断', { exact: true }).click()
      await window.locator('.ant-select-item-option').filter({ hasText: '反证材料' }).click()
      await collect.getByRole('textbox', { name: '研究者按语' }).fill('原文仅记录共同讲学，尚不足以证明长期师承。')
      await collect.locator('.ant-modal-footer .ant-btn-primary').click()
      await collect.getByRole('alert').filter({ hasText: '虚构保存失败' }).waitFor()
      assert.equal(await collect.getByRole('textbox', { name: '研究者按语' }).inputValue(), '原文仅记录共同讲学，尚不足以证明长期师承。')
      await collect.locator('.ant-modal-footer .ant-btn-primary').click()
      await collect.waitFor({ state: 'hidden' })
      const saved = await app.evaluate(() => globalThis.__topicFixture)
      assert.equal(saved.notes.length, 1)
      assert.equal(saved.notes[0].project_id, 'fixture-a')
      assert.equal(saved.notes[0].page_num, 1)
      assert.equal(saved.notes[0].source_type, 'ai_research')
      assert.equal(saved.notes[0].locator_json, '{}')
      assert.equal(JSON.parse(saved.notes[0].source_id).recordId, 'dataset-fixture-a-0')
      assert(saved.notes[0].note.includes('待核验') && saved.notes[0].note.includes('反证材料') && saved.notes[0].note.includes('书院讲学是否'))
      assert(!saved.notes[0].excerpt.includes('长期师承'), 'researcher interpretation must never overwrite the original quote')
      assert.equal(saved.updates[0].payload.description, '书院讲学是否促进跨地交游？')
      await materials.getByRole('textbox', { name: '搜索核验材料' }).fill('')
      await materials.getByText('未排除材料', { exact: true }).click()
      await window.locator('.ant-select-item-option').filter({ hasText: /^已排除$/ }).click()
      assert.equal(await materials.locator('tbody tr.ant-table-row').count(), 1)
      await context.getByRole('button', { name: /选择文献/ }).click()
      const picker = window.getByRole('dialog', { name: '选择要分析的文献' })
      await picker.getByText('当前显示 1003 篇', { exact: false }).waitFor()
      await picker.locator('.ant-select').filter({ hasText: '文件夹（含子文件夹）' }).locator('.ant-select-selector').click()
      await window.locator('.ant-select-item-option').filter({ hasText: /^父文件夹$/ }).click()
      await picker.getByText('虚构文献1002', { exact: true }).waitFor()
      assert.equal(await picker.locator('[data-analysis-select-id]').count(), 1)
      assert.deepEqual((await app.evaluate(() => globalThis.__topicFixture)).lists, [0, 500, 1000])
      await picker.getByRole('button', { name: /取\s*消/ }).click()
      for (const [width, height] of [[1440, 1000], [1024, 900]]) {
        await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), [width, height])
        await window.waitForTimeout(300)
        assert(await graph.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), 'topic workbench must not overflow horizontally')
        await window.screenshot({ path: path.join(root, `topic-${width}.png`) })
      }
      assert.deepEqual(errors, [])
      console.log(`Research topic evidence workflow passed. Screenshots: ${root}`)
      return
    }
    await graph.getByText('关系网络', { exact: true }).click()
    await graph.getByText(large ? '80 实体 · 60 关联' : '9 实体 · 9 关联', { exact: true }).waitFor({ timeout: 15000 })
    await window.waitForFunction(() => document.querySelectorAll('.knowledge-node-button').length > 0)
    await window.waitForTimeout(400)
    const pixels = await window.evaluate(() => Array.from(document.querySelectorAll('.knowledge-canvas canvas')).reduce((count, canvas) => {
      const context = canvas.getContext('2d')
      if (!context) return count
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data
      for (let i = 3; i < data.length; i += 4) if (data[i]) count += 1
      return count
    }, 0))
    assert(pixels > 500, 'graph canvas must contain rendered pixels')
    const canvas = graph.locator('.knowledge-canvas')
    const snapshot = () => canvas.evaluate((element) => {
      const cy = element._cyreg.cy
      return { zoom: cy.zoom(), pan: cy.pan(), nodes: cy.nodes().map((node) => ({
        id: node.id(), label: node.data('label'), position: node.position(), rendered: node.renderedPosition(), locked: node.locked(),
      })) }
    })
    if (large) {
      for (const [name, width, height, scale] of [['wide', 3840, 2032, 1], ['scaled', 2194, 1161, 1.75], ['desktop', 1440, 1000, 1], ['compact', 1024, 900, 1]]) {
        const session = await window.context().newCDPSession(window)
        await session.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false })
        await window.waitForTimeout(500)
        const measure = () => canvas.evaluate((element) => {
          const rect = (selector) => {
            const e = document.querySelector(selector)
            const r = e.getBoundingClientRect()
            return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height, scrollHeight: e.scrollHeight, clientHeight: e.clientHeight }
          }
          return { canvas: rect('.knowledge-canvas'), stage: rect('.knowledge-canvas-stage'), tools: rect('.knowledge-canvas-tools'), evidence: rect('.knowledge-evidence'), workbench: rect('.knowledge-workbench'), bb: element._cyreg.cy.elements().renderedBoundingBox(), size: [element._cyreg.cy.width(), element._cyreg.cy.height()], viewport: [innerWidth, innerHeight] }
        })
        const assertFit = (m) => {
          assert(Math.abs(m.canvas.height - m.stage.height) < 2, `${name}: drawing area and toolbar stage must share height`)
          assert(Math.abs(m.canvas.height - m.size[1]) < 2, `${name}: Cytoscape must measure the actual drawing area`)
          assert(m.tools.bottom <= m.canvas.bottom && m.tools.bottom <= m.viewport[1], `${name}: tools must stay inside visible canvas`)
          assert(m.canvas.bottom <= m.viewport[1] + 1, `${name}: graph bottom must remain visible`)
          assert(m.bb.x1 >= 0 && m.bb.y1 >= 0 && m.bb.x2 <= m.canvas.width && m.bb.y2 <= m.canvas.height, `${name}: all nodes and labels must fit: ${JSON.stringify(m)}`)
          assert(m.workbench.scrollHeight <= m.workbench.clientHeight + 1, `${name}: long evidence must not stretch the page`)
        }
        assertFit(await measure())
        await graph.getByRole('button', { name: '适应画布', exact: true }).click()
        assertFit(await measure())
        const beforeScroll = await measure()
        await graph.locator('.knowledge-evidence').evaluate((element) => { element.scrollTop = element.scrollHeight })
        const afterScroll = await measure()
        assert.deepEqual(afterScroll.canvas, beforeScroll.canvas, 'evidence scroll must not move or resize canvas')
        assert((await snapshot()).nodes.some((node) => node.label.length > 90), 'full event names must be retained')
        await window.screenshot({ path: path.join(root, `large-${name}.png`) })
        await session.detach()
      }
      await context.getByRole('button', { name: /分析记录/ }).click()
      const history = window.getByRole('dialog', { name: '分析记录', exact: true })
      await history.getByRole('alert').getByText('生成报告失败', { exact: true }).waitFor()
      await history.getByText('抽取：已完成', { exact: true }).waitFor()
      await history.locator('.ant-drawer-close').click()
      await context.getByRole('button', { name: /分析记录/ }).click()
      await history.getByRole('alert').getByText('生成报告失败', { exact: true }).waitFor()
      assert.deepEqual(errors, [])
      console.log(`Large graph viewport and persisted report history passed. Screenshots: ${root}`)
      return
    }
    const beforeWheel = await snapshot()
    const bounds = await canvas.boundingBox()
    const anchor = { x: bounds.width * 0.4, y: bounds.height * 0.4 }
    await window.mouse.move(bounds.x + anchor.x, bounds.y + anchor.y)
    await window.mouse.wheel(0, -100)
    await window.waitForTimeout(230)
    const afterWheel = await snapshot()
    assert(afterWheel.zoom / beforeWheel.zoom > 1.28, 'one wheel notch should visibly zoom within 230ms')
    for (const axis of ['x', 'y']) {
      const oldWorld = (anchor[axis] - beforeWheel.pan[axis]) / beforeWheel.zoom
      const newWorld = (anchor[axis] - afterWheel.pan[axis]) / afterWheel.zoom
      assert(Math.abs(oldWorld - newWorld) < 2, 'wheel must stay anchored to cursor')
    }
    await window.mouse.wheel(0, 100)
    await window.waitForTimeout(230)
    assert(Math.abs((await snapshot()).zoom - beforeWheel.zoom) < 0.01, 'reverse wheel returns without lingering momentum')
    await graph.getByRole('button', { name: '适应画布', exact: true }).click()
    await window.waitForTimeout(100)
    const nodePoint = async () => {
      const current = await snapshot()
      const node = current.nodes.find((item) => item.label === '研究者甲')
      const rect = await canvas.boundingBox()
      return { ...node, x: rect.x + node.rendered.x, y: rect.y + node.rendered.y }
    }
    let node = await nodePoint()
    await window.mouse.move(node.x, node.y)
    await graph.locator('.knowledge-node-tooltip').getByText('研究者甲', { exact: true }).waitFor()
    await window.mouse.click(node.x, node.y)
    await graph.locator('.knowledge-evidence').getByRole('button', { name: /原文/ }).first().waitFor()
    await window.mouse.click(node.x, node.y, { button: 'right' })
    await graph.getByRole('menuitem', { name: /固定节点位置$/ }).click()
    assert((await snapshot()).nodes.find((item) => item.id === node.id).locked)
    await window.mouse.click(node.x, node.y, { button: 'right' })
    await graph.getByRole('menuitem', { name: /复制名称$/ }).click()
    assert.equal(await window.evaluate(() => window.__graphExport), '研究者甲')
    await window.mouse.click(node.x, node.y, { button: 'right' })
    await window.keyboard.press('Escape')
    assert.equal(await graph.locator('.knowledge-node-menu').count(), 0)
    await window.mouse.click(node.x, node.y, { button: 'right' })
    await graph.getByRole('menuitem', { name: /解除位置固定$/ }).click()
    await window.mouse.move(node.x, node.y)
    await window.mouse.down()
    await window.mouse.move(node.x + 35, node.y + 20, { steps: 8 })
    await window.mouse.up()
    const dragged = await snapshot()
    assert(Math.abs(dragged.nodes.find((item) => item.id === node.id).position.x - node.position.x) > 10)
    await graph.getByRole('checkbox', { name: '仅已确认记录', exact: true }).check()
    await window.waitForTimeout(100)
    await graph.getByRole('checkbox', { name: '仅已确认记录', exact: true }).uncheck()
    await window.waitForTimeout(100)
    const restored = await snapshot()
    assert.deepEqual(restored.nodes.find((item) => item.id === node.id).position, dragged.nodes.find((item) => item.id === node.id).position)
    assert.deepEqual(restored.pan, dragged.pan, 'filtering must preserve viewport')
    assert.equal(restored.zoom, dragged.zoom)
    node = await nodePoint()
    await window.mouse.dblclick(node.x, node.y, { delay: 70 })
    await graph.getByRole('button', { name: /清除定位/ }).waitFor()
    await window.waitForTimeout(250)
    assert((await snapshot()).nodes.length < restored.nodes.length, 'double click focuses local neighborhood')
    await graph.getByRole('button', { name: /清除定位/ }).click()
    await graph.getByRole('button', { name: /JSON/ }).click()
    const exported = JSON.parse(await window.evaluate(() => window.__graphExport))
    assert(exported.nodes.some((node) => node.kind === 'event'))
    assert(exported.edges.every((edge) => edge.kind === 'event'))
    assert(!exported.evidence.some((record) => record.status === 'excluded'))
    await graph.locator('.knowledge-node-button').filter({ hasText: '研究者甲' }).click()
    await graph.locator('.knowledge-evidence').getByRole('button', { name: /原文/ }).first().waitFor()
    assert(await graph.locator('.knowledge-evidence').getByText('待核验', { exact: true }).count())
    await graph.getByRole('checkbox', { name: '仅已确认记录', exact: true }).check()
    await graph.getByRole('button', { name: /JSON/ }).click()
    const confirmed = JSON.parse(await window.evaluate(() => window.__graphExport))
    assert(confirmed.evidence.length > 0 && confirmed.evidence.every((record) => record.status === 'confirmed'))
    await graph.getByRole('checkbox', { name: '仅已确认记录', exact: true }).uncheck()
    await graph.getByRole('button', { name: '放大图谱', exact: true }).click()
    await graph.getByRole('button', { name: '适应画布', exact: true }).click()
    await graph.getByRole('button', { name: '刷新图谱', exact: true }).click()
    await window.waitForFunction(() => document.querySelectorAll('.knowledge-node-button').length > 0)
    await graph.getByText('人物考察', { exact: true }).click()
    await graph.locator('.ant-table').waitFor()
    const study = graph.locator('.knowledge-study-table')
    const tableNames = () => study.locator('tbody tr.ant-table-row').evaluateAll((rows) => rows.map((row) => row.querySelector('td').textContent))
    assert.equal((await tableNames()).length, 3, 'person view must not mix places and events')
    await study.getByRole('columnheader', { name: /人物姓名/ }).click()
    const sortedNames = await tableNames()
    assert.deepEqual(sortedNames, [...sortedNames].sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true, sensitivity: 'base' })))
    await study.getByRole('columnheader', { name: /人物姓名/ }).click()
    assert.deepEqual(await tableNames(), [...sortedNames].reverse())
    await study.getByRole('textbox', { name: '搜索考察表' }).fill('1901年')
    await window.waitForTimeout(150)
    assert.equal((await tableNames()).length, 2, 'search related original dates without pressing Enter')
    await study.getByRole('textbox', { name: '搜索考察表' }).fill('no-matching-fixture')
    await window.waitForTimeout(150)
    assert.equal((await tableNames()).length, 0)
    await study.getByRole('textbox', { name: '搜索考察表' }).fill('')
    await study.getByText('全部核验状态', { exact: true }).click()
    await window.getByText('含待核验材料', { exact: true }).click()
    assert.equal((await tableNames()).length, 2)
    await study.getByRole('button', { name: '研究者甲', exact: true }).click()
    await graph.locator('.knowledge-evidence').getByRole('button', { name: /考证此对象/ }).waitFor()
    await window.waitForTimeout(3000)
    await graph.screenshot({ path: path.join(root, 'graph-people.png') })
    await graph.getByText('地点考察', { exact: true }).click()
    assert.equal((await tableNames()).length, 2)
    await graph.getByText('事件考察', { exact: true }).click()
    assert.equal((await tableNames()).length, 2)
    await graph.getByText('关系考证', { exact: true }).first().click()
    assert((await graph.locator('.ant-table').innerText()).includes('记录关联'))
    await graph.getByText('时间线索', { exact: true }).click()
    assert((await graph.locator('.ant-table').innerText()).includes('1900年'))
    await graph.getByText('关系网络', { exact: true }).click()

    for (const [name, width, height] of [['desktop', 1440, 1000], ['compact', 1024, 900]]) {
      await graph.getByRole('button', { name: '放大图谱', exact: true }).click()
      const viewportBeforeResize = await snapshot()
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size.width, size.height), { width, height })
      await graph.scrollIntoViewIfNeeded()
      await window.waitForTimeout(350)
      const bounds = await graph.evaluate((element) => {
        const stage = element.querySelector('.knowledge-main').getBoundingClientRect()
        const evidence = element.querySelector('.knowledge-evidence').getBoundingClientRect()
        return { width: element.clientWidth, scrollWidth: element.scrollWidth, overlap: stage.right > evidence.left + 1 && stage.bottom > evidence.top + 1 }
      })
      assert(bounds.scrollWidth <= bounds.width + 1, `${name}: no horizontal overflow`)
      assert(!bounds.overlap, `${name}: graph and evidence must not overlap`)
      assert.equal((await snapshot()).zoom, viewportBeforeResize.zoom, 'resizing must not reset zoom')
      await window.waitForTimeout(3000)
      await graph.screenshot({ path: path.join(root, `graph-${name}.png`) })
      await graph.getByText('人物考察', { exact: true }).click()
      const tableBounds = await graph.evaluate((element) => {
        const main = element.querySelector('.knowledge-main').getBoundingClientRect()
        const evidence = element.querySelector('.knowledge-evidence').getBoundingClientRect()
        return { width: element.clientWidth, scrollWidth: element.scrollWidth, overlap: main.right > evidence.left + 1 && main.bottom > evidence.top + 1 }
      })
      assert(tableBounds.scrollWidth <= tableBounds.width + 1, `${name}: table overflow stays inside its scroll container`)
      assert(!tableBounds.overlap, `${name}: study table and evidence must not overlap`)
      await graph.screenshot({ path: path.join(root, `graph-people-${name}.png`) })
      await graph.getByText('关系网络', { exact: true }).click()
      await window.waitForTimeout(100)
    }
    assert.deepEqual(errors, [])
    console.log(`Research graph Electron UI regression passed. Screenshots: ${root}`)
  } catch (error) {
    const window = app.windows()[0]
    if (window) {
      console.error(await window.evaluate(() => ['.knowledge-workbench', '.knowledge-content', '.knowledge-body', '.knowledge-main', '.knowledge-canvas-stage', '.knowledge-canvas'].map((selector) => {
        const e = document.querySelector(selector)
        if (!e) return { selector }
        const r = e.getBoundingClientRect()
        const cy = e._cyreg?.cy
        return { selector, width: r.width, height: r.height, client: [e.clientWidth, e.clientHeight], scroll: [e.scrollWidth, e.scrollHeight], cy: cy && { width: cy.width(), height: cy.height(), zoom: cy.zoom(), bounds: cy.elements().renderedBoundingBox() } }
      })))
      await window.screenshot({ path: path.join(root, 'failure.png') })
      console.error(`Graph UI failure screenshot: ${path.join(root, 'failure.png')}`)
    }
    throw error
  } finally {
    await app.close()
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1 })
