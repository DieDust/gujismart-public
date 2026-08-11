const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8').replace(/\r\n?/g, '\n')

const view = read('src', 'renderer', 'src', 'views', 'LibraryView.tsx')
const styles = read('src', 'renderer', 'src', 'styles', 'app.css')
const sharedMenuPath = path.join(root, 'src', 'renderer', 'src', 'utils', 'documentFolderMenu.tsx')
const sharedMenu = fs.existsSync(sharedMenuPath) ? fs.readFileSync(sharedMenuPath, 'utf8').replace(/\r\n?/g, '\n') : ''

assert.ok(fs.existsSync(sharedMenuPath), 'Library and Folders views must share one recursive folder menu implementation')
assert.ok(view.includes("from '../utils/documentFolderMenu'"), 'LibraryView must import the shared folder menu implementation')
assert.ok(sharedMenu.includes('function buildDocumentFolderMenuItems'), 'document folder menu must have a recursive tree builder')
assert.ok(sharedMenu.includes('Array<FolderTreeNode<T>>'), 'document folder menu must consume the existing folder tree')
assert.ok(sharedMenu.includes("key: `folder_${node.id}`"), 'selectable folder targets must keep the existing folder_<id> key')
assert.ok(sharedMenu.includes("key: `folder-parent:${node.id}`"), 'structural parent submenu keys must not collide with selectable folder keys')
assert.ok(sharedMenu.includes("popupClassName: 'library-document-folder-submenu'"), 'every folder submenu must receive the scoped popup class')
assert.ok(!sharedMenu.includes('availableFolders.map((item)'), 'document folder targets must no longer be flattened')
assert.ok((view.match(/overlayClassName="library-document-menu"/g) || []).length >= 4, 'list/grid context and more menus must share the document overlay class')
assert.ok(styles.includes('.library-document-folder-submenu .ant-dropdown-menu'), 'nested folder popup styles must be scoped')
assert.ok(/max-height:\s*min\(60vh,\s*480px\)/.test(styles), 'folder menus must be capped to the viewport')
assert.ok(/overflow-y:\s*auto/.test(styles), 'folder menus must scroll vertically')
assert.ok(styles.includes('.library-folder-menu-label'), 'long folder labels must have a truncation style')
assert.ok(
  /function buildBatchMenuItems\([\s\S]*folderTree:\s*FolderTreeNode<FolderItem>\[\]/.test(view),
  'batch actions must receive the same folder tree used by document menus',
)
assert.ok(
  view.includes('children: buildDocumentFolderMenuItems(folderTree, [])'),
  'batch add-to-folder must expand as the nested folder submenu instead of opening a modal',
)
const batchMenuSource = view.slice(
  view.indexOf('function buildBatchMenuItems('),
  view.indexOf('type ConcreteMenuItem'),
)
assert.ok(
  batchMenuSource.indexOf("key: 'add_folder'") < batchMenuSource.indexOf("key: 'group_ocr'"),
  'batch add-to-folder must be a high-priority top-level action before nested processing groups',
)
const batchOrganizeSource = batchMenuSource.slice(
  batchMenuSource.indexOf("key: 'group_organize'"),
  batchMenuSource.indexOf("key: 'export'"),
)
assert.ok(!batchOrganizeSource.includes("key: 'add_folder'"), 'batch add-to-folder must not remain hidden in organize and AI')

const documentMenuSource = view.slice(
  view.indexOf('function buildDocumentMoreMenuItems('),
  view.indexOf('function renderTagSummaryPopover('),
)
assert.ok(
  documentMenuSource.indexOf("key: 'add_to_folder'") < documentMenuSource.indexOf("key: 'group_ocr'"),
  'single-document add-to-folder must be a high-priority top-level action before nested processing groups',
)
const documentOrganizeSource = documentMenuSource.slice(
  documentMenuSource.indexOf("key: 'group_organize'"),
  documentMenuSource.indexOf("key: 'group_storage'"),
)
assert.ok(!documentOrganizeSource.includes("key: 'add_to_folder'"), 'single-document add-to-folder must not remain hidden in organize')
assert.ok(view.includes('selectedIdsRef.current'), 'batch folder actions must read the latest selection instead of a stale render closure')
assert.ok((view.match(/selectedIds\.length > 1/g) || []).length >= 2, 'a single right-click target must keep the single-document menu')
assert.ok(!view.includes('batchFolderModalOpen'), 'the legacy batch folder modal must be removed')

console.log('Library folder menu regression checks passed.')
