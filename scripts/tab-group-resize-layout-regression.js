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
        const visibleTabCount = strip.querySelectorAll(
          ':scope > .app-tab, :scope > [data-layout-group]:not(.is-collapsed) > .app-tab',
        ).length
        const groupCount = strip.querySelectorAll(':scope > [data-layout-group]').length
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
        let layoutCount = 0
        const layoutHistory = []
        const inspect = (width, zoomFactor = 1) => {
          const overlaps = []
          const stripRect = strip.getBoundingClientRect()
          const groups = Array.from(strip.querySelectorAll('[data-layout-group]'))
          groups.forEach((group) => {
            const groupRect = group.getBoundingClientRect()
            const groupStyle = window.getComputedStyle(group)
            if (
              strip.dataset.appTabDensity === 'icon'
              && !group.classList.contains('is-collapsed')
              && Number.parseFloat(groupStyle.flexGrow) !== 0
            ) {
              overlaps.push({
                type: 'icon-group-flex-growth',
                group: group.dataset.layoutGroup,
                flexGrow: groupStyle.flexGrow,
                flexBasis: groupStyle.flexBasis,
              })
            }
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
          Array.from(strip.querySelectorAll(':scope > [data-layout-group], :scope > .app-tab'))
            .filter((element) => element.getClientRects().length > 0)
            .forEach((element) => {
              const rect = element.getBoundingClientRect()
              if (rect.left < stripRect.left - 0.5 || rect.right > stripRect.right + 0.5) {
                overlaps.push({
                  type: 'strip-overflow',
                  item: element.dataset.layoutGroup || element.dataset.layoutItem,
                  stripLeft: stripRect.left,
                  stripRight: stripRect.right,
                  itemLeft: rect.left,
                  itemRight: rect.right,
                })
              }
            })
          return {
            width,
            zoomFactor,
            density: strip.dataset.appTabDensity,
            stripWidth: strip.clientWidth,
            stripRectWidth: stripRect.width,
            viewportWidth: window.visualViewport?.width || window.innerWidth,
            documentWidth: document.documentElement.clientWidth,
            devicePixelRatio: window.devicePixelRatio,
            layoutCount,
            layoutHistory: layoutHistory.slice(-12),
            overlaps,
          }
        }

        const measure = () => {
          layoutCount += 1
          applyLayout()
          layoutHistory.push({
            at: Math.round(performance.now()),
            stripWidth: strip.clientWidth,
            density: strip.dataset.appTabDensity,
            slotWidth: strip.style.getPropertyValue('--app-tab-slot-width'),
            devicePixelRatio: window.devicePixelRatio,
          })
        }
        let settleMeasureTimers = []
        const scheduleMeasure = () => {
          measure()
          settleMeasureTimers.forEach((timer) => window.clearTimeout(timer))
          settleMeasureTimers = [30, 90, 180].map((delay) => window.setTimeout(measure, delay))
        }
        const resizeObserver = new ResizeObserver(measure)
        resizeObserver.observe(strip)
        resizeObserver.observe(rail)
        window.addEventListener('resize', scheduleMeasure)
        window.visualViewport?.addEventListener('resize', scheduleMeasure)
        let resolutionMedia = window.matchMedia('(resolution: ' + window.devicePixelRatio + 'dppx)')
        const handleResolutionChange = () => {
          scheduleMeasure()
          resolutionMedia.removeEventListener('change', handleResolutionChange)
          resolutionMedia = window.matchMedia('(resolution: ' + window.devicePixelRatio + 'dppx)')
          resolutionMedia.addEventListener('change', handleResolutionChange)
        }
        resolutionMedia.addEventListener('change', handleResolutionChange)
        let observedDevicePixelRatio = window.devicePixelRatio
        window.setInterval(() => {
          if (Math.abs(window.devicePixelRatio - observedDevicePixelRatio) < 0.001) return
          observedDevicePixelRatio = window.devicePixelRatio
          scheduleMeasure()
        }, 25)
        measure()

        window.__runTabLayoutWidths = (widths) => widths.map((width) => {
          rail.style.width = width + 'px'
          strip.getBoundingClientRect()
          measure()
          strip.getBoundingClientRect()
          return inspect(width)
        })
        window.__prepareFluidTabLayout = () => {
          rail.style.width = '100%'
          strip.getBoundingClientRect()
          measure()
          strip.getBoundingClientRect()
        }
        window.__inspectTabLayout = (zoomFactor) => inspect(rail.clientWidth, zoomFactor)

        return window.__runTabLayoutWidths([2100, 1520, 1180, 860, 1320, 1900, 1040, 2100])
      })()
    `)

    await window.webContents.executeJavaScript('window.__prepareFluidTabLayout()')
    const zoomChecks = []
    for (const zoomFactor of [1, 1.25, 1.5, 1.75, 1.25, 1]) {
      window.webContents.setZoomFactor(zoomFactor)
      await new Promise((resolve) => setTimeout(resolve, 260))
      zoomChecks.push(await window.webContents.executeJavaScript(`window.__inspectTabLayout(${zoomFactor})`))
    }

    const checks = [...result, ...zoomChecks]
    const failures = checks.filter((check) => check.overlaps.length > 0)
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
