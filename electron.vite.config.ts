import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['nanoid', 'marked'] })],
    build: {
      outDir: 'out/main',
      emptyOutDir: true,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'database-diagnostics-worker': resolve(__dirname, 'src/main/database-diagnostics-worker.ts'),
          'health-report-worker': resolve(__dirname, 'src/main/health-report-worker.ts'),
          'search-index-worker': resolve(__dirname, 'src/main/search-index-worker.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      emptyOutDir: true,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts')
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    build: {
      target: 'esnext',
      outDir: 'out/renderer',
      emptyOutDir: true,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html')
        }
      }
    },
    optimizeDeps: {
      esbuildOptions: {
        target: 'esnext'
      }
    },
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer/src'),
        '@shared': resolve(__dirname, 'src/shared')
      }
    }
  }
})
