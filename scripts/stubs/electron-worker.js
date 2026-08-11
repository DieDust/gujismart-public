// Node worker_threads cannot access Electron main-process APIs such as app.
// Keep this stub intentionally empty so worker regressions catch eager access
// to electron.app during module initialization.
module.exports = {}
