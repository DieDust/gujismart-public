import { ConfigProvider, message, theme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import type { LibraryProject } from '@shared/types'
import App from './App'

message.config({
  maxCount: 3,
  duration: 3,
  top: 48,
})

export interface AppShellProps {
  initialLibraryProject: LibraryProject
  initialLibraryProjects: LibraryProject[]
}

export default function AppShell(props: AppShellProps) {
  return (
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
      <App {...props} />
    </ConfigProvider>
  )
}
