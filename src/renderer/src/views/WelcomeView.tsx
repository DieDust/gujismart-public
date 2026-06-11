import { ImportOutlined, BookOutlined, SettingOutlined, SearchOutlined, FormatPainterOutlined } from '@ant-design/icons'
import { PRODUCT_NAME, PRODUCT_SUBTITLE } from '@shared/types'

interface WelcomeViewProps {
  onImport: () => void
  onNavigate: (view: 'library' | 'settings' | 'search' | 'citation') => void
}

export default function WelcomeView({ onImport, onNavigate }: WelcomeViewProps) {
  return (
    <div className="welcome-view">
      <h1 className="welcome-title">{PRODUCT_NAME}</h1>
      <p className="welcome-subtitle">{PRODUCT_SUBTITLE}</p>

      <div className="welcome-actions">
        <div className="glass-card welcome-card" onClick={onImport}>
          <ImportOutlined className="welcome-card-icon" />
          <span className="welcome-card-title">导入文献</span>
          <span className="welcome-card-desc">
            支持 PDF、图片与扫描件
            <br />
            拖拽或点击选择文件
          </span>
        </div>

        <div className="glass-card welcome-card" onClick={() => onNavigate('library')}>
          <BookOutlined className="welcome-card-icon" />
          <span className="welcome-card-title">文献库</span>
          <span className="welcome-card-desc">
            管理已导入的文献
            <br />
            标签、文件夹、状态一目了然
          </span>
        </div>

        <div className="glass-card welcome-card" onClick={() => onNavigate('search')}>
          <SearchOutlined className="welcome-card-icon" />
          <span className="welcome-card-title">全文检索</span>
          <span className="welcome-card-desc">
            搜索标题、元数据与 OCR 全文
            <br />
            命中结果可直接跳转页码
          </span>
        </div>

        <div className="glass-card welcome-card" onClick={() => onNavigate('citation')}>
          <FormatPainterOutlined className="welcome-card-icon" />
          <span className="welcome-card-title">引用格式</span>
          <span className="welcome-card-desc">
            管理引文模板
            <br />
            一键生成常用引用格式
          </span>
        </div>

        <div className="glass-card welcome-card" onClick={() => onNavigate('settings')}>
          <SettingOutlined className="welcome-card-icon" />
          <span className="welcome-card-title">设置</span>
          <span className="welcome-card-desc">
            配置 OCR 与 AI 接口
            <br />
            调整自动处理与批量参数
          </span>
        </div>
      </div>
    </div>
  )
}
