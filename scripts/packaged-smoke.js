const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const { _electron: electron } = require('playwright')
const packageJson = require('../package.json')

const root = path.resolve(__dirname, '..')
const unpacked = path.resolve(process.env.GUJISMART_UNPACKED_DIR || path.join(root, 'dist', 'win-unpacked'))
let capabilityInputSequence = 0

function assertCondition(condition, message, detail) {
  if (condition) return
  const suffix = detail === undefined ? '' : `: ${JSON.stringify(detail)}`
  throw new Error(`${message}${suffix}`)
}

async function waitForDocumentRemoval(window, docId, attempts = 80, delayMs = 250) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const document = await window.evaluate((id) => window.api.getDocument(id), docId)
    if (document === null) return
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  throw new Error(`Deleted document still exists: ${docId}`)
}

async function importFilesWithCapabilities(window, filePaths) {
  const inputId = `packaged-smoke-capability-input-${++capabilityInputSequence}`
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

async function verifyPackagedSearchExcerptExport(window, smokeRoot) {
  const keyword = 'packaged-export-worker-keyword'
  const sourcePath = path.join(smokeRoot, 'packaged-export-worker.txt')
  fs.writeFileSync(sourcePath, `Packaged export regression. ${keyword} appears in this complete paragraph.\n`, 'utf8')
  const imported = await importFilesWithCapabilities(window, [sourcePath])
  if (!Array.isArray(imported) || !imported[0]?.success || !imported[0]?.id) {
    throw new Error(`Packaged export fixture import failed: ${JSON.stringify(imported)}`)
  }
  const docId = imported[0].id
  await window.evaluate(async ({ id, query }) => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await window.api.querySearchV2(query, { docIds: [id], limit: 20 })
      if (response?.totalHits > 0) return
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    throw new Error('Packaged export fixture did not enter the search index')
  }, { id: docId, query: keyword })
  const preview = await window.evaluate(async ({ id, query }) => (
    window.api.previewSearchExportExcerpts(query, {
      docIds: [id],
      limit: 100,
      maxExportRecords: 100,
      searchEngine: 'fulltext',
      format: 'txt',
    })
  ), { id: docId, query: keyword })
  const previewContainsKeyword = Array.isArray(preview?.previewItems)
    && preview.previewItems.some((item) => String(item?.paragraph || '').includes(keyword))
  if (!previewContainsKeyword || preview.totalHits < 1 || preview.exportableParagraphs < 1) {
    throw new Error(`Packaged search excerpt export returned invalid content: ${JSON.stringify(preview)}`)
  }
  const saved = await window.evaluate(async ({ id, query }) => (
    window.api.saveSearchExcerpts(query, {
      docIds: [id],
      limit: 100,
      maxExportRecords: 100,
      searchEngine: 'fulltext',
    })
  ), { id: docId, query: keyword })
  assertCondition(saved?.savedCount > 0, 'Packaged search excerpt save failed', saved)
  const savedNotes = await window.evaluate((query) => window.api.listResearchNotesPage({ search: query, limit: 20 }), keyword)
  assertCondition(savedNotes?.items?.some((note) => String(note.excerpt || '').includes(keyword)), 'Saved search excerpt is missing from research notes', savedNotes)
  console.log('Packaged full-text search, excerpt preview, and excerpt save passed.')
  return { docId, keyword }
}

async function verifyPackagedStartupAndReadOnlyServices(window) {
  const result = await window.evaluate(async () => {
    const [
      version,
      projects,
      activeProject,
      citationStyles,
      citationTemplates,
      llmProfiles,
      visionProfiles,
      backupStatus,
      startupStorage,
    ] = await Promise.all([
      window.api.getVersion(),
      window.api.listLibraryProjects(),
      window.api.getActiveLibraryProject(),
      window.api.listCitationStyles(),
      window.api.listCitationTemplates(),
      window.api.listLlmProviderProfiles(),
      window.api.listVisionOcrProviderProfiles(),
      window.api.getBackupStatus(),
      window.api.getDatabaseStartupStorageDiagnostics(),
    ])
    return {
      version,
      projects,
      activeProject,
      citationStyles,
      citationTemplates,
      llmProfiles,
      visionProfiles,
      backupStatus,
      startupStorage,
    }
  })
  assertCondition(result.version === packageJson.version, 'Unexpected packaged version', result.version)
  assertCondition(Array.isArray(result.projects) && result.projects.length >= 1, 'Default library project is missing', result.projects)
  assertCondition(result.activeProject?.id, 'Active library project is missing', result.activeProject)
  assertCondition(Array.isArray(result.citationStyles) && result.citationStyles.length > 0, 'Citation styles failed to load')
  assertCondition(Array.isArray(result.citationTemplates) && result.citationTemplates.length > 0, 'Citation templates failed to load')
  assertCondition(result.llmProfiles && typeof result.llmProfiles === 'object', 'LLM profile configuration failed to load')
  assertCondition(result.visionProfiles && typeof result.visionProfiles === 'object', 'Vision OCR profile configuration failed to load')
  assertCondition(result.backupStatus && typeof result.backupStatus.enabled === 'boolean', 'Backup status failed to load')
  assertCondition(result.startupStorage?.databasePath, 'Startup database diagnostics failed to load', result.startupStorage)
  console.log('Packaged startup, configuration, citation, OCR/AI profile, and database bootstrap passed.')
  return { activeProject: result.activeProject }
}

async function verifyPackagedLibraryProjectsFoldersAndTags(window, smokeRoot, originalProject) {
  const primaryKeyword = 'packaged-library-primary-keyword'
  const deleteKeyword = 'packaged-library-delete-keyword'
  const primaryPath = path.join(smokeRoot, 'packaged-library-primary.txt')
  const deletePath = path.join(smokeRoot, 'packaged-library-delete.txt')
  fs.writeFileSync(primaryPath, `Primary packaged workflow fixture. ${primaryKeyword}.\n`, 'utf8')
  fs.writeFileSync(deletePath, `Deletion worker packaged workflow fixture. ${deleteKeyword}.\n`, 'utf8')
  const imported = await importFilesWithCapabilities(window, [primaryPath, deletePath])
  assertCondition(Array.isArray(imported) && imported.length === 2 && imported.every((item) => item?.success && item?.id), 'Packaged multi-file import failed', imported)
  const [primaryDocId, deleteDocId] = imported.map((item) => item.id)

  const libraryResult = await window.evaluate(async ({ primaryId, deleteId, primaryQuery, deleteQuery }) => {
    const primaryPage = await window.api.listDocumentsPage({ search: primaryQuery, limit: 20 })
    const deletePage = await window.api.listDocumentsPage({ search: deleteQuery, limit: 20 })
    const favoriteUpdated = await window.api.toggleFavorite(primaryId, true)
    const readUpdated = await window.api.setReadStatus(primaryId, 'reading')
    const ratingUpdated = await window.api.setRating(primaryId, 4)
    const detail = await window.api.getDocument(primaryId)
    const filters = await window.api.listDocumentFilterOptions()
    return { primaryPage, deletePage, favoriteUpdated, readUpdated, ratingUpdated, detail, filters, deleteId }
  }, { primaryId: primaryDocId, deleteId: deleteDocId, primaryQuery: primaryKeyword, deleteQuery: deleteKeyword })
  assertCondition(libraryResult.primaryPage?.items?.some((doc) => doc.id === primaryDocId), 'Imported document is missing from library search', libraryResult.primaryPage)
  assertCondition(libraryResult.deletePage?.items?.some((doc) => doc.id === deleteDocId), 'Second imported document is missing from library search', libraryResult.deletePage)
  assertCondition(libraryResult.favoriteUpdated && libraryResult.readUpdated && libraryResult.ratingUpdated, 'Document state update failed', libraryResult)
  assertCondition(libraryResult.detail?.is_favorite === 1 && libraryResult.detail?.read_status === 'reading' && Number(libraryResult.detail?.rating) === 4, 'Document state did not persist', libraryResult.detail)
  assertCondition(Array.isArray(libraryResult.filters) && libraryResult.filters.some((doc) => doc.id === primaryDocId), 'Document filter metadata failed to refresh')

  const organization = await window.evaluate(async ({ originalProjectId, primaryId, deleteId }) => {
    const suffix = Date.now().toString(36)
    const targetProject = await window.api.createLibraryProject({ name: `Packaged Project ${suffix}`, activate: false })
    const linked = await window.api.addDocumentsToLibraryProject([primaryId], targetProject.id)
    const copied = await window.api.copyDocumentsToLibraryProject([deleteId], targetProject.id)
    const targetActive = await window.api.setActiveLibraryProject(targetProject.id)
    const targetDocuments = await window.api.listDocumentsPage({ limit: 100 })
    const copiedDocumentId = copied?.documents?.[0]?.copied_document_id || null
    const copiedDetail = copiedDocumentId ? await window.api.getDocument(copiedDocumentId) : null
    const restoredActive = await window.api.setActiveLibraryProject(originalProjectId)

    const parentFolder = await window.api.createFolder({ name: `Packaged Parent ${suffix}` })
    const childFolder = await window.api.createFolder({ name: `Packaged Child ${suffix}`, parent_id: parentFolder?.id || null })
    const folderAdd = childFolder ? await window.api.addDocumentsToFolder([primaryId], childFolder.id, originalProjectId) : null
    const folderDocuments = childFolder ? await window.api.getFolderDocuments(childFolder.id) : []
    const folderContent = childFolder ? await window.api.getFolderContent({ folderId: childFolder.id, limit: 20 }) : null
    const folderOverview = await window.api.getFolderOverview()

    const parentTag = await window.api.createTag({ name: `Packaged Parent Tag ${suffix}`, color: '#8b5e34' })
    const childTag = await window.api.createTag({ name: `Packaged Child Tag ${suffix}`, color: '#a8764f', parent_id: parentTag?.id || null })
    const tagAdd = childTag ? await window.api.addDocumentTags([primaryId], [childTag.id]) : null
    const taggedDetail = await window.api.getDocument(primaryId)
    const taggedPage = childTag ? await window.api.listDocumentsPage({ tagIds: [childTag.id], limit: 20 }) : null
    return {
      targetProject,
      linked,
      copied,
      targetActive,
      targetDocuments,
      copiedDocumentId,
      copiedDetail,
      restoredActive,
      parentFolder,
      childFolder,
      folderAdd,
      folderDocuments,
      folderContent,
      folderOverview,
      parentTag,
      childTag,
      tagAdd,
      taggedDetail,
      taggedPage,
    }
  }, { originalProjectId: originalProject.id, primaryId: primaryDocId, deleteId: deleteDocId })
  assertCondition(organization.targetProject?.id, 'Library project creation failed', organization.targetProject)
  assertCondition(organization.linked?.added === 1, 'Adding a document to another project failed', organization.linked)
  assertCondition(organization.copied?.copied === 1 && organization.copiedDocumentId, 'Copying a document to another project failed', organization.copied)
  assertCondition(organization.targetActive?.id === organization.targetProject.id, 'Project switch failed', organization.targetActive)
  assertCondition(organization.targetDocuments?.items?.some((doc) => doc.id === primaryDocId), 'Linked document is missing from target project', organization.targetDocuments)
  assertCondition(organization.targetDocuments?.items?.some((doc) => doc.id === organization.copiedDocumentId) && organization.copiedDetail, 'Independent copied document is missing from target project', organization.targetDocuments)
  assertCondition(organization.restoredActive?.id === originalProject.id, 'Failed to return to original project', organization.restoredActive)
  assertCondition(organization.parentFolder?.id && organization.childFolder?.parent_id === organization.parentFolder.id, 'Parent/child folder creation failed', organization)
  assertCondition(organization.folderAdd?.count === 1, 'Batch folder assignment failed', organization.folderAdd)
  assertCondition(organization.folderDocuments?.some((doc) => doc.id === primaryDocId), 'Folder document lookup failed', organization.folderDocuments)
  assertCondition(organization.folderContent?.documents?.some((doc) => doc.id === primaryDocId), 'Folder paged content failed', organization.folderContent)
  assertCondition(organization.folderOverview?.folders?.some((folder) => folder.id === organization.childFolder.id), 'Folder overview failed to include child folder')
  assertCondition(organization.parentTag?.id && organization.childTag?.parent_id === organization.parentTag.id, 'Parent/child tag creation failed', organization)
  assertCondition(organization.tagAdd?.count === 1, 'Batch tag assignment failed', organization.tagAdd)
  assertCondition(organization.taggedDetail?.tags?.some((tag) => tag.id === organization.childTag.id), 'Tag relation did not persist', organization.taggedDetail)
  assertCondition(organization.taggedPage?.items?.some((doc) => doc.id === primaryDocId), 'Tag filter failed', organization.taggedPage)
  console.log('Packaged import, library state, project isolation/link/copy, folders, and tags passed.')
  return { primaryDocId, deleteDocId, copiedDocumentId: organization.copiedDocumentId, targetProjectId: organization.targetProject.id }
}

async function verifyPackagedResearchNotes(window, docId) {
  const marker = `packaged-note-${Date.now().toString(36)}`
  const result = await window.evaluate(async ({ id, query }) => {
    const first = await window.api.createResearchNote({
      docId: id,
      pageNum: 1,
      excerpt: `${query} first excerpt`,
      note: 'first note',
      tags: ['packaged', 'regression'],
      sourceType: 'manual',
    })
    const second = await window.api.createResearchNote({
      docId: id,
      pageNum: 1,
      excerpt: `${query} second excerpt`,
      note: 'second note',
      sourceType: 'manual',
    })
    const before = await window.api.listResearchNotesPage({ search: query, includeOverview: true, limit: 20 })
    const updated = await window.api.updateResearchNote(first.id, { note: 'updated packaged note' })
    const afterUpdate = await window.api.listResearchNotesPage({ search: query, limit: 20 })
    const deleted = await window.api.deleteResearchNotes([first.id, second.id])
    const afterDelete = await window.api.listResearchNotesPage({ search: query, limit: 20 })
    return { first, second, before, updated, afterUpdate, deleted, afterDelete }
  }, { id: docId, query: marker })
  assertCondition(result.first?.id && result.second?.id, 'Research note creation failed', result)
  assertCondition(result.before?.items?.length === 2 && result.before?.total === 2, 'Research note paging/search failed', result.before)
  assertCondition(result.updated && result.afterUpdate?.items?.some((note) => note.id === result.first.id && note.note === 'updated packaged note'), 'Research note update failed', result.afterUpdate)
  assertCondition(result.deleted?.deleted === 2 && result.afterDelete?.total === 0, 'Batch research note deletion failed', result)
  console.log('Packaged research-note create, page, update, and batch delete passed.')
}

async function verifyPackagedDiagnosticsBackupAndDeletion(window, docIds) {
  const beforeDelete = await window.evaluate(async () => {
    const stateCache = await window.api.refreshLibraryStateCache()
    const smartCounts = await window.api.refreshLibrarySmartViewCounts()
    const folderCounts = await window.api.refreshLibraryFolderCounts()
    const health = await window.api.getDocumentHealthReport({ refresh: true })
    const lock = await window.api.getDatabaseLockDiagnostics()
    const storage = await window.api.getDatabaseStorageDiagnostics()
    const backup = await window.api.runAutoBackupNow()
    return { stateCache, smartCounts, folderCounts, health, lock, storage, backup }
  })
  assertCondition(beforeDelete.stateCache && typeof beforeDelete.stateCache === 'object', 'Library state cache refresh failed')
  assertCondition(beforeDelete.smartCounts && typeof beforeDelete.smartCounts === 'object', 'Smart-view counts refresh failed')
  assertCondition(beforeDelete.folderCounts && typeof beforeDelete.folderCounts === 'object', 'Folder counts refresh failed')
  assertCondition(beforeDelete.health?.generatedAt && Array.isArray(beforeDelete.health.rows), 'Document health report failed', beforeDelete.health)
  assertCondition(beforeDelete.lock?.checkedAt && typeof beforeDelete.lock.writerAvailable === 'boolean', 'Database lock diagnostics failed', beforeDelete.lock)
  assertCondition(beforeDelete.storage?.databasePath && Array.isArray(beforeDelete.storage.tables), 'Database storage diagnostics failed', beforeDelete.storage)
  assertCondition(beforeDelete.backup?.success && beforeDelete.backup?.path, 'Automatic backup failed', beforeDelete.backup)

  const deletion = await window.evaluate((ids) => window.api.deleteDocumentsBatch(ids), docIds)
  assertCondition(deletion?.successCount === docIds.length && deletion?.failedIds?.length === 0, 'Packaged batch deletion failed', deletion)
  for (const docId of docIds) {
    await waitForDocumentRemoval(window, docId)
  }
  const finalLock = await window.evaluate(() => window.api.getDatabaseLockDiagnostics())
  assertCondition(finalLock?.writerAvailable, 'Database writer remained blocked after deletion', finalLock)
  console.log('Packaged library caches, diagnostics, backup, and batch-deletion worker passed.')
}

function verifyPackagedRuntime(executable) {
  const probe = path.join(root, 'scripts', 'packaged-runtime-probe.js')
  const result = spawnSync(executable, [probe], {
    cwd: root,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      GUJISMART_PACKAGED_RESOURCES: path.join(unpacked, 'resources'),
    },
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`Packaged runtime dependency probe failed:\n${result.stderr || result.stdout}`)
  }
  if (result.stdout.trim()) console.log(result.stdout.trim())
}

async function main() {
  if (process.platform !== 'win32') throw new Error('Packaged smoke currently requires Windows')
  const executable = fs.readdirSync(unpacked).filter((name) => name.toLowerCase().endsWith('.exe')).map((name) => path.join(unpacked, name)).find((filePath) => fs.statSync(filePath).isFile())
  if (!executable) throw new Error(`No packaged executable found in ${unpacked}`)
  for (const required of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'sbom.spdx.json', 'vendor-manifest.json']) {
    const candidates = [path.join(unpacked, 'resources', 'licenses', required), path.join(unpacked, 'resources', 'release-metadata', required)]
    if (!candidates.some((candidate) => fs.existsSync(candidate))) throw new Error(`Packaged metadata missing: ${required}`)
  }
  verifyPackagedRuntime(executable)
  const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gujismart-packaged-smoke-'))
  const userDataDir = path.join(smokeRoot, 'chromium')
  const dataDir = path.join(smokeRoot, 'data')
  const profileDir = path.join(smokeRoot, 'profile')
  const app = await electron.launch({
    executablePath: executable,
    args: [`--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      GUJISMART_SMOKE: '1',
      GUJISMART_DATA_DIR: dataDir,
      GUJISMART_PROFILE_DIR: profileDir,
      GUJISMART_AUTO_REINDEX: '0'
    }
  })
  try {
    const window = await app.firstWindow({ timeout: 30000 })
    await window.waitForLoadState('domcontentloaded')
    if (!(await window.locator('body').innerText()).trim()) throw new Error('Packaged renderer is blank')
    const startup = await verifyPackagedStartupAndReadOnlyServices(window)
    const library = await verifyPackagedLibraryProjectsFoldersAndTags(window, smokeRoot, startup.activeProject)
    await verifyPackagedResearchNotes(window, library.primaryDocId)
    const search = await verifyPackagedSearchExcerptExport(window, smokeRoot)
    await verifyPackagedDiagnosticsBackupAndDeletion(window, [library.deleteDocId, search.docId])
    console.log('Packaged comprehensive offline smoke passed.')
  } finally {
    await app.close().catch(() => undefined)
    fs.rmSync(smokeRoot, { recursive: true, force: true })
  }
}

main().catch((error) => { console.error(error); process.exit(1) })
