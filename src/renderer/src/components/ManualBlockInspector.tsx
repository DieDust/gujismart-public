import {
  CloseOutlined,
  DeleteOutlined,
  PictureOutlined,
  ScissorOutlined,
} from '@ant-design/icons'
import {
  getManualLayoutBlockKind,
  type ManualLayoutBlockKind,
} from '@shared/manual-layout'
import { Button, Empty, Input, InputNumber, Segmented, Select, Space, Tag, Tooltip, message, theme } from 'antd'
import FacsimileTableEditor from './FacsimileTableEditor'
import type { FacsimileTableMerge } from '../utils/facsimileTableEditing'
import { MANUAL_LAYOUT_BLOCK_KINDS } from '../utils/manualLayoutBlockEditing'
import { MANUAL_LAYOUT_KIND_NAMES } from './ManualLayoutToolbar'
import './ManualBlockInspector.css'

export type ManualBlockInspectorBlock = Record<string, unknown> & {
  manual_block_id?: string
  label?: string
  words?: string
  orientation?: string
  reading_order?: number
  caption?: string
  alt_text?: string
  image_asset_path?: string
  asset_path?: string
  image_path?: string
}

export interface ManualBlockInspectorProps {
  blockId: string | null
  block: ManualBlockInspectorBlock | null
  disabled?: boolean
  tableRows?: string[][]
  tableMerges?: FacsimileTableMerge[]
  onChange: (changes: Record<string, unknown>) => void
  onTableChange: (value: { rows: string[][]; merges: FacsimileTableMerge[] }) => void
  onTypeChange: (kind: ManualLayoutBlockKind) => void
  onDelete: () => void
  onDeselect: () => void
  onRequestImageCrop?: () => void
  onRequestImageReplacement?: () => void
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function isImageKind(kind: ManualLayoutBlockKind): boolean {
  return kind === 'image' || kind === 'seal'
}

function isTextKind(kind: ManualLayoutBlockKind): boolean {
  return kind !== 'table' && !isImageKind(kind)
}

export default function ManualBlockInspector({
  blockId,
  block,
  disabled = false,
  tableRows = [['']],
  tableMerges = [],
  onChange,
  onTableChange,
  onTypeChange,
  onDelete,
  onDeselect,
  onRequestImageCrop,
  onRequestImageReplacement,
}: ManualBlockInspectorProps) {
  const { token } = theme.useToken()
  const rawLabel = block ? stringValue(block.label).toLowerCase() : ''
  const kind = getManualLayoutBlockKind(block) || (rawLabel === 'doc_title' ? 'title' : 'text')
  const imageAssetPath = block
    ? stringValue(block.image_asset_path) || stringValue(block.asset_path) || stringValue(block.image_path)
    : ''

  const unavailableImageAction = () => {
    message.info('图片资源操作尚未完成，不会修改或丢弃当前区块。')
  }

  return (
    <aside
      className="manual-block-inspector"
      data-manual-block-inspector="true"
      aria-label="区块属性"
      aria-disabled={disabled}
      style={{
        '--manual-inspector-bg': token.colorBgElevated,
        '--manual-inspector-border': token.colorBorderSecondary,
        '--manual-inspector-text': token.colorText,
        '--manual-inspector-secondary': token.colorTextSecondary,
        '--manual-inspector-shadow': token.boxShadowSecondary,
      } as React.CSSProperties}
    >
      <div className="manual-block-inspector-header">
        <div>
          <div className="manual-block-inspector-title">区块属性</div>
          {blockId ? <div className="manual-block-inspector-id" title={blockId}>{blockId}</div> : null}
        </div>
        <Tooltip title="取消选择">
          <Button size="small" type="text" icon={<CloseOutlined />} disabled={disabled || !block} onClick={onDeselect} />
        </Tooltip>
      </div>

      {!block || !blockId ? (
        <div className="manual-block-inspector-empty">
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="未选择区块" />
          <span>请选择已有区块，或用左侧工具在页面上拖出新框。</span>
        </div>
      ) : (
        <div className="manual-block-inspector-content" data-manual-block-id={blockId}>
          <label className="manual-block-inspector-field">
            <span>类型</span>
            <Select
              value={kind}
              disabled={disabled}
              options={MANUAL_LAYOUT_BLOCK_KINDS.map((value) => ({ value, label: MANUAL_LAYOUT_KIND_NAMES[value] }))}
              onChange={(value) => onTypeChange(value)}
            />
          </label>

          <div className="manual-block-inspector-row">
            <label className="manual-block-inspector-field">
              <span>排版方向</span>
              <Segmented
                size="small"
                block
                disabled={disabled || kind === 'table' || isImageKind(kind)}
                value={block.orientation === 'vertical' || block.orientation === 'horizontal' ? block.orientation : 'auto'}
                options={[
                  { value: 'auto', label: '自动' },
                  { value: 'horizontal', label: '横排' },
                  { value: 'vertical', label: '竖排' },
                ]}
                onChange={(value) => onChange(value === 'auto'
                  ? { orientation: undefined, orientation_source: 'auto' }
                  : { orientation: value, orientation_source: 'manual' })}
              />
            </label>
            <label className="manual-block-inspector-field manual-block-inspector-order">
              <span>阅读顺序</span>
              <InputNumber
                min={0}
                step={1}
                precision={0}
                disabled={disabled}
                value={Number.isFinite(Number(block.reading_order)) ? Number(block.reading_order) : 0}
                onChange={(value) => onChange({ reading_order: Math.max(0, Math.floor(Number(value || 0))) })}
              />
            </label>
          </div>

          {isTextKind(kind) ? (
            <label className="manual-block-inspector-field manual-block-inspector-grow">
              <span>文字内容</span>
              <Input.TextArea
                value={stringValue(block.words)}
                disabled={disabled}
                autoSize={{ minRows: 8, maxRows: 22 }}
                placeholder={`输入${MANUAL_LAYOUT_KIND_NAMES[kind]}内容`}
                onChange={(event) => onChange({ words: event.target.value })}
              />
            </label>
          ) : null}

          {kind === 'table' ? (
            <div className="manual-block-inspector-table" aria-disabled={disabled}>
              <FacsimileTableEditor
                editorKey={blockId}
                rows={tableRows}
                merges={tableMerges}
                disabled={disabled}
                onChange={(value) => onTableChange({ rows: value.rows, merges: value.merges })}
              />
            </div>
          ) : null}

          {isImageKind(kind) ? (
            <div className="manual-block-inspector-image">
              <div className="manual-block-inspector-preview">
                {imageAssetPath ? (
                  <>
                    <PictureOutlined />
                    <span title={imageAssetPath}>已关联图片资源</span>
                  </>
                ) : (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="等待生成裁剪图片" />
                )}
              </div>
              <label className="manual-block-inspector-field">
                <span>图片说明</span>
                <Input.TextArea
                  value={stringValue(block.caption)}
                  disabled={disabled}
                  autoSize={{ minRows: 2, maxRows: 5 }}
                  onChange={(event) => onChange({ caption: event.target.value })}
                />
              </label>
              <label className="manual-block-inspector-field">
                <span>替代文字</span>
                <Input
                  value={stringValue(block.alt_text)}
                  disabled={disabled}
                  onChange={(event) => onChange({ alt_text: event.target.value })}
                />
              </label>
              <Space wrap>
                <Button
                  icon={<ScissorOutlined />}
                  disabled={disabled}
                  onClick={onRequestImageCrop || unavailableImageAction}
                >
                  重新裁剪
                </Button>
                <Button
                  icon={<PictureOutlined />}
                  disabled={disabled}
                  onClick={onRequestImageReplacement || unavailableImageAction}
                >
                  替换图片
                </Button>
              </Space>
              <Tag color="default" style={{ marginInlineEnd: 0, alignSelf: 'flex-start' }}>
                操作失败时会保留当前框和原资源
              </Tag>
            </div>
          ) : null}

          <div className="manual-block-inspector-footer">
            <span>修改会自动保存</span>
            <Button danger size="small" icon={<DeleteOutlined />} disabled={disabled} onClick={onDelete}>
              删除区块
            </Button>
          </div>
        </div>
      )}
    </aside>
  )
}
