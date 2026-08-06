import {
  AimOutlined,
  CommentOutlined,
  FileTextOutlined,
  MoreOutlined,
  PictureOutlined,
  TableOutlined,
} from '@ant-design/icons'
import type { ManualLayoutBlockKind } from '@shared/manual-layout'
import { Button, Dropdown, Space, Tooltip, theme } from 'antd'
import type { MenuProps } from 'antd'
import {
  MANUAL_LAYOUT_MORE_KINDS,
  MANUAL_LAYOUT_QUICK_KINDS,
  type ManualLayoutTool,
} from '../utils/manualLayoutBlockEditing'

export const MANUAL_LAYOUT_KIND_NAMES: Record<ManualLayoutBlockKind, string> = {
  text: '正文',
  title: '标题',
  paragraph_title: '小标题',
  note: '注释',
  abstract: '摘要',
  reference: '参考文献',
  header: '页眉',
  footer: '页脚',
  number: '页码',
  table: '表格',
  image: '图片',
  seal: '印章',
}

const QUICK_KIND_ICONS: Partial<Record<ManualLayoutBlockKind, React.ReactNode>> = {
  text: <FileTextOutlined />,
  note: <CommentOutlined />,
  table: <TableOutlined />,
  image: <PictureOutlined />,
}

export interface ManualLayoutToolbarProps {
  tool: ManualLayoutTool
  disabled?: boolean
  onToolChange: (tool: ManualLayoutTool) => void
}

export default function ManualLayoutToolbar({ tool, disabled = false, onToolChange }: ManualLayoutToolbarProps) {
  const { token } = theme.useToken()
  const moreSelected = tool !== 'select' && MANUAL_LAYOUT_MORE_KINDS.includes(tool)
  const moreItems: MenuProps['items'] = MANUAL_LAYOUT_MORE_KINDS.map((kind) => ({
    key: kind,
    label: MANUAL_LAYOUT_KIND_NAMES[kind],
  }))

  return (
    <div
      data-manual-layout-toolbar="true"
      aria-label="版式区块工具"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        maxWidth: '100%',
        padding: '4px 6px',
        border: `1px solid ${token.colorBorderSecondary}`,
        borderRadius: token.borderRadiusLG,
        background: token.colorBgElevated,
        boxShadow: token.boxShadowSecondary,
        overflowX: 'auto',
      }}
    >
      <Space.Compact size="small">
        <Tooltip title="选择、移动或调整区块（Esc）">
          <Button
            icon={<AimOutlined />}
            type={tool === 'select' ? 'primary' : 'default'}
            aria-pressed={tool === 'select'}
            data-manual-layout-tool="select"
            disabled={disabled}
            onClick={() => onToolChange('select')}
          >
            选择
          </Button>
        </Tooltip>
        {MANUAL_LAYOUT_QUICK_KINDS.map((kind) => (
          <Tooltip key={kind} title={`连续绘制${MANUAL_LAYOUT_KIND_NAMES[kind]}区块；按 Esc 返回选择`}>
            <Button
              icon={QUICK_KIND_ICONS[kind]}
              type={tool === kind ? 'primary' : 'default'}
              aria-pressed={tool === kind}
              data-manual-layout-tool={kind}
              disabled={disabled}
              onClick={() => onToolChange(kind)}
            >
              {MANUAL_LAYOUT_KIND_NAMES[kind]}
            </Button>
          </Tooltip>
        ))}
        <Dropdown
          trigger={['click']}
          disabled={disabled}
          menu={{
            items: moreItems,
            selectable: true,
            selectedKeys: moreSelected ? [tool] : [],
            onClick: ({ key }) => onToolChange(key as ManualLayoutBlockKind),
          }}
        >
          <Button
            icon={<MoreOutlined />}
            type={moreSelected ? 'primary' : 'default'}
            aria-pressed={moreSelected}
            data-manual-layout-tool="more"
          >
            {moreSelected ? MANUAL_LAYOUT_KIND_NAMES[tool as ManualLayoutBlockKind] : '更多'}
          </Button>
        </Dropdown>
      </Space.Compact>
      <span style={{ color: token.colorTextSecondary, fontSize: 12, whiteSpace: 'nowrap' }}>
        {tool === 'select' ? '拖动已有框；拖动空白处后选择类型' : `连续绘制${MANUAL_LAYOUT_KIND_NAMES[tool]}`}
      </span>
    </div>
  )
}
