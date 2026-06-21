const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const source = fs.readFileSync(path.join(root, 'src/renderer/src/views/LibraryView.tsx'), 'utf8')

function assertIncludes(needle, label) {
  if (!source.includes(needle)) {
    throw new Error(`${label}: missing ${needle}`)
  }
}

function assertNotIncludes(needle, label) {
  if (source.includes(needle)) {
    throw new Error(`${label}: unexpected ${needle}`)
  }
}

assertIncludes("gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 340px))'", 'grid cards should use a bounded preview width instead of stretching')
assertIncludes("justifyContent: 'start'", 'grid cards should stay left aligned when there are only a few documents')
assertIncludes("alignItems: 'start'", 'grid cards in one row should not stretch to the tallest card')
assertIncludes("docFolderNames.length > 0 ? 1 : 2", 'grid card should reserve tag space when a folder chip is visible')
assertIncludes("height: 24, maxHeight: 24", 'grid card tag row should stay one line')
assertIncludes("height: 22, lineHeight: '20px'", 'grid card chips should have fixed height')
assertIncludes("maxWidth: 174", 'grid card actions should not push metadata out of the row')
assertIncludes("style={{ width: 24, height: 24, padding: 0 }}", 'grid card icon buttons should have stable dimensions')
assertIncludes("hiddenTags.length > 0", 'grid card should collapse overflowing tags behind a summary chip')
assertNotIncludes("repeat(auto-fill, minmax(380px, 1fr))", 'grid cards should not use elastic full-row columns')
assertNotIncludes("minHeight: 132", 'grid card should not use the clipped legacy compact height')
assertNotIncludes("borderTop: '1px solid rgba(255,255,255,0.06)'", 'grid card actions should not consume a separate full row')

console.log('Library grid card layout regression checks passed')
