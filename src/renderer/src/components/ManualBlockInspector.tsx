import {
  CloseOutlined,
  DeleteOutlined,
  PictureOutlined,
  ScissorOutlined,
} from '@ant-design/icons'
import {
  createManualLayoutBlockId,
  getManualLayoutBlockKind,
  isStableManualLayoutBlockId,
  type ManualLayoutBlockKind,
} from '@shared/manual-layout'
import { Alert, Button, Empty, Input, InputNumber, Segmented, Select, Space, Tag, Tooltip, message, theme } from 'antd'
import { useEffect, useState } from 'react'
import FacsimileTableEditor, { type FacsimileTableEditorValue } from './FacsimileTableEditor'
import type { FacsimileTableMerge } from '../utils/facsimileTableEditing'
import { MANUAL_LAYOUT_BLOCK_KINDS } from '../utils/manualLayoutBlockEditing'
import {
  createManualImageAssetUpdate,
  scaleManualImageCropToNaturalPixels,
  type ManualImageCoordinateSize,
} from '../utils/manualImageAssetEditing'
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
  image_asset_width?: number
  image_asset_height?: number
  asset_path?: string
  image_path?: string
  image_crop?: unknown
  location?: unknown
}

export interface ManualBlockInspectorProps {
  pageId: string
  coordinateSourceSize?: ManualImageCoordinateSize | null
  pageImageNaturalSize?: ManualImageCoordinateSize | null
  blockId: string | null
  block: ManualBlockInspectorBlock | null
  disabled?: boolean
  tableRows?: string[][]
  tableMerges?: FacsimileTableMerge[]
  tableRowHeights?: number[]
  tableColumnWidths?: number[]
  onChange: (changes: Record<string, unknown>) => void
  onTableChange: (value: FacsimileTableEditorValue) => void
  onTypeChange: (kind: ManualLayoutBlockKind) => void
  onDelete: () => void
  onDeselect: () => void
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

function resolveInspectorBlockKind(block: ManualBlockInspectorBlock | null): ManualLayoutBlockKind {
  const canonical = getManualLayoutBlockKind(block)
  if (canonical) return canonical
  const rawLabel = block ? stringValue(block.label).toLowerCase().replace(/[_-]+/g, ' ').trim() : ''
  if (rawLabel === 'doc title') return 'title'
  if (/^(?:image|figure|picture|photo|illustration|chart|diagram)(?: block)?$/.test(rawLabel)) return 'image'
  if (/^(?:seal|stamp)(?: block)?$/.test(rawLabel)) return 'seal'
  if (/^table(?: block)?$/.test(rawLabel)) return 'table'
  return 'text'
}

export default function ManualBlockInspector({
  pageId,
  coordinateSourceSize,
  pageImageNaturalSize,
  blockId,
  block,
  disabled = false,
  tableRows = [['']],
  tableMerges = [],
  tableRowHeights = [],
  tableColumnWidths = [],
  onChange,
  onTableChange,
  onTypeChange,
  onDelete,
  onDeselect,
}: ManualBlockInspectorProps) {
  const { token } = theme.useToken()
  const [imageAction, setImageAction] = useState<'crop' | 'replace' | null>(null)
  const [imageError, setImageError] = useState('')
  const [imagePreviewSrc, setImagePreviewSrc] = useState('')
  const kind = resolveInspectorBlockKind(block)
  const imageAssetPath = block
    ? stringValue(block.image_asset_path) || stringValue(block.asset_path) || stringValue(block.image_path)
    : ''

  useEffect(() => {
    let cancelled = false
    setImageError('')
    if (!imageAssetPath) {
      setImagePreviewSrc('')
      return () => { cancelled = true }
    }
    void window.api.readImageAsDataURL(imageAssetPath)
      .then((dataUrl) => { if (!cancelled) setImagePreviewSrc(dataUrl || '') })
      .catch(() => { if (!cancelled) setImagePreviewSrc('') })
    return () => { cancelled = true }
  }, [imageAssetPath])

  const getCurrentCrop = () => {
    const location = block?.location
    if (!location || typeof location !== 'object' || Array.isArray(location)) return null
    const record = location as Record<string, unknown>
    const crop = {
      left: Number(record.left),
      top: Number(record.top),
      width: Number(record.width),
      height: Number(record.height),
    }
    return Object.values(crop).every(Number.isFinite) && crop.width > 0 && crop.height > 0 ? crop : null
  }

  const handleImageCrop = async () => {
    if (!block || !blockId || !pageId || imageAction) return
    const crop = getCurrentCrop()
    if (!crop) {
      setImageError('当前图片区块没有有效坐标，请先在底图上调整选区。')
      return
    }
    setImageAction('crop')
    setImageError('')
    const persistedBlockId = stringValue(block.manual_block_id)
    const assetBlockId = isStableManualLayoutBlockId(pageId, persistedBlockId)
      ? persistedBlockId
      : createManualLayoutBlockId(pageId)
    try {
      const pixelCrop = scaleManualImageCropToNaturalPixels(
        crop,
        coordinateSourceSize,
        pageImageNaturalSize,
      )
      const asset = await window.api.cropManualPageImage({ pageId, blockId: assetBlockId, crop: pixelCrop })
      const update = createManualImageAssetUpdate({
        status: 'success',
        previous: block,
        pageId,
        blockId: assetBlockId,
        asset,
        crop,
      })
      if (update) onChange(update)
      message.success('图片区块已从当前页底图重新裁剪')
    } catch (error) {
      setImageError(String((error as Error)?.message || error || '重新裁剪失败'))
    } finally {
      setImageAction(null)
    }
  }

  const handleImageReplacement = async () => {
    if (!block || !pageId || imageAction) return
    setImageAction('replace')
    setImageError('')
    const persistedBlockId = stringValue(block.manual_block_id)
    const assetBlockId = isStableManualLayoutBlockId(pageId, persistedBlockId)
      ? persistedBlockId
      : createManualLayoutBlockId(pageId)
    try {
      const asset = await window.api.selectManualBlockImage(pageId)
      if (!asset) return
      const update = createManualImageAssetUpdate({
        status: 'success',
        previous: block,
        pageId,
        blockId: assetBlockId,
        asset,
      })
      if (update) onChange(update)
      message.success('已复制仓库图片并替换当前区块')
    } catch (error) {
      setImageError(String((error as Error)?.message || error || '替换图片失败'))
    } finally {
      setImageAction(null)
    }
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
                rowHeights={tableRowHeights}
                columnWidths={tableColumnWidths}
                disabled={disabled}
                onChange={onTableChange}
              />
            </div>
          ) : null}

          {isImageKind(kind) ? (
            <div className="manual-block-inspector-image">
              <div className="manual-block-inspector-preview">
                {imagePreviewSrc ? (
                  <img src={imagePreviewSrc} alt={stringValue(block.alt_text) || stringValue(block.caption)} draggable={false} />
                ) : imageAssetPath ? (
                  <><PictureOutlined /><span title={imageAssetPath}>图片资源暂时无法预览</span></>
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
                  disabled={disabled || imageAction !== null}
                  loading={imageAction === 'crop'}
                  onClick={() => { void handleImageCrop() }}
                >
                  重新裁剪
                </Button>
                <Button
                  icon={<PictureOutlined />}
                  disabled={disabled || imageAction !== null}
                  loading={imageAction === 'replace'}
                  onClick={() => { void handleImageReplacement() }}
                >
                  从仓库选择替换
                </Button>
              </Space>
              {imageError ? (
                <Alert
                  type="error"
                  showIcon
                  message="图片资源操作失败"
                  description={imageError}
                  action={<Button size="small" onClick={() => setImageError('')}>关闭</Button>}
                />
              ) : null}
              <Tag color="default" style={{ marginInlineEnd: 0, alignSelf: 'flex-start' }}>
                操作失败时会保留当前选区和原图片，可直接重试
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
