// 渲染进程入口
import React from 'react'
import ReactDOM from 'react-dom/client'
import { ConfigProvider, theme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import App from './App'
import './styles/global.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        // 暗色主题为默认
        algorithm: theme.darkAlgorithm,
        token: {
          // 品牌色：古铜金
          colorPrimary: '#C4956A',
          // 圆角
          borderRadius: 8,
          // 字体
          fontFamily: "'Inter', 'Noto Serif SC', -apple-system, BlinkMacSystemFont, sans-serif",
        },
        components: {
          Layout: {
            // 侧边栏深色背景
            siderBg: '#141414',
            headerBg: '#1a1a1a',
            bodyBg: '#0a0a0a',
          },
          Menu: {
            darkItemBg: '#141414',
            darkSubMenuItemBg: '#0a0a0a',
          }
        }
      }}
    >
      <App />
    </ConfigProvider>
  </React.StrictMode>
)
