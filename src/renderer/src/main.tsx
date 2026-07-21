import React from 'react'
import ReactDOM from 'react-dom/client'
import { ConfigProvider, message, theme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import App from './App'
import './styles/global.css'

// Cap concurrent toasts so OCR/import/index progress never stacks into a wall of bubbles.
// Same-key updates still replace in place; this only limits distinct keys.
message.config({
  maxCount: 3,
  duration: 3,
  top: 48,
})

type RendererErrorBoundaryState = {
  error: Error | null
}

class RendererErrorBoundary extends React.Component<React.PropsWithChildren, RendererErrorBoundaryState> {
  state: RendererErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): RendererErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error('[Renderer] Unhandled React error', error, errorInfo)
  }

  render(): React.ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <main className="renderer-fatal-error" role="alert">
        <section className="renderer-fatal-error__panel">
          <h1>页面加载出现异常</h1>
          <p>文献数据没有被删除。请重新加载界面；如果问题仍然存在，可重启软件后再试。</p>
          <button type="button" onClick={() => window.location.reload()}>
            重新加载
          </button>
          <details>
            <summary>错误详情</summary>
            <pre>{error.stack || error.message}</pre>
          </details>
        </section>
      </main>
    )
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RendererErrorBoundary>
      <ConfigProvider
        locale={zhCN}
        theme={{
          algorithm: theme.darkAlgorithm,
          token: {
            colorPrimary: '#c4956a',
            colorSuccess: '#2e8b57',
            colorWarning: '#d99f00',
            colorError: '#b22222',
            colorInfo: '#3a5fcd',
            borderRadius: 8,
            fontFamily: "'Inter', 'Noto Serif SC', -apple-system, BlinkMacSystemFont, sans-serif",
          },
          components: {
            Layout: {
              siderBg: '#121110',
              headerBg: '#1a1816',
              bodyBg: '#0e0d0c',
            },
            Menu: {
              darkItemBg: '#121110',
              darkSubMenuItemBg: '#0e0d0c',
              darkItemSelectedBg: 'rgba(196, 149, 106, 0.12)',
              darkItemSelectedColor: '#d4ad84',
            },
            Button: {
              colorPrimaryHover: '#d4ad84',
              colorPrimaryActive: '#a67b52',
            },
            Progress: {
              remainingColor: 'rgba(255, 255, 255, 0.04)',
              defaultColor: '#c4956a',
            },
          },
        }}
      >
        <App />
      </ConfigProvider>
    </RendererErrorBoundary>
  </React.StrictMode>,
)
