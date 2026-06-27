import { Fragment, useMemo, useState, type CSSProperties } from 'react'
import { Button, Input, Space, Tag, Typography, message } from 'antd'
import { CheckOutlined, CloseOutlined, EditOutlined, ReloadOutlined } from '@ant-design/icons'
import {
  buildParallelTranslationSegments,
  splitTextForParallelTranslation,
  type ParallelTranslationSegment,
} from '@shared/parallel-translation'
import type { TranslationUnitV1 } from '@shared/types'

export { buildParallelTranslationSegments, splitTextForParallelTranslation }
export type { ParallelTranslationSegment }

const { Text } = Typography

type ParallelTranslationTheme = {
  page: string
  text: string
  muted: string
  border: string
}

type ParallelTranslationMetrics = {
  pageWidth: number
  pageHeight: number
}

interface ParallelTranslationViewProps {
  title: string
  pageLabel: string
  sourceText: string
  translationText?: string
  loading?: boolean
  skipped?: boolean
  themeName: 'paper' | 'sepia' | 'dark'
  themeStyle: ParallelTranslationTheme
  fontSize: number
  lineHeight: number
  pageMetrics?: ParallelTranslationMetrics
  adaptivePages?: boolean
  activeSegmentId?: string
  onActiveSegmentChange?: (segmentId: string) => void
  onSelectedTextChange?: (text: string) => void
  units?: TranslationUnitV1[]
  onUpdateUnit?: (unitId: string, translationText: string) => Promise<void> | void
  onRetranslateUnit?: (unitId: string) => Promise<void> | void
  onClose?: () => void
}

export default function ParallelTranslationView({
  title,
  pageLabel,
  sourceText,
  translationText = '',
  loading = false,
  skipped = false,
  themeName,
  themeStyle,
  fontSize,
  lineHeight,
  pageMetrics,
  adaptivePages = false,
  activeSegmentId = '',
  onActiveSegmentChange,
  onSelectedTextChange,
  units = [],
  onUpdateUnit,
  onRetranslateUnit,
  onClose,
}: ParallelTranslationViewProps) {
  const effectiveTranslationText = skipped ? sourceText : translationText
  const segments = useMemo(
    () => units.length > 0
      ? units.map((unit) => ({
          id: unit.id,
          source: unit.sourceText,
          translation: unit.translationText || (unit.skipped ? unit.sourceText : ''),
        }))
      : buildParallelTranslationSegments(sourceText, loading ? '' : effectiveTranslationText),
    [effectiveTranslationText, loading, sourceText, units],
  )
  const unitById = useMemo(() => new Map(units.map((unit) => [unit.id, unit])), [units])
  const [editingUnitId, setEditingUnitId] = useState('')
  const [editingText, setEditingText] = useState('')
  const [savingUnitId, setSavingUnitId] = useState('')
  const [retryingUnitId, setRetryingUnitId] = useState('')
  const isDark = themeName === 'dark'
  const pageWidth = pageMetrics?.pageWidth || 760
  const activeBorder = isDark ? 'rgba(255, 210, 132, 0.90)' : 'rgba(180, 105, 28, 0.82)'
  const normalBackground = themeStyle.page
  const borderColor = themeStyle.border

  const shellStyle: CSSProperties = adaptivePages
    ? { width: '100%', minHeight: '100%', overflow: 'visible', padding: '14px 18px 18px', display: 'flex', justifyContent: 'center', alignItems: 'flex-start' }
    : { width: '100%', minHeight: '100%', overflow: 'visible', padding: '14px 18px 18px' }
  const gridStyle: CSSProperties = adaptivePages
    ? { display: 'grid', gridTemplateColumns: `${pageWidth}px ${pageWidth}px`, columnGap: 24, justifyContent: 'center', alignItems: 'stretch' }
    : { display: 'grid', gridTemplateColumns: 'minmax(360px, min(48%, 820px)) minmax(360px, min(48%, 820px))', columnGap: 24, justifyContent: 'center', alignItems: 'stretch' }

  const headerStyle = (): CSSProperties => ({
    position: 'sticky',
    top: 0,
    zIndex: 3,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    minHeight: 48,
    padding: '13px 26px 10px',
    background: normalBackground,
    color: themeStyle.muted,
    borderTop: `1px solid ${borderColor}`,
    borderLeft: `1px solid ${borderColor}`,
    borderRight: `1px solid ${borderColor}`,
    borderBottom: `1px solid ${borderColor}`,
    borderTopLeftRadius: 6,
    borderTopRightRadius: 6,
    boxShadow: 'none',
  })

  const cellStyle = (segmentId: string, isLast: boolean): CSSProperties => {
    const active = activeSegmentId === segmentId
    return {
      minHeight: 44,
      padding: '8px 28px',
      background: normalBackground,
      color: themeStyle.text,
      borderLeft: `1px solid ${active ? activeBorder : borderColor}`,
      borderRight: `1px solid ${active ? activeBorder : borderColor}`,
      borderBottom: `1px solid ${borderColor}`,
      fontFamily: "'Noto Serif SC', 'Source Han Serif SC', SimSun, serif",
      fontSize,
      lineHeight,
      whiteSpace: 'pre-wrap',
      overflowWrap: 'break-word',
      textAlign: 'justify',
      outline: 'none',
      borderBottomLeftRadius: isLast ? 6 : 0,
      borderBottomRightRadius: isLast ? 6 : 0,
      boxShadow: active
        ? `inset 4px 0 0 ${activeBorder}, inset 0 0 0 1px ${isDark ? 'rgba(255,210,132,0.44)' : 'rgba(180,105,28,0.38)'}`
        : undefined,
      cursor: 'text',
    }
  }

  const activateSegment = (segmentId: string) => {
    onActiveSegmentChange?.(segmentId)
    const selected = window.getSelection()?.toString()?.trim() || ''
    if (selected) onSelectedTextChange?.(selected)
  }

  const saveUnit = async (unitId: string) => {
    if (!onUpdateUnit) return
    setSavingUnitId(unitId)
    try {
      await onUpdateUnit(unitId, editingText)
      setEditingUnitId('')
      message.success('译文已保存')
    } catch (error) {
      console.error(error)
      message.error('保存译文失败')
    } finally {
      setSavingUnitId('')
    }
  }

  const retryUnit = async (unitId: string) => {
    if (!onRetranslateUnit) return
    setRetryingUnitId(unitId)
    try {
      await onRetranslateUnit(unitId)
    } catch (error) {
      console.error(error)
      message.error('重译失败')
    } finally {
      setRetryingUnitId('')
    }
  }

  return (
    <div style={shellStyle} data-reader-translation-compare="true">
      <div style={gridStyle}>
        <div style={headerStyle()}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
          <span>{pageLabel}</span>
        </div>
        <div style={headerStyle()}>
          <span>{skipped ? '原文对照' : '译文'}</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            {loading ? <Text style={{ color: themeStyle.muted, fontSize: 12 }}>正在翻译...</Text> : null}
            {onClose ? <Button className="reader-translation-close" aria-label="关闭翻译" title="关闭翻译" size="small" type="text" icon={<CloseOutlined />} onClick={onClose} /> : null}
          </span>
        </div>
        {segments.map((segment, index) => {
          const isLast = index === segments.length - 1
          const unit = unitById.get(segment.id)
          const translation = loading
            ? index === 0 ? '正在翻译...' : ''
            : segment.translation
          return (
            <Fragment key={segment.id}>
              <div
                key={`${segment.id}-source`}
                data-parallel-segment-id={segment.id}
                data-parallel-side="source"
                data-active={activeSegmentId === segment.id ? 'true' : undefined}
                onMouseUp={() => activateSegment(segment.id)}
                onClick={() => onActiveSegmentChange?.(segment.id)}
                style={cellStyle(segment.id, isLast)}
              >
                {segment.source || <Text style={{ color: themeStyle.muted }}>本段暂无原文</Text>}
              </div>
              <div
                key={`${segment.id}-translation`}
                data-parallel-segment-id={segment.id}
                data-parallel-side="translation"
                data-active={activeSegmentId === segment.id ? 'true' : undefined}
                onMouseUp={() => activateSegment(segment.id)}
                onClick={() => onActiveSegmentChange?.(segment.id)}
                style={cellStyle(segment.id, isLast)}
              >
                {editingUnitId === segment.id ? (
                  <Space direction="vertical" size={8} style={{ width: '100%' }}>
                    <Input.TextArea
                      autoSize={{ minRows: 3, maxRows: 12 }}
                      value={editingText}
                      onChange={(event) => setEditingText(event.target.value)}
                    />
                    <Space size={6}>
                      <Button
                        size="small"
                        type="primary"
                        icon={<CheckOutlined />}
                        loading={savingUnitId === segment.id}
                        onClick={() => void saveUnit(segment.id)}
                      >
                        保存
                      </Button>
                      <Button size="small" onClick={() => setEditingUnitId('')}>取消</Button>
                    </Space>
                  </Space>
                ) : (
                  <>
                    {unit ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, minHeight: 24 }}>
                        {unit.manualOverride ? <Tag color="gold">人工译文</Tag> : null}
                        {unit.stale ? <Tag color="warning">原文已变化</Tag> : null}
                        {unit.status === 'error' ? <Tag color="error">翻译失败</Tag> : null}
                        <span style={{ flex: 1 }} />
                        {onRetranslateUnit && !unit.skipped ? (
                          <Button
                            type="text"
                            size="small"
                            title="按当前模式重译此块"
                            icon={<ReloadOutlined />}
                            loading={retryingUnitId === segment.id}
                            onClick={() => void retryUnit(segment.id)}
                          />
                        ) : null}
                        {onUpdateUnit && !unit.skipped ? (
                          <Button
                            type="text"
                            size="small"
                            title="编辑译文"
                            icon={<EditOutlined />}
                            onClick={() => {
                              setEditingUnitId(segment.id)
                              setEditingText(translation || '')
                            }}
                          />
                        ) : null}
                      </div>
                    ) : null}
                    {translation
                      ? translation
                      : <Text style={{ color: themeStyle.muted }}>{loading ? '翻译中...' : '待翻译'}</Text>}
                  </>
                )}
              </div>
            </Fragment>
          )
        })}
      </div>
    </div>
  )
}
