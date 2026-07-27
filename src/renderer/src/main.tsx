import React from 'react'
import ReactDOM from 'react-dom/client'
import ProjectBootstrap from './ProjectBootstrap'
import './styles/global.css'

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
      <ProjectBootstrap />
    </RendererErrorBoundary>
  </React.StrictMode>,
)
