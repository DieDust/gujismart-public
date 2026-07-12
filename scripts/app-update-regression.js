const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const settingsIpc = fs.readFileSync(path.join(root, 'src/main/ipc/settings.ts'), 'utf8')
const smoke = fs.readFileSync(path.join(root, 'scripts/electron-smoke.js'), 'utf8')

assert.ok(settingsIpc.includes('getPackagedBuildCreatedAt'), 'update checks must read the packaged build timestamp')
assert.ok(settingsIpc.includes('isReleaseNewerThanBuild'), 'update checks must reject releases older than the local candidate build')
assert.ok(settingsIpc.includes("getStringField(payload, 'published_at')"), 'update checks must compare the GitHub release publication time')
assert.ok(smoke.includes('while (await dismissOneBlockingModal(window))'), 'smoke must dismiss every stacked blocking modal')

console.log('App update regression passed.')
