const path = require('path')
const os = require('os')

const baseDir = path.join(os.tmpdir(), 'gujismart-electron-stub')

exports.app = {
  getName: () => 'gujismart-test',
  getPath: (name) => {
    if (name === 'exe') return path.join(baseDir, 'gujismart-test.exe')
    if (name === 'appData') return path.join(baseDir, 'appData')
    if (name === 'userData') return path.join(baseDir, 'userData')
    if (name === 'documents') return path.join(baseDir, 'documents')
    return baseDir
  },
}
