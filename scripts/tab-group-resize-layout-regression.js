const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const appCss = fs.readFileSync(path.join(root, 'src/renderer/src/styles/app.css'), 'utf8')
const globalCss = fs.readFileSync(path.join(root, 'src/renderer/src/styles/global.css'), 'utf8')

app.commandLine.appendSwitch('disable-gpu')

function createTab(id) {
  return `
    <button class="app-tab" data-layout-item="${id}">
      <span class="app-tab-icon">□</span>
      <span class="app-tab-title">${id}</span>
      <span class="app-tab-close">×</span>
    </button>
  `
}

function createGroup(id, tabCount, collapsed = false) {
  const tabs = Array.from({ length: tabCount }, (_, index) => createTab(`${id}-tab-${index + 1}`)).join('')
  return `
    <div
      class="app-tab-group-segment ${collapsed ? 'is-collapsed' : ''}"
      data-layout-group="${id}"
    >
      <button class="app-tab-group-chip" data-layout-item="${id}-chip">
        <span class="app-tab-group-toggle">›</span>
        <span class="app-tab-group-title">${id}</span>
        <span class="app-tab-group-count">${tabCount}</span>
      </button>
      ${collapsed ? '' : tabs}
    </div>
  `
}

const fixture = [
  createGroup('group-a', 2),
  createTab('loose-a'),
  createGroup('group-b', 1, true),
  createGroup('group-c', 1),
  createTab('loose-b'),
  createTab('loose-c'),
  createGroup('group-d', 4, true),
  createTab('loose-d'),
  createTab('loose-e'),
].join('')

const html = `
  <!doctype html>
  <html>
    <head>
      <meta charset="utf-8">
      <style>${globalCss}\n${appCss}</style>
      <style>
        html, body {
          margin: 0;
          min-width: 0;
          background: #111;
        }
        #fixture-rail {
          height: 52px;
          margin: 0;
        }
        #fixture-strip {
          --app-tab-strip-ideal-width: 3200px;
        }
      </style>
    </head>
    <body>
      <div id="fixture-rail" class="app-tab-rail">
        <div id="fixture-strip" class="app-tab-strip" data-app-tab-density="normal">
          ${fixture}
        </div>
      </div>
    </body>
  </html>
`

async function run() {
  await app.whenReady()
  const window = new BrowserWindow({
    show: false,
    width: 2100,
    height: 180,
    webPreferences: {
      backgroundThrottling: false,
      sandbox: true,
    },
  })

  try {
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    const result = await window.webContents.executeJavaScript(`
      (async () => {
        const strip = document.getElementById('fixture-strip')
        const rail = document.getElementById('fixture-rail')
        const visibleTabCount = 7
        const groupCount = 4
        const visualItemCount = visibleTabCount + groupCount

        const getMetrics = (density) => {
          if (density === 'icon') {
            return { gap: 2, chipWidth: 34, groupPadding: 6, stripPadding: 8, tabMax: 42 }
          }
          if (density === 'tight') {
            return { gap: 3, chipWidth: 58, groupPadding: 6, stripPadding: 16, tabMax: 74 }
          }
          if (density === 'compact') {
            return { gap: 4, chipWidth: 78, groupPadding: 8, stripPadding: 16, tabMax: 118 }
          }
          return { gap: 6, chipWidth: 96, groupPadding: 8, stripPadding: 16, tabMax: 210 }
        }
        const getSlotWidth = (density) => {
          const metrics = getMetrics(density)
          const gapTotal = Math.max(0, visualItemCount - 1) * metrics.gap
          const groupReserve = groupCount * (metrics.chipWidth + metrics.groupPadding)
          const usableForTabs = Math.max(
            0,
            strip.clientWidth - metrics.stripPadding - gapTotal - groupReserve,
          )
          return Math.max(0, Math.min(metrics.tabMax, usableForTabs / visibleTabCount))
        }
        const getDensity = () => {
          const slot = getSlotWidth('normal')
          if (slot <= 46) return 'icon'
          if (slot <= 74) return 'tight'
          if (slot <= 118) return 'compact'
          return 'normal'
        }
        const applyLayout = () => {
          const density = getDensity()
          const metrics = getMetrics(density)
          const slotWidth = getSlotWidth(density)
          strip.dataset.appTabDensity = density
          strip.style.setProperty('--app-tab-slot-width', slotWidth + 'px')
          strip.querySelectorAll('[data-layout-group]:not(.is-collapsed)').forEach((group) => {
            const tabCount = group.querySelectorAll(':scope > .app-tab').length
            const groupWidth = (
              metrics.chipWidth
              + metrics.groupPadding
              + tabCount * slotWidth
              + tabCount * metrics.gap
            )
            group.style.setProperty('--app-tab-group-segment-width', groupWidth + 'px')
          })
        }
        const inspect = (width) => {
          const overlaps = []
          const groups = Array.from(strip.querySelectorAll('[data-layout-group]'))
          groups.forEach((group) => {
            const groupRect = group.getBoundingClientRect()
            const children = Array.from(group.querySelectorAll(':scope > [data-layout-item]'))
              .filter((element) => element.getClientRects().length > 0)
            children.forEach((element) => {
              const rect = element.getBoundingClientRect()
              if (rect.left < groupRect.left - 0.5 || rect.right > groupRect.right + 0.5) {
                overlaps.push({
                  type: 'group-overflow',
                  group: group.dataset.layoutGroup,
                  item: element.dataset.layoutItem,
                  groupLeft: groupRect.left,
                  groupRight: groupRect.right,
                  itemLeft: rect.left,
                  itemRight: rect.right,
                })
              }
            })
          })
          return {
            width,
            density: strip.dataset.appTabDensity,
            stripWidth: strip.clientWidth,
            overlaps,
          }
        }

        const checks = []
        for (const width of [2100, 1520, 1180, 860, 1320, 1900, 1040, 2100]) {
          rail.style.width = width + 'px'
          strip.getBoundingClientRect()
          applyLayout()
          strip.getBoundingClientRect()
          checks.push(inspect(width))
        }
        return checks
      })()
    `)

    const failures = result.filter((check) => check.overlaps.length > 0)
    if (failures.length > 0) {
      throw new Error(`Tab/group items overflow after resize: ${JSON.stringify(failures, null, 2)}`)
    }
    console.log('Tab group resize layout regression checks passed.')
  } finally {
    window.destroy()
    await app.quit()
  }
}

run().catch((error) => {
  console.error(error)
  app.exit(1)
})
