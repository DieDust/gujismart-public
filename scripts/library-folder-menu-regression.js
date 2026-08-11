const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8').replace(/\r\n?/g, '\n')

const view = read('src', 'renderer', 'src', 'views', 'LibraryView.tsx')
const styles = read('src', 'renderer', 'src', 'styles', 'app.css')

assert.ok(view.includes('function buildDocumentFolderMenuItems'), 'document folder menu must have a recursive tree builder')
assert.ok(view.includes('FolderTreeNode<FolderItem>[]'), 'document folder menu must consume the existing folder tree')
assert.ok(view.includes("key: `folder_${node.id}`"), 'selectable folder targets must keep the existing folder_<id> key')
assert.ok(view.includes("key: `folder-parent:${node.id}`"), 'structural parent submenu keys must not collide with selectable folder keys')
assert.ok(view.includes("popupClassName: 'library-document-folder-submenu'"), 'every folder submenu must receive the scoped popup class')
assert.ok(!view.includes('availableFolders.map((item)'), 'document folder targets must no longer be flattened')
assert.ok((view.match(/overlayClassName="library-document-menu"/g) || []).length >= 4, 'list/grid context and more menus must share the document overlay class')
assert.ok(styles.includes('.library-document-folder-submenu .ant-dropdown-menu'), 'nested folder popup styles must be scoped')
assert.ok(/max-height:\s*min\(60vh,\s*480px\)/.test(styles), 'folder menus must be capped to the viewport')
assert.ok(/overflow-y:\s*auto/.test(styles), 'folder menus must scroll vertically')
assert.ok(styles.includes('.library-folder-menu-label'), 'long folder labels must have a truncation style')

console.log('Library folder menu regression checks passed.')
