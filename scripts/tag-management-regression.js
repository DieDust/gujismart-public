const fs = require('fs')
const path = require('path')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const root = path.join(__dirname, '..')
const source = fs.readFileSync(path.join(root, 'src', 'main', 'ipc', 'tags.ts'), 'utf8').replace(/\r\n/g, '\n')
const listStart = source.indexOf("ipcMain.handle('tags:list'")
const createStart = source.indexOf("ipcMain.handle('tags:create'", listStart)
assert(listStart >= 0 && createStart > listStart, 'tag list handler markers must exist')
const listBody = source.slice(listStart, createStart)

assert(!listBody.includes('refreshTagUsage()'), 'tags:list must be a pure read and must not merge, delete, or save tags')
assert(source.includes('function assertTagParentAllowed'), 'tag parent mutations must share one main-process validator')
assert(source.includes('assertTagParentAllowed(null, parentId)'), 'tag creation must validate its parent')
assert(source.includes('assertTagParentAllowed(tagId, nextParentId)'), 'tag update must reject self and descendant cycles')
assert(source.includes("throw new Error('标签名称不能为空')"), 'tag create and update must reject empty names')
assert(source.includes('SELECT * FROM tags WHERE normalized_name = ? AND id <> ?'), 'tag rename must detect conflicts without overwriting another tag')

console.log('Tag management regression passed.')
