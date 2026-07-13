const { _electron: electron } = require('playwright')
const fs = require('fs')
const os = require('os')
const path = require('path')

const LABELS = {
  welcomeTitle: '\u6587\u732e\u7ba1\u7406',
  library: '\u6587\u732e\u5e93',
  research: '\u7814\u7a76',
  search: '\u68c0\u7d22',
  citation: '\u5f15\u7528\u683c\u5f0f',
  tags: '\u6807\u7b7e',
  dashboard: '\u5904\u7406\u961f\u5217',
  settings: '\u8bbe\u7f6e'
}

function expectContains(text, needle, context) {
  if (!text.includes(needle)) {
    throw new Error(`Expected ${context} to contain "${needle}"`)
  }
}

function getMainText() {
  return Array.from(document.querySelectorAll('main'))
    .map((node) => node.textContent || '')
    .join('\n')
}

function getLibraryCardText() {
  return Array.from(document.querySelectorAll('[data-library-document-card="true"]'))
    .map((node) => node.textContent || '')
    .join('\n')
}

async function waitForLibrarySearchInput(window) {
  await window.waitForFunction(() => {
    return Boolean(document.querySelector('input[data-library-search-input="true"]'))
  }, null, { timeout: 8000 })
}

async function openLibraryView(window) {
  await clickMenu(window, LABELS.library)
  try {
    await waitForLibrarySearchInput(window)
  } catch {
    await window.evaluate((label) => {
      const item = Array.from(document.querySelectorAll('.ant-menu-item, .ant-menu-submenu-title'))
        .find((node) => (node.textContent || '').trim() === label)
      if (item instanceof HTMLElement) item.click()
    }, LABELS.library)
    await window.waitForTimeout(1000)
    await waitForLibrarySearchInput(window)
  }
}

async function setLibrarySearchValue(window, value) {
  await window.evaluate((nextValue) => {
    const input = document.querySelector('input[data-library-search-input="true"]')
    if (!(input instanceof HTMLInputElement)) throw new Error('Missing library search input')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    if (!setter) throw new Error('Missing native input value setter')
    setter.call(input, nextValue)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, value)
}

async function submitLibrarySearch(window) {
  await window.evaluate(() => {
    const button = document.querySelector('button[data-library-search-submit="true"]')
    if (!(button instanceof HTMLButtonElement)) throw new Error('Missing library search submit button')
    button.click()
  })
}

async function clickMenu(window, label) {
  await dismissBlockingModal(window)
  const items = window.locator('.ant-menu-item, .ant-menu-submenu-title')
  const index = await items.evaluateAll((nodes, target) => {
    return nodes.findIndex((node) => (node.textContent || '').trim() === target)
  }, label)

  if (index < 0) {
    throw new Error(`Missing menu item: ${label}`)
  }

  await items.nth(index).click()
  await window.waitForTimeout(700)
}

async function dismissBlockingModal(window) {
  let attempts = 0
  while (await dismissOneBlockingModal(window)) {
    attempts += 1
    if (attempts >= 8) break
    await window.waitForTimeout(400)
  }
}

async function dismissOneBlockingModal(window) {
  return window.evaluate(() => {
    const wraps = Array.from(document.querySelectorAll('.ant-modal-wrap'))
    for (const wrap of wraps) {
      const style = window.getComputedStyle(wrap)
      if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none') continue
      const target = wrap.querySelector('.ant-modal-close')
        || wrap.querySelector('.ant-modal-confirm-btns .ant-btn-default')
        || wrap.querySelector('.ant-modal-footer .ant-btn-default')
      if (target instanceof HTMLElement) {
        target.click()
        return true
      }
    }
    return false
  })
}

async function verifyMainText(window, expectedText) {
  const text = await window.locator('main').innerText()
  expectContains(text, expectedText, 'main content')
}

async function assertActiveSearchHighlightIsVisuallyDistinct(window, label) {
  const state = await window.evaluate(() => {
    const activeMarks = Array.from(document.querySelectorAll('mark[data-search-active="true"]'))
    const active = activeMarks[0]
    const inactive = Array.from(document.querySelectorAll('mark[data-search-hit-index]'))
      .find((mark) => mark.getAttribute('data-search-active') !== 'true')
    const activeStyle = active ? getComputedStyle(active) : null
    const inactiveStyle = inactive ? getComputedStyle(inactive) : null
    return {
      activeCount: activeMarks.length,
      activeText: active?.textContent || '',
      activeBackground: activeStyle?.backgroundColor || '',
      activeBorderColor: activeStyle?.borderColor || '',
      activeBoxShadow: activeStyle?.boxShadow || '',
      activeOutlineStyle: activeStyle?.outlineStyle || '',
      activeOutlineWidth: activeStyle?.outlineWidth || '',
      inactivePresent: !!inactive,
      inactiveBackground: inactiveStyle?.backgroundColor || '',
      inactiveBorderColor: inactiveStyle?.borderColor || '',
      inactiveBoxShadow: inactiveStyle?.boxShadow || '',
      inactiveOutlineStyle: inactiveStyle?.outlineStyle || '',
      counter: document.querySelector('[data-reader-search-counter="true"]')?.textContent || '',
    }
  })
  const activeOutlineWidth = Number.parseFloat(state.activeOutlineWidth || '0') || 0
  const hasActiveRing = state.activeBoxShadow !== 'none'
    || (state.activeOutlineStyle !== 'none' && activeOutlineWidth > 0)
  const differsFromInactive = !state.inactivePresent
    || state.activeBackground !== state.inactiveBackground
    || state.activeBorderColor !== state.inactiveBorderColor
    || state.activeBoxShadow !== state.inactiveBoxShadow
    || state.activeOutlineStyle !== state.inactiveOutlineStyle
  if (state.activeCount !== 1 || !hasActiveRing || !differsFromInactive) {
    throw new Error(`Expected active search highlight to be visually distinct at ${label}, saw ${JSON.stringify(state)}`)
  }
}

async function verifyCitationStyles(window) {
  const payload = await window.evaluate(async () => {
    const styles = await window.api.listCitationStyles()
    const templates = await window.api.listCitationTemplates()
    return { styles, templates }
  })
  if (!Array.isArray(payload.styles) || payload.styles.length < 1) {
    throw new Error(`Expected at least one citation style, saw ${JSON.stringify(payload)}`)
  }
  if (!Array.isArray(payload.templates) || payload.templates.some((template) => !template.style_id)) {
    throw new Error(`Expected citation templates to have style_id, saw ${JSON.stringify(payload.templates)}`)
  }
  const mainText = await window.locator('main').innerText()
  expectContains(mainText, '默认使用《历史研究》脚注注释体例', 'citation view')
  expectContains(mainText, '个类型已设置', 'citation view')
  expectContains(mainText, '专著', 'citation document type slots')

  const previewButtons = window.getByText('用实际文献预览')
  if (await previewButtons.count() < 1) {
    const editButtons = window.getByText(/编辑此类型|设置此类型/)
    if (await editButtons.count() < 1) {
      throw new Error('Expected citation type slot controls to be visible')
    }
    return
  }
  await previewButtons.first().click()
  await window.waitForFunction(() => {
    const modals = Array.from(document.querySelectorAll('.ant-modal-content'))
    const dialogText = modals
      .map((node) => node.textContent || '')
      .join('\n')
    return modals.length > 0 && dialogText.length > 20 && !dialogText.includes('暂无可预览内容')
  }, null, { timeout: 8000 })
  const modalButtons = window.locator('.ant-modal-content button')
  const buttonCount = await modalButtons.count()
  if (buttonCount > 0) {
    await modalButtons.nth(buttonCount - 1).click()
  }
  await window.waitForFunction(() => document.querySelectorAll('.ant-modal-content').length === 0, null, { timeout: 5000 }).catch(async () => {
    const closed = await window.evaluate(() => {
      const modals = Array.from(document.querySelectorAll('.ant-modal'))
      for (const modal of modals) {
        const modalElement = modal
        const style = window.getComputedStyle(modalElement)
        if (style.display === 'none' || style.visibility === 'hidden') continue
        const closeButton = modalElement.querySelector('.ant-modal-close')
          || modalElement.querySelector('.ant-modal-footer button:last-child')
        if (closeButton) {
          closeButton.click()
          return true
        }
      }
      return false
    })
    if (closed) {
      await window.waitForFunction(() => document.querySelectorAll('.ant-modal-content').length === 0, null, { timeout: 5000 })
    }
  })
}

let capabilityInputSequence = 0

async function importFilesWithCapabilities(window, filePaths) {
  const inputId = `smoke-capability-input-${++capabilityInputSequence}`
  await window.evaluate((id) => {
    const input = document.createElement('input')
    input.id = id
    input.type = 'file'
    input.multiple = true
    input.style.display = 'none'
    document.body.appendChild(input)
  }, inputId)

  try {
    await window.locator(`#${inputId}`).setInputFiles(filePaths)
    return await window.evaluate(async (id) => {
      const input = document.getElementById(id)
      const selectionResult = await window.api.grantDroppedImportSources(Array.from(input?.files || []))
      if (!selectionResult.ok) throw new Error(selectionResult.error.message)

      const results = []
      let cursor = null
      try {
        while (true) {
          const batchResult = await window.api.readImportSelectionBatch(selectionResult.value.selectionId, cursor, 200)
          if (!batchResult.ok) throw new Error(batchResult.error.message)
          if (batchResult.value.items.length > 0) {
            const batch = await window.api.importDocuments(batchResult.value.items.map((item) => item.grantId))
            results.push(...batch)
          }
          if (batchResult.value.done) break
          cursor = batchResult.value.nextCursor
        }
      } finally {
        await window.api.releaseImportSelection(selectionResult.value.selectionId)
      }
      return results
    }, inputId)
  } finally {
    await window.evaluate((id) => document.getElementById(id)?.remove(), inputId)
  }
}

async function verifyLibrarySearchSubmit(window, userDataDir) {
  const hitTitle = 'library-submit-hit-alpha'
  const missTitle = 'library-submit-miss-beta'
  const hitPath = path.join(userDataDir, `${hitTitle}.txt`)
  const missPath = path.join(userDataDir, `${missTitle}.txt`)
  fs.writeFileSync(hitPath, 'Library submit search smoke hit document.\n', 'utf8')
  fs.writeFileSync(missPath, 'Library submit search smoke miss document.\n', 'utf8')

  const importResults = await importFilesWithCapabilities(window, [hitPath, missPath])
  if (!Array.isArray(importResults) || importResults.length !== 2 || importResults.some((item) => !item?.success || !item?.id)) {
    throw new Error(`Expected library search smoke imports to succeed, saw ${JSON.stringify(importResults)}`)
  }

  const [hitDoc, missDoc] = importResults
  await window.evaluate(async ({ hitId, missId, hit, miss }) => {
    await window.api.updateDocument(hitId, { title: hit, import_status: 'processed', ocr_status: 'completed' })
    await window.api.updateDocument(missId, { title: miss, import_status: 'processed', ocr_status: 'completed' })
  }, { hitId: hitDoc.id, missId: missDoc.id, hit: hitTitle, miss: missTitle })

  const scopeState = await window.evaluate(async ({ hitId, missId }) => {
    await window.api.updateDocument(missId, { author: 'scope-author-target' })
    const folder = await window.api.createFolder({ name: 'scope-folder-target' })
    const tag = await window.api.createTag({ name: 'scope-tag-target' })
    if (!folder?.id || !tag?.id) throw new Error('Expected folder and tag setup to succeed')
    await window.api.addDocumentToFolder(hitId, folder.id)
    await window.api.addDocumentTag(missId, tag.id)

    const authorAsTitle = await window.api.listDocumentsPage({ search: 'scope-author-target', searchFields: ['title'], limit: 20, offset: 0 })
    const authorOnly = await window.api.listDocumentsPage({ search: 'scope-author-target', searchFields: ['author'], limit: 20, offset: 0 })
    const folderAsTitle = await window.api.listDocumentsPage({ search: 'scope-folder-target', searchFields: ['title'], limit: 20, offset: 0 })
    const folderOnly = await window.api.listDocumentsPage({ search: 'scope-folder-target', searchFields: ['folder'], limit: 20, offset: 0 })
    const tagAsAuthor = await window.api.listDocumentsPage({ search: 'scope-tag-target', searchFields: ['author'], limit: 20, offset: 0 })
    const tagOnly = await window.api.listDocumentsPage({ search: 'scope-tag-target', searchFields: ['tag'], limit: 20, offset: 0 })

    return {
      authorAsTitleTotal: authorAsTitle.total,
      authorOnlyTitles: authorOnly.items.map((item) => item.title),
      folderAsTitleTotal: folderAsTitle.total,
      folderOnlyTitles: folderOnly.items.map((item) => item.title),
      tagAsAuthorTotal: tagAsAuthor.total,
      tagOnlyTitles: tagOnly.items.map((item) => item.title),
    }
  }, { hitId: hitDoc.id, missId: missDoc.id })
  if (
    scopeState.authorAsTitleTotal !== 0 ||
    !scopeState.authorOnlyTitles.includes(missTitle) ||
    scopeState.folderAsTitleTotal !== 0 ||
    !scopeState.folderOnlyTitles.includes(hitTitle) ||
    scopeState.tagAsAuthorTotal !== 0 ||
    !scopeState.tagOnlyTitles.includes(missTitle)
  ) {
    throw new Error(`Expected library searchFields to constrain matching fields, saw ${JSON.stringify(scopeState)}`)
  }

  await clickMenu(window, LABELS.library)
  await waitForLibrarySearchInput(window)
  await setLibrarySearchValue(window, '')
  await submitLibrarySearch(window)
  try {
    await window.waitForFunction(({ hit, miss }) => {
      const text = Array.from(document.querySelectorAll('[data-library-document-card="true"]')).map((node) => node.textContent || '').join('\n')
      return text.includes(hit) && text.includes(miss)
    }, { hit: hitTitle, miss: missTitle }, { timeout: 8000 })
  } catch (error) {
    const debugState = await window.evaluate(() => ({
      mainText: (document.querySelector('main')?.textContent || '').slice(0, 1000),
      cardText: Array.from(document.querySelectorAll('[data-library-document-card="true"]')).map((node) => node.textContent || '').join('\n').slice(0, 1000),
      searchInput: document.querySelector('input[data-library-search-input="true"]')?.getAttribute('value') || '',
    }))
    throw new Error(`Expected smoke documents to appear in library view. ${JSON.stringify(debugState)}. ${(error && error.message) || error}`)
  }

  await setLibrarySearchValue(window, 'hit-alpha')
  await window.waitForTimeout(600)
  const preSubmitText = await window.evaluate(getLibraryCardText)
  if (!preSubmitText.includes(hitTitle) || !preSubmitText.includes(missTitle)) {
    throw new Error('Expected library search input to wait for explicit submit before filtering')
  }

  await submitLibrarySearch(window)
  try {
    await window.waitForFunction(({ hit, miss }) => {
      const text = Array.from(document.querySelectorAll('[data-library-document-card="true"]')).map((node) => node.textContent || '').join('\n')
      return text.includes(hit) && !text.includes(miss)
    }, { hit: hitTitle, miss: missTitle }, { timeout: 8000 })
  } catch (error) {
    const state = await window.evaluate(async ({ hit, miss }) => {
      const text = Array.from(document.querySelectorAll('[data-library-document-card="true"]')).map((node) => node.textContent || '').join('\n')
      const input = document.querySelector('input[data-library-search-input="true"]')?.value || ''
      const direct = await window.api.listDocumentsPage({ search: 'hit-alpha', limit: 20, offset: 0 })
      return {
        input,
        hasHit: text.includes(hit),
        hasMiss: text.includes(miss),
        text: text.slice(0, 1000),
        directTitles: direct.items.map((item) => item.title),
        directTotal: direct.total,
        loadingText: document.querySelector('.empty-state')?.textContent || '',
        emptyText: document.querySelector('.ant-empty')?.textContent || '',
        mainText: document.querySelector('main')?.textContent?.slice(0, 1000) || '',
        cardCount: document.querySelectorAll('[data-library-document-card="true"]').length,
        listRows: document.querySelectorAll('[role="row"], [aria-rowindex]').length,
      }
    }, { hit: hitTitle, miss: missTitle })
    throw new Error(`Expected Enter to submit library search; state=${JSON.stringify(state)}; cause=${error.message}`)
  }

  const searchInput = window.locator('input[data-library-search-input="true"]').first()
  await searchInput.fill('')
  await window.locator('button[data-library-search-submit="true"]').first().click()
  await window.waitForFunction(({ hit, miss }) => {
    const text = Array.from(document.querySelectorAll('[data-library-document-card="true"]')).map((node) => node.textContent || '').join('\n')
    return text.includes(hit) && text.includes(miss)
  }, { hit: hitTitle, miss: missTitle }, { timeout: 8000 })

  await searchInput.fill('miss-beta')
  await window.locator('button[data-library-search-submit="true"]').first().click()
  await window.waitForFunction(({ hit, miss }) => {
    const text = Array.from(document.querySelectorAll('[data-library-document-card="true"]')).map((node) => node.textContent || '').join('\n')
    return !text.includes(hit) && text.includes(miss)
  }, { hit: hitTitle, miss: missTitle }, { timeout: 8000 })

  await window.locator('button[data-library-search-fields-trigger="true"]').first().click()
  const fieldLabels = window.locator('[data-library-search-fields-menu="true"] label')
  for (const label of ['\u6807\u9898', '\u6587\u4ef6\u5939', '\u6807\u7b7e']) {
    await fieldLabels.filter({ hasText: label }).first().click()
  }
  await searchInput.fill('scope-author-target')
  await window.locator('button[data-library-search-submit="true"]').first().click()
  await window.waitForFunction(({ hit, miss }) => {
    const text = Array.from(document.querySelectorAll('[data-library-document-card="true"]')).map((node) => node.textContent || '').join('\n')
    return !text.includes(hit) && text.includes(miss)
  }, { hit: hitTitle, miss: missTitle }, { timeout: 8000 })

  await window.locator('button[data-library-search-fields-trigger="true"]').first().click()
  await window.locator('button[data-library-search-fields-all="true"]').first().click()
  await searchInput.fill('scope-folder-target')
  await window.locator('button[data-library-search-submit="true"]').first().click()
  await window.waitForFunction(({ hit, miss }) => {
    const text = Array.from(document.querySelectorAll('[data-library-document-card="true"]')).map((node) => node.textContent || '').join('\n')
    return text.includes(hit) && !text.includes(miss)
  }, { hit: hitTitle, miss: missTitle }, { timeout: 8000 })
}

async function verifyLibraryIncrementalLoading(window, userDataDir) {
  const prefix = 'library-incremental-smoke'
  const files = Array.from({ length: 12 }, (_, index) => {
    const title = `${prefix}-${String(index + 1).padStart(2, '0')}`
    const filePath = path.join(userDataDir, `${title}.txt`)
    fs.writeFileSync(filePath, `Library incremental loading smoke document ${index + 1}.\n`, 'utf8')
    return { title, filePath }
  })

  const importResults = await importFilesWithCapabilities(window, files.map((item) => item.filePath))
  if (!Array.isArray(importResults) || importResults.length !== files.length || importResults.some((item) => !item?.success || !item?.id)) {
    throw new Error(`Expected library incremental loading imports to succeed, saw ${JSON.stringify(importResults)}`)
  }

  await window.evaluate(async ({ results, titles }) => {
    for (let index = 0; index < results.length; index += 1) {
      await window.api.updateDocument(results[index].id, { title: titles[index] })
    }
  }, { results: importResults, titles: files.map((item) => item.title) })

  const pageState = await window.evaluate(async (search) => {
    const firstPage = await window.api.listDocumentsPage({ search, searchFields: ['title'], sortKey: 'title', sortDirection: 'asc', limit: 10, offset: 0 })
    const secondPage = await window.api.listDocumentsPage({ search, searchFields: ['title'], sortKey: 'title', sortDirection: 'asc', limit: 10, offset: 10 })
    return {
      firstCount: firstPage.items.length,
      secondCount: secondPage.items.length,
      total: firstPage.total,
      firstTitles: firstPage.items.map((item) => item.title),
      secondTitles: secondPage.items.map((item) => item.title),
    }
  }, prefix)
  if (
    pageState.total !== 12 ||
    pageState.firstCount !== 10 ||
    pageState.secondCount !== 2 ||
    !pageState.firstTitles.includes(`${prefix}-01`) ||
    !pageState.firstTitles.includes(`${prefix}-10`) ||
    !pageState.secondTitles.includes(`${prefix}-11`)
  ) {
    throw new Error(`Expected library listDocumentsPage to paginate 12 docs as 10 + 2, saw ${JSON.stringify(pageState)}`)
  }

  await clickMenu(window, LABELS.library)
  await waitForLibrarySearchInput(window)
  await window.waitForFunction(() => !document.querySelector('[data-library-health-panel="true"]'), undefined, { timeout: 8000 })
  const searchInput = window.locator('input[data-library-search-input="true"]').first()
  await searchInput.fill(prefix)
  await window.locator('button[data-library-search-submit="true"]').first().click()
  await window.waitForFunction((expectedPrefix) => {
    const cards = Array.from(document.querySelectorAll('[data-library-document-card="true"]'))
    return cards.length === 10
      && cards.every((node) => (node.textContent || '').includes(expectedPrefix))
      && !document.querySelector('[data-library-pagination="true"]')
  }, prefix, { timeout: 10000 })

  await window.locator('[data-library-document-card="true"]').last().scrollIntoViewIfNeeded()
  await window.mouse.wheel(0, 900)
  await window.waitForFunction((expectedPrefix) => {
    const cards = Array.from(document.querySelectorAll('[data-library-document-card="true"]'))
    const text = cards.map((node) => node.textContent || '').join('\n')
    return cards.length === 12
      && text.includes(`${expectedPrefix}-11`)
      && text.includes(`${expectedPrefix}-12`)
      && !document.querySelector('[data-library-pagination="true"]')
  }, prefix, { timeout: 10000 })

  const healthButton = window.locator('button[data-library-health-button="true"]').first()
  if (await healthButton.count() < 1) {
    throw new Error('Expected library health check button to be visible')
  }
  await healthButton.click()
  await window.waitForSelector('[data-library-health-panel="true"]', { timeout: 8000 })
}

async function verifySearchReaderRoundTrip(window, userDataDir) {
  const samplePath = path.join(userDataDir, 'smoke-reader.txt')
  fs.writeFileSync(
    samplePath,
    [
      '烟测试阅读文献',
      '',
      '第一章 检索闭环',
      '这一页包含第一个关键词 roundtrip-keyword，并在同一自然段里再次出现 roundtrip-keyword，用来验证检索结果可以打开阅读器。',
      '为肃清东北地区“反满抗日”等爱国主义进步思想，强化奴化思想，日本侵占中国东北后，开始从教科书和教师方面入手。教科书方面，1932年4月1日伪满国务院“院令”二号规定：“嗣后各学校课程暂用四书孝经讲授，以崇礼教，凡有关党义教科书等一律废止” [7]，废除一切与伪满洲国“建国精神”相悖的教科书以肃清进步思想传播，利用封建道德思想和“王道”精神奴化民众。后期伪满民生部编撰的教科书多包含“建国精神”“民族协和”“满洲帝国” [8]等奴化思想。具有爱国主义的教师受到伪满“政府的逮捕和迫害，行踪不明，为利用被迫留下来的中国教师，政府对他们进行‘建国精神’‘国内事情’‘国际关系’以及经学等方面的培训，以确保王道精神的彻底实施” [9]和奴化教育的顺利推行。',
      '',
      '第二章 阅读状态',
      '这一段用于验证阅读状态保存和再次打开恢复。',
    ].join('\n'),
    'utf8'
  )

  const importResults = await importFilesWithCapabilities(window, [samplePath])
  if (!Array.isArray(importResults) || !importResults[0]?.success) {
    throw new Error('Expected smoke text import to succeed')
  }

  const docId = importResults[0].id
  const groupedHits = await window.evaluate(async (id) => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const payload = await window.api.querySearchV2('roundtrip-keyword', { docIds: [id], limit: 10 })
      if (payload?.groups?.some((group) => group.docId === id && group.totalHits > 0 && group.topHits?.[0]?.locator?.docId === id)) return payload
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    return window.api.querySearchV2('roundtrip-keyword', { docIds: [id], limit: 10 })
  }, docId)
  const groupedDoc = groupedHits?.groups?.find((group) => group.docId === docId)
  if (!groupedDoc || groupedDoc.totalHits < 1 || !groupedDoc.topHits?.[0]?.locator) {
    throw new Error(`Expected querySearchV2 to return grouped hits with locator, saw ${JSON.stringify(groupedHits)}`)
  }
  const exportPreview = await window.evaluate(async (id) => {
    return window.api.exportSearchExcerpts('roundtrip-keyword', { docIds: [id], limit: 10, previewOnly: true, format: 'txt' })
  }, docId)
  if (
    !exportPreview?.content?.includes('roundtrip-keyword') ||
    !exportPreview.content.includes('引用：') ||
    !exportPreview.content.includes('这一页包含第一个关键词 roundtrip-keyword，并在同一自然段里再次出现 roundtrip-keyword，用来验证检索结果可以打开阅读器。') ||
    !exportPreview.content.includes('段落命中：2') ||
    (exportPreview.content.match(/这一页包含第一个关键词/g) || []).length !== 1 ||
    exportPreview.content.includes('...') ||
    exportPreview.content.includes('().') ||
    !/第 \d+ 页/.test(exportPreview.content)
  ) {
    throw new Error(`Expected search excerpt export preview to include full segment text and citation, saw ${exportPreview?.content}`)
  }

  const paragraphPreview = await window.evaluate(async (id) => {
    return window.api.exportSearchExcerpts('伪满洲国', { docIds: [id], limit: 10, previewOnly: true, format: 'txt' })
  }, docId)
  const expectedFullParagraph = '为肃清东北地区“反满抗日”等爱国主义进步思想，强化奴化思想，日本侵占中国东北后，开始从教科书和教师方面入手。教科书方面，1932年4月1日伪满国务院“院令”二号规定：“嗣后各学校课程暂用四书孝经讲授，以崇礼教，凡有关党义教科书等一律废止” [7]，废除一切与伪满洲国“建国精神”相悖的教科书以肃清进步思想传播，利用封建道德思想和“王道”精神奴化民众。后期伪满民生部编撰的教科书多包含“建国精神”“民族协和”“满洲帝国” [8]等奴化思想。具有爱国主义的教师受到伪满“政府的逮捕和迫害，行踪不明，为利用被迫留下来的中国教师，政府对他们进行‘建国精神’‘国内事情’‘国际关系’以及经学等方面的培训，以确保王道精神的彻底实施” [9]和奴化教育的顺利推行。'
  if (!paragraphPreview?.content?.includes(expectedFullParagraph) || paragraphPreview.content.includes('...')) {
    throw new Error(`Expected export to include the whole Chinese natural paragraph, saw ${paragraphPreview?.content}`)
  }

  const apiHits = await window.evaluate(async (id) => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const hits = await window.api.fulltextSearch('roundtrip-keyword', { docIds: [id], limit: 10 })
      if (Array.isArray(hits) && hits.some((item) => item.doc_id === id)) return hits
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    return window.api.fulltextSearch('roundtrip-keyword', { docIds: [id], limit: 10 })
  }, docId)
  if (!Array.isArray(apiHits) || !apiHits.some((item) => item.doc_id === docId)) {
    throw new Error('Expected fulltext API to find imported smoke document')
  }
  await window.evaluate(async (id) => {
    await window.api.saveReaderState(id, {
      location_key: 'page:1',
      progress: 0.5,
      view_mode: 'spread',
      font_size: 18,
      line_height: 1.8,
      theme: 'sepia'
    })
  }, docId)

  const searchSession = await window.evaluate(async (id) => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const session = await window.api.getDocumentSearchHits(id, 'roundtrip-keyword', { limit: 5000, resultMode: 'all' })
      if (session?.hits?.length >= 2) return session
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    return window.api.getDocumentSearchHits(id, 'roundtrip-keyword', { limit: 5000, resultMode: 'all' })
  }, docId)
  if (!searchSession?.hits?.length) {
    throw new Error(`Expected full document search session to contain hits, saw ${JSON.stringify(searchSession)}`)
  }
  await window.evaluate(async ({ id, session }) => {
    const locator = session.hits?.[0]?.locator
    window.__smokeOpenDocument?.({
      docId: id,
      pageIndex: locator?.pageIndex ?? 0,
      keyword: 'roundtrip-keyword',
      searchSession: session,
      locator
    })
  }, { id: docId, session: searchSession })
  await window.waitForFunction(() => {
    const text = document.querySelector('main')?.textContent || ''
    return text.includes('roundtrip-keyword') && document.querySelectorAll('main mark').length > 0
  }, null, { timeout: 5000 })

  const state = await window.evaluate(async (id) => window.api.getReaderState(id), docId)
  if (!state || typeof state.location_key !== 'string' || !state.location_key) {
    throw new Error('Expected reader state to be saved for opened smoke document')
  }

  await window.waitForSelector('[data-reader-search-result-list="true"]', { timeout: 5000 })
  const readerSearchResultCount = await window.locator('[data-reader-search-result-item="true"]').count()
  if (readerSearchResultCount < 1) {
    throw new Error('Expected reader sidebar search results to render after opening from search result')
  }
  await window.locator('[data-reader-search-result-item="true"]').nth(Math.min(1, readerSearchResultCount - 1)).click()
  await window.waitForFunction(() => {
    const counter = document.querySelector('[data-reader-search-counter="true"]')?.textContent || ''
    return document.querySelectorAll('[data-reader-search-result-active="true"]').length === 1
      && document.querySelectorAll('mark[data-search-active="true"]').length === 1
      && /\/\d+/.test(counter)
  }, null, { timeout: 5000 })
  await assertActiveSearchHighlightIsVisuallyDistinct(window, 'search reader roundtrip')
}

async function verifySearchDocumentHitDirectory(window, userDataDir) {
  const samplePath = path.join(userDataDir, 'smoke-search-hit-directory.txt')
  const keyword = 'directory-keyword'
  fs.writeFileSync(
    samplePath,
    [
      'smoke-search-hit-directory',
      '',
      ...Array.from({ length: 14 }, (_, index) => `section ${index + 1} ${keyword} context-before-${index} context-after-${index}`)
    ].join('\n'),
    'utf8'
  )

  const importResults = await importFilesWithCapabilities(window, [samplePath])
  if (!Array.isArray(importResults) || !importResults[0]?.success) {
    throw new Error('Expected search hit directory smoke import to succeed')
  }
  const docId = importResults[0].id
  await window.evaluate(async ({ id, title }) => {
    await window.api.updateDocument(id, { title })
  }, { id: docId, title: 'smoke-search-hit-directory' })
  await window.evaluate(async ({ id, keyword: activeKeyword }) => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const payload = await window.api.querySearchV2(activeKeyword, { docIds: [id], limit: 20, resultMode: 'all' })
      if (payload?.groups?.some((group) => group.docId === id && group.totalHits >= 14)) return
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }, { id: docId, keyword })

  await clickMenu(window, LABELS.search)
  const searchInput = window.locator('input[data-search-page-input="true"]').first()
  await searchInput.fill(keyword)
  await window.locator('button[data-search-page-submit="true"]').first().click()
  await window.waitForFunction(({ title }) => {
    const text = document.querySelector('main')?.textContent || ''
    return text.includes(title)
  }, { title: 'smoke-search-hit-directory' }, { timeout: 10000 })

  const directoryCountBeforeExpand = await window.locator('[data-search-doc-hit-list="true"]').count()
  if (directoryCountBeforeExpand !== 0) {
    throw new Error('Expected document hit directory to stay unloaded before expanding the card')
  }

  const targetCard = window.locator('.ant-card', { hasText: 'smoke-search-hit-directory' }).first()
  await targetCard.locator('button[data-search-doc-hits-toggle="true"]').first().click()
  await window.waitForSelector('[data-search-doc-hit-list="true"]', { timeout: 8000 })
  await window.waitForFunction(() => document.querySelectorAll('[data-search-doc-hit="true"]').length === 10, null, { timeout: 8000 }).catch(async (error) => {
    const text = await window.locator('[data-search-doc-hit-list="true"]').first().innerText().catch(() => '')
    const count = await window.locator('[data-search-doc-hit="true"]').count().catch(() => -1)
    throw new Error(`Expected first expanded hit page to show 10 hits, saw count=${count}, text=${text}; ${error.message}`)
  })

  const firstPageText = await window.locator('[data-search-doc-hit-list="true"]').first().innerText()
  if (!firstPageText.includes('#1') || !firstPageText.includes('#10')) {
    throw new Error(`Expected first expanded hit page to show hits #1-#10, saw: ${firstPageText}`)
  }
  const nextPageButton = window.locator('[data-search-doc-hit-list="true"] .ant-pagination-next button').first()
  if (await nextPageButton.count() < 1) {
    throw new Error('Expected search hit directory pagination next button')
  }
  await nextPageButton.click()
  await window.waitForFunction(() => {
    const text = document.querySelector('[data-search-doc-hit-list="true"]')?.textContent || ''
    return text.includes('#11')
  }, null, { timeout: 8000 })
  const secondPageHitCount = await window.locator('[data-search-doc-hit="true"]').count()
  if (secondPageHitCount !== 4) {
    const text = await window.locator('[data-search-doc-hit-list="true"]').first().innerText()
    throw new Error(`Expected second hit directory page to show 4 hits, saw count=${secondPageHitCount}, text=${text}`)
  }

  await window.locator('[data-search-doc-hit="true"]').first().click()
  await window.waitForFunction(({ title, activeKeyword }) => {
    const text = document.querySelector('main')?.textContent || ''
    return text.includes(title)
      && text.includes(activeKeyword)
      && document.querySelectorAll('mark[data-search-active="true"]').length === 1
      && document.querySelectorAll('[data-reader-search-result-item="true"]').length > 0
  }, { title: 'smoke-search-hit-directory', activeKeyword: keyword }, { timeout: 10000 })
}

async function verifyReaderSearchStaysWithinVisibleSpread(window, userDataDir) {
  const samplePath = path.join(userDataDir, 'smoke-visible-spread.txt')
  fs.writeFileSync(
    samplePath,
    [
      '\u7b2c 1 \u8282',
      '\u8fd9\u4e00\u8282\u6ca1\u6709\u76ee\u6807\u8bcd\uff0c\u53ea\u7528\u4e8e\u5360\u4f4d\u3002',
      '',
      '\u7b2c 2 \u8282',
      '\u8fd9\u4e00\u8282\u6ca1\u6709\u76ee\u6807\u8bcd\uff0c\u53ea\u7528\u4e8e\u5360\u4f4d\u3002',
      '',
      '\u7b2c 3 \u8282',
      '\u8fd9\u4e00\u8282\u6ca1\u6709\u76ee\u6807\u8bcd\uff0c\u53ea\u7528\u4e8e\u5360\u4f4d\u3002',
      '',
      '\u7b2c 4 \u8282',
      '\u7b2c\u4e00\u884c \u65e5\u672c',
      '\u7b2c\u4e8c\u884c \u65e5\u672c',
      '\u7b2c\u4e09\u884c \u666e\u901a\u6587\u672c',
      '',
      '\u7b2c 5 \u8282',
      '\u7b2c\u4e00\u884c \u65e5\u672c',
      '\u7b2c\u4e8c\u884c \u666e\u901a\u6587\u672c',
      '',
      '\u7b2c 6 \u8282',
      '\u540e\u7eed\u9875\u9762 \u65e5\u672c',
    ].join('\n'),
    'utf8'
  )

  const importResults = await importFilesWithCapabilities(window, [samplePath])
  if (!Array.isArray(importResults) || !importResults[0]?.success) {
    throw new Error('Expected visible spread smoke import to succeed')
  }

  const docId = importResults[0].id
  await window.evaluate(async (id) => {
    await window.api.saveReaderState(id, {
      location_key: 'page:2',
      progress: 0,
      view_mode: 'spread',
      font_size: 17,
      line_height: 1.8,
      theme: 'paper'
    })
  }, docId)
  await window.evaluate(async (id) => {
    await window.api.saveReaderState(id, {
      location_key: 'page:4',
      progress: 0,
      view_mode: 'spread',
      font_size: 17,
      line_height: 1.8,
      theme: 'paper'
    })
  }, docId)

  await window.evaluate(async ({ id }) => {
    const session = await window.api.getDocumentSearchHits(id, '\u65e5\u672c', { limit: 5000 })
    window.__smokeOpenDocument?.({
      docId: id,
      pageIndex: 3,
      keyword: '\u65e5\u672c',
      searchSession: session,
      locator: session.hits?.[0]?.locator
    })
  }, { id: docId })
  try {
    await window.waitForFunction(() => {
      const text = document.querySelector('main')?.textContent || ''
      const activeTabTitle = document.querySelector('[data-app-tab-active="true"]')?.textContent || ''
      return (activeTabTitle.includes('smoke-visible-spread') || text.includes('smoke-visible-spread')) && /1\s*\/\s*4/.test(text)
    }, null, { timeout: 5000 })
  } catch (error) {
    const text = await window.locator('main').innerText().catch(() => '')
    throw new Error(`Reader visible-spread setup did not reach expected 1/4 state. Main text: ${text.slice(0, 1200)}`)
  }
  const getVisibleSections = async () => window.locator('[data-reader-page="true"]').evaluateAll((nodes) => nodes.map((node) => node.textContent || ''))
  const before = await getVisibleSections()
  if (!before.some((text) => text.includes('\u7b2c 4 \u8282')) || !before.some((text) => text.includes('\u7b2c 5 \u8282'))) {
    throw new Error(`Expected section 4 and section 5 to be visible before search next, saw: ${before.join(' | ')}`)
  }
  if (before.length > 1 && before[0] === before[1]) {
    throw new Error(`Expected virtual search pages not to duplicate left/right content before next, saw: ${before.join(' | ')}`)
  }
  const getVisibleSearchState = async () => window.evaluate(() => {
    const items = Array.from(document.querySelectorAll('mark[data-search-hit-index]'))
      .map((mark) => {
        const element = mark
        const viewport = element.closest('[data-reader-page-viewport="true"]')
        const page = element.closest('[data-reader-page="true"]')
        if (!viewport || !page) return null
        const rect = element.getBoundingClientRect()
        const viewportRect = viewport.getBoundingClientRect()
        const visible = rect.width > 0
          && rect.height > 0
          && rect.right > viewportRect.left
          && rect.left < viewportRect.right
          && rect.bottom > viewportRect.top
          && rect.top < viewportRect.bottom
        if (!visible) return null
        return {
          index: Number(element.getAttribute('data-search-hit-index')),
          active: element.getAttribute('data-search-active') === 'true',
          background: getComputedStyle(element).backgroundColor,
          leaf: Number(page.getAttribute('data-reader-leaf-index')),
          top: rect.top,
          left: rect.left,
        }
      })
      .filter(Boolean)
      .sort((left, right) => left.leaf - right.leaf || left.top - right.top || left.left - right.left)
    return {
      visibleIndexes: items.map((item) => item.index),
      activeIndex: items.find((item) => item.active)?.index ?? -1,
      activeCount: items.filter((item) => item.active).length,
      activeBackground: items.find((item) => item.active)?.background || '',
    }
  })
  const isExpectedSearchHighlightBackground = (background) => {
    const channels = String(background || '').match(/\d+(?:\.\d+)?/g)?.map(Number) || []
    const [red, green, blue] = channels
    return red === 255 && (
      (green === 176 && blue === 32) ||
      (green === 212 && blue === 56) ||
      (green === 224 && blue === 102) ||
      (green === 229 && blue === 143)
    )
  }
  const beforeSearchState = await getVisibleSearchState()
  if (beforeSearchState.activeCount !== 1) {
    throw new Error(`Expected exactly one active hit before next, saw ${JSON.stringify(beforeSearchState)}`)
  }
  if (beforeSearchState.activeIndex !== beforeSearchState.visibleIndexes[0]) {
    throw new Error(`Expected first visible hit to be active before next, saw ${JSON.stringify(beforeSearchState)}`)
  }
  if (!isExpectedSearchHighlightBackground(beforeSearchState.activeBackground)) {
    throw new Error(`Expected active hit to use selected color before next, saw ${JSON.stringify(beforeSearchState)}`)
  }
  await assertActiveSearchHighlightIsVisuallyDistinct(window, 'visible spread before next')

  const nextSearchButton = window.locator('button[data-reader-search-next="true"]').first()
  const getNavigationEpoch = async () => window.locator('[data-search-navigation-epoch]').first().getAttribute('data-search-navigation-epoch').then((value) => Number(value || 0)).catch(() => 0)
  let previousEpoch = await getNavigationEpoch()
  await nextSearchButton.click()
  await window.waitForFunction((previous) => {
    const node = document.querySelector('[data-search-navigation-epoch]')
    return Number(node?.getAttribute('data-search-navigation-epoch') || 0) > previous
  }, previousEpoch, { timeout: 2000 })
  await window.waitForTimeout(500)
  const counterAfterFirstPress = await window.locator('[data-reader-search-counter="true"]').first().innerText()
  if (!counterAfterFirstPress.includes('2/4')) {
    const slashTexts = await window.locator('span').evaluateAll((nodes) => nodes.map((node) => node.textContent || '').filter((text) => text.includes('/')))
    throw new Error(`Expected Enter search navigation to advance to 2/4 immediately, saw: ${counterAfterFirstPress}; slash=${slashTexts.join(' || ')}`)
  }
  const after = await getVisibleSections()
  if (!after.some((text) => text.includes('\u7b2c 4 \u8282')) || !after.some((text) => text.includes('\u7b2c 5 \u8282'))) {
    throw new Error(`Search next should stay within visible spread before flipping, saw: ${after.join(' | ')}`)
  }
  if (after.length > 1 && after[0] === after[1]) {
    throw new Error(`Expected virtual search pages not to duplicate left/right content after first next, saw: ${after.join(' | ')}`)
  }
  const counter = counterAfterFirstPress
  if (!counter.includes('2/4')) {
    throw new Error(`Expected search counter to advance to 2/4, saw: ${counter}`)
  }
  const afterSearchState = await getVisibleSearchState()
  if (afterSearchState.activeCount !== 1) {
    throw new Error(`Expected exactly one active hit after next, saw ${JSON.stringify(afterSearchState)}`)
  }
  if (afterSearchState.activeIndex !== afterSearchState.visibleIndexes[1]) {
    throw new Error(`Expected second visible hit to be active after next, saw ${JSON.stringify(afterSearchState)}`)
  }
  if (!isExpectedSearchHighlightBackground(afterSearchState.activeBackground)) {
    throw new Error(`Expected active hit to use selected color after next, saw ${JSON.stringify(afterSearchState)}`)
  }
  await assertActiveSearchHighlightIsVisuallyDistinct(window, 'visible spread after next')

  previousEpoch = await getNavigationEpoch()
  await nextSearchButton.click()
  await window.waitForFunction((previous) => {
    const node = document.querySelector('[data-search-navigation-epoch]')
    return Number(node?.getAttribute('data-search-navigation-epoch') || 0) > previous
  }, previousEpoch, { timeout: 2000 })
  await window.waitForTimeout(700)
  const afterSecond = await getVisibleSections()
  if (!afterSecond.some((text) => text.includes('\u7b2c 5 \u8282'))) {
    throw new Error(`Search next should put the target hit page in view, saw: ${afterSecond.join(' | ')}`)
  }
  if (afterSecond.length > 1 && afterSecond[0] === afterSecond[1]) {
    throw new Error(`Expected virtual search pages not to duplicate left/right content after second next, saw: ${afterSecond.join(' | ')}`)
  }
  const counterSecond = await window.locator('[data-reader-search-counter="true"]').first().innerText()
  if (!counterSecond.includes('3/4')) {
    const debugState = await getVisibleSearchState()
    const slashTexts = await window.locator('span').evaluateAll((nodes) => nodes.map((node) => node.textContent || '').filter((text) => text.includes('/')))
    throw new Error(`Expected search counter to advance to 3/4 before flipping, saw: ${counterSecond}; slash=${slashTexts.join(' || ')}; state=${JSON.stringify(debugState)}; sections=${afterSecond.join(' | ')}`)
  }
  const afterSecondState = await getVisibleSearchState()
  const allHitStateAfterSecond = await window.evaluate(() => Array.from(document.querySelectorAll('mark[data-search-hit-index]')).map((mark) => {
      const rect = mark.getBoundingClientRect()
      const page = mark.closest('[data-reader-page="true"]')
      const viewport = mark.closest('[data-reader-page-viewport="true"]')
      const viewportRect = viewport?.getBoundingClientRect()
      return {
        index: Number(mark.getAttribute('data-search-hit-index')),
        active: mark.getAttribute('data-search-active') === 'true',
        text: mark.textContent,
        pageLeaf: Number(page?.getAttribute('data-reader-leaf-index') || 0),
        rect: { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
        viewport: viewportRect ? { top: viewportRect.top, left: viewportRect.left, right: viewportRect.right, bottom: viewportRect.bottom } : null,
      }
    }))
  if (allHitStateAfterSecond.filter((item) => item.active).length !== 1 || allHitStateAfterSecond.find((item) => item.active)?.index !== 2) {
    throw new Error(`Expected third hit to be active before page flip, saw ${JSON.stringify(afterSecondState)}; all=${JSON.stringify(allHitStateAfterSecond)}`)
  }

  previousEpoch = await getNavigationEpoch()
  await nextSearchButton.click()
  await window.waitForFunction((previous) => {
    const node = document.querySelector('[data-search-navigation-epoch]')
    return Number(node?.getAttribute('data-search-navigation-epoch') || 0) > previous
  }, previousEpoch, { timeout: 2000 })
  await window.waitForTimeout(150)
  const afterThird = await getVisibleSections()
  if (!afterThird.some((text) => text.includes('\u7b2c 6 \u8282'))) {
    throw new Error(`Search next should flip only after visible spread hits are exhausted, saw: ${afterThird.join(' | ')}`)
  }
  const counterThird = await window.locator('[data-reader-search-counter="true"]').first().innerText()
  if (!counterThird.includes('4/4')) {
    throw new Error(`Expected search counter to advance to 4/4 after flipping, saw: ${counterThird}`)
  }
  await window.waitForFunction(() => {
    const marks = Array.from(document.querySelectorAll('mark[data-search-hit-index]'))
    return marks.some((mark) => {
      if (mark.getAttribute('data-search-active') !== 'true' || Number(mark.getAttribute('data-search-hit-index')) !== 3) return false
      const rect = mark.getBoundingClientRect()
      const viewport = mark.closest('[data-reader-page-viewport="true"]')
      const viewportRect = viewport?.getBoundingClientRect()
      return !!viewportRect
        && rect.width > 0
        && rect.height > 0
        && rect.right <= viewportRect.right
        && rect.left >= viewportRect.left
        && rect.bottom <= viewportRect.bottom
        && rect.top >= viewportRect.top
    })
  }, null, { timeout: 2000 }).catch(() => {})
  const afterThirdState = await getVisibleSearchState()
  if (afterThirdState.activeCount !== 1 || afterThirdState.activeIndex !== 3) {
    const all = await window.evaluate(() => Array.from(document.querySelectorAll('mark[data-search-hit-index]')).map((mark) => {
      const rect = mark.getBoundingClientRect()
      const page = mark.closest('[data-reader-page="true"]')
      const viewport = mark.closest('[data-reader-page-viewport="true"]')
      const viewportRect = viewport?.getBoundingClientRect()
      return {
        index: Number(mark.getAttribute('data-search-hit-index')),
        active: mark.getAttribute('data-search-active') === 'true',
        leaf: Number(page?.getAttribute('data-reader-leaf-index') || 0),
        rect: { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom },
        viewport: viewportRect ? { top: viewportRect.top, left: viewportRect.left, right: viewportRect.right, bottom: viewportRect.bottom } : null,
        text: mark.textContent,
      }
    }))
    const visibleText = await getVisibleSections()
    throw new Error(`Expected fourth hit to stay visible and active after page flip, saw ${JSON.stringify(afterThirdState)}; all=${JSON.stringify(all)}; visible=${visibleText.join(' | ')}`)
  }
}

async function verifyReaderSearchHasSingleActiveHighlight(window, userDataDir) {
  const samplePath = path.join(userDataDir, 'zz-smoke-many-active.txt')
  fs.writeFileSync(
    samplePath,
    [
      'zz-smoke-many-active',
      '',
      '\u7b2c\u4e00\u7ae0',
      Array.from({ length: 36 }, (_, index) => `\u7b2c ${index + 1} \u884c \u65e5\u672c \u7ef4\u65b0 \u4e0e \u65e5\u672c \u653f\u6cbb\u7ecf\u6d4e\u53d8\u8fc1\u3002`).join('\n'),
    ].join('\n'),
    'utf8'
  )

  const importResults = await importFilesWithCapabilities(window, [samplePath])
  if (!Array.isArray(importResults) || !importResults[0]?.success) {
    throw new Error('Expected many-active smoke import to succeed')
  }

  const docId = importResults[0].id
  await window.evaluate(async (id) => {
    const session = await window.api.getDocumentSearchHits(id, '\u65e5\u672c', { limit: 5000 })
    window.__smokeOpenDocument?.({
      docId: id,
      pageIndex: 0,
      keyword: '\u65e5\u672c',
      searchSession: session,
      locator: session.hits?.[0]?.locator
    })
  }, docId)

  await window.waitForFunction(() => {
    const text = document.querySelector('main')?.textContent || ''
    const activeTabTitle = document.querySelector('[data-app-tab-active="true"]')?.textContent || ''
    return (activeTabTitle.includes('zz-smoke-many-active') || text.includes('zz-smoke-many-active')) && /1\s*\/\s*\d+/.test(text)
  }, null, { timeout: 5000 })

  const nextSearchButton = window.locator('button[data-reader-search-next="true"]').first()
  const getActiveState = async () => window.evaluate(() => ({
    activeCount: document.querySelectorAll('mark[data-search-active="true"]').length,
    counter: document.querySelector('[data-reader-search-counter="true"]')?.textContent || '',
    marks: Array.from(document.querySelectorAll('mark[data-search-hit-index]')).slice(0, 30).map((node) => ({
      index: node.getAttribute('data-search-hit-index'),
      active: node.getAttribute('data-search-active'),
      text: node.textContent,
    })),
    main: (document.querySelector('main')?.textContent || '').slice(0, 800),
  }))
  let state = await getActiveState()
  for (let attempt = 0; attempt < 8 && state.activeCount === 0; attempt += 1) {
    await nextSearchButton.click()
    await window.waitForTimeout(180)
    state = await getActiveState()
  }
  if (state.activeCount !== 1) {
    const debug = await window.evaluate(() => ({
      counter: document.querySelector('[data-reader-search-counter="true"]')?.textContent || '',
      marks: Array.from(document.querySelectorAll('mark[data-search-hit-index]')).slice(0, 20).map((node) => ({
        index: node.getAttribute('data-search-hit-index'),
        active: node.getAttribute('data-search-active'),
        text: node.textContent,
      })),
      main: (document.querySelector('main')?.textContent || '').slice(0, 800),
    }))
    throw new Error(`Expected exactly one active highlight after entering body hits, saw ${state.activeCount}; debug=${JSON.stringify(debug)}`)
  }
  await assertActiveSearchHighlightIsVisuallyDistinct(window, 'many active initial')

  for (let i = 0; i < 6; i += 1) {
    await nextSearchButton.click()
    await window.waitForTimeout(120)
    state = await getActiveState()
    if (state.activeCount !== 1) {
      const activeIndexes = await window.evaluate(() => Array.from(document.querySelectorAll('mark[data-search-active="true"]')).map((node) => node.getAttribute('data-search-hit-index')))
      throw new Error(`Expected exactly one active highlight after next ${i + 1}, saw ${state.activeCount}: ${activeIndexes.join(',')}; counter=${state.counter}`)
    }
    await assertActiveSearchHighlightIsVisuallyDistinct(window, `many active next ${i + 1}`)
  }

  const parseCounter = (counter) => {
    const match = String(counter || '').match(/(\d+)\s*\/\s*(\d+)/)
    return match ? { index: Number(match[1]), total: Number(match[2]) } : { index: 0, total: 0 }
  }
  const beforeRapid = parseCounter(state.counter)
  const rapidClicks = 12
  await window.evaluate(async (clickCount) => {
    const button = document.querySelector('button[data-reader-search-next="true"]')
    if (!(button instanceof HTMLButtonElement)) throw new Error('Missing reader search next button')
    for (let index = 0; index < clickCount; index += 1) {
      button.click()
      await new Promise((resolve) => window.setTimeout(resolve, 16))
    }
  }, rapidClicks)
  const expectedRapidIndex = ((beforeRapid.index - 1 + rapidClicks) % beforeRapid.total) + 1
  await window.waitForFunction((expected) => {
    const counter = document.querySelector('[data-reader-search-counter="true"]')?.textContent || ''
    const match = counter.match(/(\d+)\s*\/\s*(\d+)/)
    const activeMarks = document.querySelectorAll('mark[data-search-active="true"]')
    return !!match && Number(match[1]) === expected && activeMarks.length === 1
  }, expectedRapidIndex, { timeout: 4000 }).catch(async (error) => {
    const debug = await getActiveState()
    throw new Error(`Expected rapid search-next clicks to reach ${expectedRapidIndex} from ${JSON.stringify(beforeRapid)}, saw ${JSON.stringify(debug)}; ${error.message}`)
  })
  state = await getActiveState()
  if (parseCounter(state.counter).index !== expectedRapidIndex || state.activeCount !== 1) {
    throw new Error(`Expected rapid search-next clicks to coalesce at ${expectedRapidIndex}, saw ${JSON.stringify(state)}`)
  }
  await assertActiveSearchHighlightIsVisuallyDistinct(window, 'many active rapid next')
}

async function verifyReaderSearchKeepsActiveVisibleAcrossManyPageFlips(window, userDataDir) {
  const samplePath = path.join(userDataDir, 'zz-smoke-page-flip-search.txt')
  const filler = Array.from({ length: 26 }, (_, index) => `第 ${index + 1} 行普通正文，模拟真实电子书阅读模式中的长段落排版。`).join('\n')
  const section = (title, hitLines) => [
    title,
    filler,
    ...hitLines,
    filler,
  ].join('\n')
  fs.writeFileSync(
    samplePath,
    [
      'zz-smoke-page-flip-search',
      '',
      section('第一章 长章节一', [
        '第一章第一处 日本 维新 政治。',
        '第一章第二处 日本 经济。',
        '第一章第三处 日本 社会。',
        '第一章第四处 日本 文化。',
      ]),
      '',
      section('第二章 长章节二', [
        '第二章第一处 日本 维新。',
        '第二章第二处 日本 制度。',
        '第二章第三处 日本 思想。',
        '第二章第四处 日本 教育。',
      ]),
      '',
      section('第三章 长章节三', [
        '第三章第一处 日本 政策。',
        '第三章第二处 日本 民众。',
        '第三章第三处 日本 国家。',
        '第三章第四处 日本 史料。',
      ]),
    ].join('\n'),
    'utf8'
  )

  const importResults = await importFilesWithCapabilities(window, [samplePath])
  if (!Array.isArray(importResults) || !importResults[0]?.success) {
    throw new Error('Expected page-flip search smoke import to succeed')
  }

  const docId = importResults[0].id
  await window.evaluate(async (id) => {
    const session = await window.api.getDocumentSearchHits(id, '\u65e5\u672c', { limit: 5000 })
    window.__smokeOpenDocument?.({
      docId: id,
      pageIndex: 0,
      keyword: '\u65e5\u672c',
      searchSession: session,
      locator: session.hits?.[0]?.locator
    })
  }, docId)

  await window.waitForFunction(() => {
    const text = document.querySelector('main')?.textContent || ''
    const activeTabTitle = document.querySelector('[data-app-tab-active="true"]')?.textContent || ''
    return (activeTabTitle.includes('zz-smoke-page-flip-search') || text.includes('zz-smoke-page-flip-search')) && /1\s*\/\s*\d+/.test(text)
  }, null, { timeout: 5000 })

  const nextSearchButton = window.locator('button[data-reader-search-next="true"]').first()
  const assertActiveVisible = async (label) => {
    await window.waitForFunction(() => {
      const active = document.querySelector('mark[data-search-active="true"]')
      if (!active) return false
      const activeMarks = document.querySelectorAll('mark[data-search-active="true"]')
      if (activeMarks.length !== 1) return false
      const viewport = active.closest('[data-reader-page-viewport="true"]')
      const page = active.closest('[data-reader-page="true"]')
      const rect = active.getBoundingClientRect()
      const viewportRect = (viewport || page)?.getBoundingClientRect()
      return !!viewportRect
        && rect.width > 0
        && rect.height > 0
        && rect.right <= viewportRect.right
        && rect.left >= viewportRect.left
        && rect.bottom <= viewportRect.bottom
        && rect.top >= viewportRect.top
    }, null, { timeout: 2500 }).catch(async (error) => {
      const debug = await window.evaluate((debugLabel) => {
        const activeMarks = Array.from(document.querySelectorAll('mark[data-search-active="true"]'))
        const allMarks = Array.from(document.querySelectorAll('mark[data-search-hit-index]')).map((mark) => {
          const rect = mark.getBoundingClientRect()
          const viewport = mark.closest('[data-reader-page-viewport="true"]')
          const viewportRect = viewport?.getBoundingClientRect()
          const page = mark.closest('[data-reader-page="true"]')
          const content = mark.closest('[data-reader-content="true"]')
          const contentRect = content?.getBoundingClientRect()
          return {
            index: mark.getAttribute('data-search-hit-index'),
            active: mark.getAttribute('data-search-active') === 'true',
            leaf: page?.getAttribute('data-reader-leaf-index'),
            text: mark.textContent,
            rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height },
            viewport: viewportRect ? { left: viewportRect.left, right: viewportRect.right, top: viewportRect.top, bottom: viewportRect.bottom } : null,
            content: content && contentRect ? { left: contentRect.left, width: contentRect.width, scrollWidth: content.scrollWidth, transform: content.style.transform } : null,
          }
        })
        const node = document.querySelector('[data-search-navigation-epoch]')
        return {
          label: String(debugLabel),
          counter: document.querySelector('[data-reader-search-counter="true"]')?.textContent || '',
          activeCount: activeMarks.length,
          activeIndexes: activeMarks.map((mark) => mark.getAttribute('data-search-hit-index')),
          readerState: node ? {
            epoch: node.getAttribute('data-search-navigation-epoch'),
            section: node.getAttribute('data-reader-active-section'),
            columnIndex: node.getAttribute('data-reader-column-index'),
            columnCount: node.getAttribute('data-reader-column-count'),
            currentLeaf: node.getAttribute('data-reader-current-leaf'),
          } : null,
          marks: allMarks,
          visibleText: Array.from(document.querySelectorAll('[data-reader-page="true"]')).map((page) => (page.textContent || '').slice(0, 220)),
        }
      }, label)
      throw new Error(`Expected active search mark to be visible at ${label}; debug=${JSON.stringify(debug)}; ${error.message}`)
    })

  }

  await assertActiveVisible('initial')
  const navigationLatencies = []
  const highlightLatencies = []
  for (let step = 1; step <= 30; step += 1) {
    const previousEpoch = await window.locator('[data-search-navigation-epoch]').first().getAttribute('data-search-navigation-epoch').then((value) => Number(value || 0)).catch(() => 0)
    const navigationStartedAt = Date.now()
    const highlightLatency = await window.evaluate(() => new Promise((resolve, reject) => {
      const button = document.querySelector('button[data-reader-search-next="true"]')
      const root = document.querySelector('[data-reader-scroll="true"]')
      const before = root?.querySelector('mark[data-search-active="true"]')?.getAttribute('data-search-hit-index') || ''
      if (!(button instanceof HTMLButtonElement) || !root) {
        reject(new Error('Missing reader search controls for latency measurement'))
        return
      }
      const startedAt = performance.now()
      const timeout = window.setTimeout(() => {
        observer.disconnect()
        reject(new Error('Reader search highlight did not change within 2 seconds'))
      }, 2000)
      const observer = new MutationObserver(() => {
        const after = root.querySelector('mark[data-search-active="true"]')?.getAttribute('data-search-hit-index') || ''
        if (!after || after === before) return
        window.clearTimeout(timeout)
        observer.disconnect()
        resolve(performance.now() - startedAt)
      })
      observer.observe(root, { attributes: true, childList: true, subtree: true, attributeFilter: ['data-search-active'] })
      button.click()
    }))
    highlightLatencies.push(Number(highlightLatency))
    await window.waitForFunction((previous) => {
      const node = document.querySelector('[data-search-navigation-epoch]')
      return Number(node?.getAttribute('data-search-navigation-epoch') || 0) > previous
    }, previousEpoch, { timeout: 2000 })
    await assertActiveVisible(`step ${step}`)
    navigationLatencies.push(Date.now() - navigationStartedAt)
  }
  const sortedLatencies = [...navigationLatencies].sort((left, right) => left - right)
  const p95Latency = sortedLatencies[Math.max(0, Math.ceil(sortedLatencies.length * 0.95) - 1)] || 0
  const maxLatency = sortedLatencies[sortedLatencies.length - 1] || 0
  const sortedHighlightLatencies = [...highlightLatencies].sort((left, right) => left - right)
  const p95HighlightLatency = sortedHighlightLatencies[Math.max(0, Math.ceil(sortedHighlightLatencies.length * 0.95) - 1)] || 0
  const maxHighlightLatency = sortedHighlightLatencies[sortedHighlightLatencies.length - 1] || 0
  console.log(`[smoke] Reader search navigation latency: visible p95=${p95HighlightLatency.toFixed(1)}ms max=${maxHighlightLatency.toFixed(1)}ms; harness p95=${p95Latency}ms max=${maxLatency}ms`)
  if (p95HighlightLatency > 50) {
    throw new Error(`Expected visible reader search highlight p95 latency <= 50ms, saw ${p95HighlightLatency.toFixed(1)}ms (max ${maxHighlightLatency.toFixed(1)}ms)`)
  }
  if (p95Latency > 350) {
    throw new Error(`Expected reader previous/next search p95 latency <= 350ms, saw ${p95Latency}ms (max ${maxLatency}ms)`)
  }
}

async function verifyReaderSearchSyncsAfterManualPageFlip(window, userDataDir) {
  const samplePath = path.join(userDataDir, 'zz-smoke-manual-page-sync.txt')
  const filler = Array.from(
    { length: 30 },
    (_, index) => `\u666e\u901a\u6bb5\u843d ${index + 1}\uff0c\u7528\u6765\u6491\u5f00\u9605\u8bfb\u6392\u7248\u7684\u957f\u6587\u672c\u3002`
  ).join('\n')
  const section = (title, first, second) => [
    title,
    filler,
    `${first} \u65e5\u672c`,
    filler,
    `${second} \u65e5\u672c`,
    filler,
  ].join('\n')
  fs.writeFileSync(
    samplePath,
    [
      'zz-smoke-manual-page-sync',
      '',
      section('\u7b2c\u4e00\u8282', '\u7b2c\u4e00\u8282\u7b2c\u4e00\u5904', '\u7b2c\u4e00\u8282\u7b2c\u4e8c\u5904'),
      '',
      section('\u7b2c\u4e8c\u8282', '\u7b2c\u4e8c\u8282\u7b2c\u4e00\u5904', '\u7b2c\u4e8c\u8282\u7b2c\u4e8c\u5904'),
      '',
      section('\u7b2c\u4e09\u8282', '\u7b2c\u4e09\u8282\u7b2c\u4e00\u5904', '\u7b2c\u4e09\u8282\u7b2c\u4e8c\u5904'),
      '',
      section('\u7b2c\u56db\u8282', '\u7b2c\u56db\u8282\u7b2c\u4e00\u5904', '\u7b2c\u56db\u8282\u7b2c\u4e8c\u5904'),
    ].join('\n'),
    'utf8'
  )

  const importResults = await importFilesWithCapabilities(window, [samplePath])
  if (!Array.isArray(importResults) || !importResults[0]?.success) {
    throw new Error('Expected manual-page-sync smoke import to succeed')
  }

  const docId = importResults[0].id
  await window.evaluate(async (id) => {
    await window.api.saveReaderState(id, {
      location_key: 'page:1',
      progress: 0,
      view_mode: 'spread',
      font_size: 17,
      line_height: 1.8,
      theme: 'paper'
    })
    const session = await window.api.getDocumentSearchHits(id, '\u65e5\u672c', { limit: 5000 })
    window.__smokeOpenDocument?.({
      docId: id,
      pageIndex: 0,
      keyword: '\u65e5\u672c',
      searchSession: session,
      locator: session.hits?.[0]?.locator
    })
  }, docId)

  await window.waitForFunction(() => {
    const text = document.querySelector('main')?.textContent || ''
    const activeTabTitle = document.querySelector('[data-app-tab-active="true"]')?.textContent || ''
    return (activeTabTitle.includes('zz-smoke-manual-page-sync') || text.includes('zz-smoke-manual-page-sync')) && /1\s*\/\s*\d+/.test(text)
  }, null, { timeout: 5000 })

  const pageNextButton = window.locator('button[data-reader-page-next="true"]').first()
  const nextSearchButton = window.locator('button[data-reader-search-next="true"]').first()
  const getSearchState = async () => window.evaluate(() => {
    const visibleMarks = Array.from(document.querySelectorAll('mark[data-search-hit-index]'))
      .map((mark) => {
        const viewport = mark.closest('[data-reader-page-viewport="true"]')
        const page = mark.closest('[data-reader-page="true"]')
        if (!viewport || !page) return null
        const rect = mark.getBoundingClientRect()
        const viewportRect = viewport.getBoundingClientRect()
        const visible = rect.width > 0
          && rect.height > 0
        && rect.right <= viewportRect.right
        && rect.left >= viewportRect.left
        && rect.bottom <= viewportRect.bottom
        && rect.top >= viewportRect.top
        if (!visible) return null
        return {
          index: Number(mark.getAttribute('data-search-hit-index')),
          active: mark.getAttribute('data-search-active') === 'true',
          leaf: Number(page.getAttribute('data-reader-leaf-index') || 0),
          top: rect.top,
          left: rect.left,
          text: mark.textContent || '',
        }
      })
      .filter(Boolean)
      .sort((left, right) => left.leaf - right.leaf || left.top - right.top || left.left - right.left)
    return {
      counter: document.querySelector('[data-reader-search-counter="true"]')?.textContent || '',
      totalActiveCount: document.querySelectorAll('mark[data-search-active="true"]').length,
      activeCount: visibleMarks.filter((item) => item.active).length,
      activeIndex: visibleMarks.find((item) => item.active)?.index ?? -1,
      visibleIndexes: visibleMarks.map((item) => item.index),
      currentLeaf: Number(document.querySelector('[data-reader-current-leaf]')?.getAttribute('data-reader-current-leaf') || 0),
      visibleText: Array.from(document.querySelectorAll('[data-reader-page="true"]')).map((page) => (page.textContent || '').slice(0, 220)),
    }
  })

  const initial = await getSearchState()
  for (let step = 1; step <= 4; step += 1) {
    const before = await getSearchState()
    await pageNextButton.click()
    await window.waitForFunction((previousLeaf) => {
      const node = document.querySelector('[data-reader-current-leaf]')
      return Number(node?.getAttribute('data-reader-current-leaf') || 0) > previousLeaf
    }, before.currentLeaf, { timeout: 2500 }).catch(() => {})
    await window.waitForTimeout(1100)
    const state = await getSearchState()
    if (!state.counter.includes(initial.counter.trim())) {
      throw new Error(`Expected manual page flip to keep active search index unchanged at step ${step}, saw ${JSON.stringify(state)} from ${JSON.stringify(initial)}`)
    }
  }

  const beforeNext = await getSearchState()
  const previousEpoch = await window.locator('[data-search-navigation-epoch]').first().getAttribute('data-search-navigation-epoch').then((value) => Number(value || 0)).catch(() => 0)
  await nextSearchButton.click()
  await window.waitForFunction((previous) => {
    const node = document.querySelector('[data-search-navigation-epoch]')
    return Number(node?.getAttribute('data-search-navigation-epoch') || 0) > previous
  }, previousEpoch, { timeout: 2000 })
  const afterNext = await getSearchState()
  if (!afterNext.counter.includes('2/')) {
    throw new Error(`Expected search next after manual page flip to continue from original active index, saw before=${JSON.stringify(beforeNext)} after=${JSON.stringify(afterNext)}`)
  }

  for (let step = 0; step < 2; step += 1) {
    const before = await getSearchState()
    await pageNextButton.click()
    await window.waitForFunction((previousLeaf) => {
      const node = document.querySelector('[data-reader-current-leaf]')
      return Number(node?.getAttribute('data-reader-current-leaf') || 0) > previousLeaf
    }, before.currentLeaf, { timeout: 2500 }).catch(() => {})
  }
  const beforeDraft = await getSearchState()
  const searchInput = window.locator('input[data-reader-search-input="true"]').first()
  await searchInput.fill('\u666e\u901a\u6bb5\u843d')
  await window.waitForTimeout(350)
  const afterDraft = await getSearchState()
  if (afterDraft.currentLeaf !== beforeDraft.currentLeaf || afterDraft.counter !== beforeDraft.counter) {
    throw new Error(`Expected an uncommitted search draft to keep page and search cursor unchanged, saw before=${JSON.stringify(beforeDraft)} after=${JSON.stringify(afterDraft)}`)
  }
  await searchInput.press('Enter')
  await window.waitForFunction((previousCounter) => {
    const counter = document.querySelector('[data-reader-search-counter="true"]')?.textContent || ''
    return counter !== previousCounter && /\d+\s*\/\s*\d+/.test(counter)
  }, beforeDraft.counter, { timeout: 5000 })
  const afterCommit = await getSearchState()
  if (afterCommit.currentLeaf < beforeDraft.currentLeaf) {
    throw new Error(`Expected committed search to start at the current reading page, saw before=${JSON.stringify(beforeDraft)} after=${JSON.stringify(afterCommit)}`)
  }
}

async function verifyReaderSearchKeepsActiveVisibleInLongSection(window, userDataDir) {
  const samplePath = path.join(userDataDir, 'zz-smoke-long-section-search.txt')
  const paragraphs = []
  for (let i = 1; i <= 180; i += 1) {
    const hit = i % 9 === 0 ? ` \u4f2a\u6ee1\u6d32 \u7b2c ${i} \u5904\u547d\u4e2d` : ''
    paragraphs.push(`\u957f\u7ae0\u8282\u6bb5\u843d ${i}\uff0c\u8fd9\u91cc\u662f\u6a21\u62df\u771f\u5b9e\u8bba\u6587\u7684\u8fde\u7eed\u6392\u7248\u6587\u672c\uff0c\u7528\u6765\u8ba9 CSS \u5206\u680f\u8de8\u8fc7\u591a\u4e2a\u9605\u8bfb\u9875\u3002${hit}\u672c\u6bb5\u7ee7\u7eed\u8865\u5145\u6587\u5b57\uff0c\u907f\u514d\u547d\u4e2d\u90fd\u6324\u5728\u540c\u4e00\u5217\u3002`)
  }
  fs.writeFileSync(
    samplePath,
    [
      'zz-smoke-long-section-search',
      '',
      '\u7b2c 1 \u8282',
      ...paragraphs,
    ].join('\n\n'),
    'utf8'
  )

  const importResults = await importFilesWithCapabilities(window, [samplePath])
  if (!Array.isArray(importResults) || !importResults[0]?.success) {
    throw new Error('Expected long-section search smoke import to succeed')
  }

  const docId = importResults[0].id
  await window.evaluate(async (id) => {
    await window.api.saveReaderState(id, {
      location_key: 'page:1',
      progress: 0,
      view_mode: 'spread',
      font_size: 17,
      line_height: 1.8,
      theme: 'paper'
    })
    const session = await window.api.getDocumentSearchHits(id, '\u4f2a\u6ee1\u6d32', { limit: 5000 })
    window.__smokeOpenDocument?.({
      docId: id,
      pageIndex: 0,
      keyword: '\u4f2a\u6ee1\u6d32',
      searchSession: session,
      locator: session.hits?.[0]?.locator
    })
  }, docId)

  await window.waitForFunction(() => {
    const text = document.querySelector('main')?.textContent || ''
    const activeTabTitle = document.querySelector('[data-app-tab-active="true"]')?.textContent || ''
    return (activeTabTitle.includes('zz-smoke-long-section-search') || text.includes('zz-smoke-long-section-search')) && /1\s*\/\s*\d+/.test(text)
  }, null, { timeout: 5000 })

  const nextSearchButton = window.locator('button[data-reader-search-next="true"]').first()
  const getState = async () => window.evaluate(() => {
    const active = document.querySelector('mark[data-search-active="true"]')
    const activeMarks = Array.from(document.querySelectorAll('mark[data-search-active="true"]'))
    const viewport = active?.closest('[data-reader-page-viewport="true"]')
    const viewportRect = viewport?.getBoundingClientRect()
    const activeRects = active ? Array.from(active.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0 && rect.width < 180) : []
    const rect = activeRects[0] || active?.getBoundingClientRect()
    const activeVisible = !!viewportRect && activeRects.some((item) => (
      item.right <= viewportRect.right
      && item.left >= viewportRect.left
      && item.bottom <= viewportRect.bottom
      && item.top >= viewportRect.top
    ))
    const page = activeRects.length > 0
      ? active?.closest('[data-reader-page="true"]')
      : active?.closest('[data-reader-page="true"]')
    const counter = document.querySelector('[data-reader-search-counter="true"]')?.textContent || ''
    return {
      counter,
      activeCount: activeMarks.length,
      activeIndex: Number(active?.getAttribute('data-search-hit-index') || -1),
      activeVisible,
      leaf: Number(page?.getAttribute('data-reader-leaf-index') || -1),
      rect: rect ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height } : null,
      viewport: viewportRect ? { left: viewportRect.left, right: viewportRect.right, top: viewportRect.top, bottom: viewportRect.bottom } : null,
      readerState: {
        section: document.querySelector('[data-reader-active-section]')?.getAttribute('data-reader-active-section') || '',
        column: document.querySelector('[data-reader-column-index]')?.getAttribute('data-reader-column-index') || '',
        currentLeaf: document.querySelector('[data-reader-current-leaf]')?.getAttribute('data-reader-current-leaf') || '',
      },
      visibleText: Array.from(document.querySelectorAll('[data-reader-page="true"]')).map((node) => (node.textContent || '').slice(0, 180)),
    }
  })

  let previousIndex = -1
  for (let step = 0; step < 20; step += 1) {
    if (step > 0) {
      const previousEpoch = await window.locator('[data-search-navigation-epoch]').first().getAttribute('data-search-navigation-epoch').then((value) => Number(value || 0)).catch(() => 0)
      await nextSearchButton.click()
      await window.waitForFunction((previous) => {
        const node = document.querySelector('[data-search-navigation-epoch]')
        return Number(node?.getAttribute('data-search-navigation-epoch') || 0) > previous
      }, previousEpoch, { timeout: 2000 })
    }
      await window.waitForFunction(() => {
        const active = document.querySelector('mark[data-search-active="true"]')
        const viewport = active?.closest('[data-reader-page-viewport="true"]')
        const viewportRect = viewport?.getBoundingClientRect()
      const rects = active ? Array.from(active.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0 && rect.width < 180) : []
      return !!viewportRect
        && document.querySelectorAll('mark[data-search-active="true"]').length === 1
        && rects.some((rect) => (
          rect.right <= viewportRect.right
          && rect.left >= viewportRect.left
          && rect.bottom <= viewportRect.bottom
          && rect.top >= viewportRect.top
        ))
    }, null, { timeout: 3000 }).catch(() => {})
    const state = await getState()
    if (state.activeCount !== 1 || !state.activeVisible) {
      throw new Error(`Expected long-section active hit to be visible at step ${step}, saw ${JSON.stringify(state)}`)
    }
    if (state.activeIndex <= previousIndex) {
      throw new Error(`Expected long-section search index to increase at step ${step}, saw ${JSON.stringify(state)} after ${previousIndex}`)
    }
    if (!state.counter.includes(`${state.activeIndex + 1}/`)) {
      throw new Error(`Expected counter to match active index at step ${step}, saw ${JSON.stringify(state)}`)
    }
    previousIndex = state.activeIndex
  }
}

async function verifyReaderSearchRendersHtmlTables(window, userDataDir) {
  const samplePath = path.join(userDataDir, 'zz-smoke-html-table.txt')
  fs.writeFileSync(
    samplePath,
    [
      'zz-smoke-html-table',
      '',
      '第一节',
      '表格前文本 日本。',
      '<table><tr><td>课程</td><td>日语</td></tr><tr><td>时数</td><td>六</td></tr></table>',
      '表格后文本 日语。',
    ].join('\n'),
    'utf8'
  )

  const importResults = await importFilesWithCapabilities(window, [samplePath])
  if (!Array.isArray(importResults) || !importResults[0]?.success) {
    throw new Error('Expected html-table smoke import to succeed')
  }

  const docId = importResults[0].id
  await window.evaluate(async (id) => {
    const session = await window.api.getDocumentSearchHits(id, '日语', { limit: 5000 })
    window.__smokeOpenDocument?.({
      docId: id,
      pageIndex: 0,
      keyword: '日语',
      searchSession: session,
      locator: session.hits?.[0]?.locator
    })
  }, docId)

  await window.waitForFunction(() => {
    const text = document.querySelector('main')?.textContent || ''
    const activeTabTitle = document.querySelector('[data-app-tab-active="true"]')?.textContent || ''
    return (activeTabTitle.includes('zz-smoke-html-table') || text.includes('zz-smoke-html-table')) && text.includes('日语')
  }, null, { timeout: 5000 })

  const state = await window.evaluate(() => {
    const mainText = document.querySelector('main')?.textContent || ''
    const tableCount = document.querySelectorAll('[data-reader-content="true"] table').length
    const active = document.querySelector('mark[data-search-active="true"]')
    const viewport = active?.closest('[data-reader-page-viewport="true"]')
    const rect = active?.getBoundingClientRect()
    const viewportRect = viewport?.getBoundingClientRect()
    const activeVisible = !!rect && !!viewportRect
      && rect.width > 0
      && rect.height > 0
      && rect.right <= viewportRect.right
      && rect.left >= viewportRect.left
      && rect.bottom <= viewportRect.bottom
      && rect.top >= viewportRect.top
    return {
      rawHtmlVisible: mainText.includes('<table') || mainText.includes('<td'),
      tableCount,
      activeCount: document.querySelectorAll('mark[data-search-active="true"]').length,
      activeVisible,
    }
  })
  if (state.rawHtmlVisible || state.activeCount !== 1 || !state.activeVisible) {
    throw new Error(`Expected search mode to hide raw HTML and keep one visible active highlight, saw ${JSON.stringify(state)}`)
  }

  await window.locator('input[placeholder="搜索文内关键词"]').first().fill('')
  await window.waitForTimeout(500)
  const restoredState = await window.evaluate(() => {
    const mainText = document.querySelector('main')?.textContent || ''
    return {
      rawHtmlVisible: mainText.includes('<table') || mainText.includes('<td'),
      tableCount: document.querySelectorAll('[data-reader-content="true"] table').length,
      activeCount: document.querySelectorAll('mark[data-search-active="true"]').length,
    }
  })
  if (restoredState.rawHtmlVisible || restoredState.tableCount < 1 || restoredState.activeCount !== 0) {
    throw new Error(`Expected normal reading mode to restore rendered HTML table after clearing search, saw ${JSON.stringify(restoredState)}`)
  }
}

async function verifyReaderNormalizesInlineMathMarkers(window, userDataDir) {
  const samplePath = path.join(userDataDir, 'zz-smoke-inline-math.txt')
  fs.writeFileSync(
    samplePath,
    [
      'zz-smoke-inline-math',
      '',
      '第一节',
      '脚注编号 $ ^{3} $ 与作者标记 $ ^{\\dagger} $ 应该显示成上标。',
      '化学式 H _{2} O 和希腊字母 $ ^{\\alpha} $ 也不应该显示源码。',
    ].join('\n'),
    'utf8'
  )

  const importResults = await importFilesWithCapabilities(window, [samplePath])
  if (!Array.isArray(importResults) || !importResults[0]?.success) {
    throw new Error('Expected inline-math smoke import to succeed')
  }

  const docId = importResults[0].id
  await window.evaluate(async (id) => {
    const session = await window.api.getDocumentSearchHits(id, '脚注编号', { limit: 5000 })
    window.__smokeOpenDocument?.({
      docId: id,
      pageIndex: 1,
      keyword: '脚注编号',
      searchSession: session,
      locator: session.hits?.[0]?.locator
    })
  }, docId)

  await window.waitForFunction(() => {
    const text = document.querySelector('main')?.textContent || ''
    return text.includes('脚注编号') && text.includes('应该显示成上标')
  }, null, { timeout: 5000 })

  const state = await window.evaluate(() => {
    const main = document.querySelector('main')
    const text = main?.textContent || ''
    return {
      hasRawDollarCaret: text.includes('$ ^') || text.includes('\\dagger') || text.includes('_{2}'),
      activeCount: document.querySelectorAll('mark[data-search-active="true"]').length,
      text,
    }
  })
  if (state.hasRawDollarCaret || state.activeCount !== 1) {
    throw new Error(`Expected search mode to hide raw inline math markers and keep one active highlight, saw ${JSON.stringify(state)}`)
  }

  await window.locator('input[placeholder="搜索文内关键词"]').first().fill('')
  await window.waitForTimeout(500)
  const restoredState = await window.evaluate(() => {
    const main = document.querySelector('main')
    const text = main?.textContent || ''
    return {
      hasRawDollarCaret: text.includes('$ ^') || text.includes('\\dagger') || text.includes('_{2}'),
      hasSupThree: Array.from(main?.querySelectorAll('sup') || []).some((node) => (node.textContent || '').trim() === '3'),
      hasSupDagger: Array.from(main?.querySelectorAll('sup') || []).some((node) => (node.textContent || '').trim() === '†'),
      hasSubTwo: Array.from(main?.querySelectorAll('sub') || []).some((node) => (node.textContent || '').trim() === '2'),
      activeCount: document.querySelectorAll('mark[data-search-active="true"]').length,
      text,
    }
  })
  if (restoredState.hasRawDollarCaret || !restoredState.hasSupThree || !restoredState.hasSupDagger || !restoredState.hasSubTwo || restoredState.activeCount !== 0) {
    throw new Error(`Expected normal reading mode to restore sup/sub inline math after clearing search, saw ${JSON.stringify(restoredState)}`)
  }
}

async function run() {
  const userDataDir = path.join(os.tmpdir(), 'gujismart-smoke-' + Date.now())
  const smokeProfileDir = path.join(os.tmpdir(), 'gujismart-smoke-profile-' + Date.now())
  const smokeDbDir = path.join(os.tmpdir(), 'gujismart-smoke-db-' + Date.now())
  const app = await electron.launch({
    args: [
      '--disable-gpu',
      '--user-data-dir=' + userDataDir,
      '.'
    ],
    cwd: process.cwd(),
    env: {
      ...process.env,
      GUJISMART_SMOKE: '1',
      GUJISMART_DATA_DIR: smokeDbDir,
      GUJISMART_PROFILE_DIR: smokeProfileDir
    }
  })

  try {
    const window = await app.firstWindow({ timeout: 20000 })
    await window.waitForLoadState('domcontentloaded')
    await window.waitForTimeout(1500)

    const title = await window.title()
    expectContains(title, '\u6587\u732e\u7ba1\u7406', 'window title')
    await verifyMainText(window, LABELS.welcomeTitle)

    await clickMenu(window, LABELS.research)
    await verifyMainText(window, '\u7814\u7a76\u5de5\u4f5c\u53f0')

    await clickMenu(window, LABELS.search)
    await verifyMainText(window, '\u6587\u732e\u68c0\u7d22')

    await clickMenu(window, LABELS.citation)
    await verifyMainText(window, '\u5f15\u7528\u683c\u5f0f\u7ba1\u7406')
    await verifyCitationStyles(window)

    await clickMenu(window, LABELS.tags)
    await verifyMainText(window, '\u6807\u7b7e\u7ba1\u7406\u4e2d\u5fc3')

    await clickMenu(window, LABELS.dashboard)
    await verifyMainText(window, '\u5904\u7406\u961f\u5217')

    await clickMenu(window, LABELS.settings)
    await verifyMainText(window, '\u4fdd\u5b58\u8bbe\u7f6e')

    await verifyLibrarySearchSubmit(window, userDataDir)
    await verifyLibraryIncrementalLoading(window, userDataDir)
    await verifySearchReaderRoundTrip(window, userDataDir)
    await verifySearchDocumentHitDirectory(window, userDataDir)
    await verifyReaderSearchStaysWithinVisibleSpread(window, userDataDir)
    await verifyReaderSearchHasSingleActiveHighlight(window, userDataDir)
    await verifyReaderSearchKeepsActiveVisibleAcrossManyPageFlips(window, userDataDir)
    await verifyReaderSearchSyncsAfterManualPageFlip(window, userDataDir)
    await verifyReaderSearchKeepsActiveVisibleInLongSection(window, userDataDir)
    await verifyReaderSearchRendersHtmlTables(window, userDataDir)
    await verifyReaderNormalizesInlineMathMarkers(window, userDataDir)

    const smokeDbPath = path.join(smokeDbDir, 'db', 'gujismart.db')
    if (!fs.existsSync(smokeDbPath)) {
      throw new Error(`Expected database to be created at ${smokeDbPath}`)
    }

    console.log('Electron smoke test passed.')
  } finally {
    await app.close()
  }
}

run().catch((error) => {
  console.error('Electron smoke test failed.')
  console.error(error)
  process.exit(1)
})
