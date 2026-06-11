import { useEffect, useMemo, useState } from 'react'
import { Button, Empty, Segmented, Space, Tag } from 'antd'
import type { DocumentPage } from '@shared/types'

type BirdDensity = 'small' | 'medium' | 'large'

type BirdPageItem = Pick<
  DocumentPage,
  'id' | 'page_num' | 'proof_status' | 'ocr_text' | 'ocr_result' | 'has_ocr_text' | 'needs_layout_attention'
>

interface PageBirdseyeGridProps {
  pages: BirdPageItem[]
  currentPageIndex: number
  density: BirdDensity
  onDensityChange: (density: BirdDensity) => void
  onSelectPage: (pageIndex: number) => void
}

const DENSITY_META: Record<BirdDensity, { label: string; minWidth: number; minHeight: number; batchSize: number }> = {
  small: { label: '小', minWidth: 120, minHeight: 120, batchSize: 120 },
  medium: { label: '中', minWidth: 160, minHeight: 150, batchSize: 72 },
  large: { label: '大', minWidth: 220, minHeight: 190, batchSize: 42 },
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function pageNeedsLayoutAttention(page: BirdPageItem): boolean {
  if (typeof page.needs_layout_attention === 'boolean') return page.needs_layout_attention
  if (!page.ocr_result) return false

  try {
    const parsed = typeof page.ocr_result === 'string' ? JSON.parse(page.ocr_result) as unknown : page.ocr_result
    if (!isRecord(parsed)) return false
    const layoutBlocks = Array.isArray(parsed.layout_result) ? parsed.layout_result : []
    return layoutBlocks.some((block) => isRecord(block) && !!block.needs_enhancement)
  } catch {
    return false
  }
}

function getPageState(
  page: BirdPageItem,
  currentPageIndex: number,
  pageIndex: number,
): {
  label: string
  borderColor: string
  background: string
  textColor: string
  tagColor: string
} {
  if (currentPageIndex === pageIndex) {
    return {
      label: '当前页',
      borderColor: '#1677ff',
      background: 'rgba(22, 119, 255, 0.18)',
      textColor: '#91caff',
      tagColor: 'blue',
    }
  }

  if (pageNeedsLayoutAttention(page)) {
    return {
      label: '版面待修正',
      borderColor: '#fa8c16',
      background: 'rgba(250, 140, 22, 0.16)',
      textColor: '#ffd591',
      tagColor: 'orange',
    }
  }

  if (page.proof_status === 'completed') {
    return {
      label: '已校对',
      borderColor: '#d4b106',
      background: 'rgba(250, 219, 20, 0.18)',
      textColor: '#ffe58f',
      tagColor: 'gold',
    }
  }

  return {
    label: '未校对',
    borderColor: 'rgba(255,255,255,0.16)',
    background: 'rgba(255,255,255,0.03)',
    textColor: 'rgba(255,255,255,0.65)',
    tagColor: 'default',
  }
}

export default function PageBirdseyeGrid({
  pages,
  currentPageIndex,
  density,
  onDensityChange,
  onSelectPage,
}: PageBirdseyeGridProps) {
  const densityMeta = DENSITY_META[density]
  const [windowIndex, setWindowIndex] = useState(0)

  useEffect(() => {
    setWindowIndex(Math.floor(currentPageIndex / densityMeta.batchSize))
  }, [currentPageIndex, densityMeta.batchSize])

  const totalWindows = Math.max(1, Math.ceil(pages.length / densityMeta.batchSize))
  const startIndex = windowIndex * densityMeta.batchSize
  const endIndex = Math.min(pages.length, startIndex + densityMeta.batchSize)

  const visiblePages = useMemo(
    () => pages.slice(startIndex, endIndex).map((page, offset) => ({ page, pageIndex: startIndex + offset })),
    [endIndex, pages, startIndex],
  )

  if (pages.length === 0) {
    return <Empty description="暂无页面" style={{ marginTop: 48 }} />
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '8px 12px',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          flexShrink: 0,
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <Space size={8} wrap>
          <span style={{ color: 'var(--gs-text-primary)', fontWeight: 500 }}>鸟瞰页</span>
          <Segmented
            size="small"
            value={density}
            onChange={(value) => onDensityChange(value as BirdDensity)}
            options={[
              { value: 'small', label: DENSITY_META.small.label },
              { value: 'medium', label: DENSITY_META.medium.label },
              { value: 'large', label: DENSITY_META.large.label },
            ]}
          />
        </Space>

        <Space size={4} wrap>
          <Button size="small" disabled={windowIndex <= 0} onClick={() => setWindowIndex((value) => Math.max(0, value - 1))}>
            上一组
          </Button>
          <span style={{ fontSize: 12, color: 'var(--gs-text-secondary)' }}>
            {startIndex + 1}-{endIndex} / {pages.length}
          </span>
          <Button size="small" disabled={windowIndex >= totalWindows - 1} onClick={() => setWindowIndex((value) => Math.min(totalWindows - 1, value + 1))}>
            下一组
          </Button>
        </Space>
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: 12,
          display: 'grid',
          gridTemplateColumns: `repeat(auto-fill, minmax(${densityMeta.minWidth}px, 1fr))`,
          gap: 12,
          alignContent: 'start',
        }}
      >
        {visiblePages.map(({ page, pageIndex }) => {
          const state = getPageState(page, currentPageIndex, pageIndex)
          const hasOcr = typeof page.has_ocr_text === 'boolean'
            ? page.has_ocr_text
            : !!String(page.ocr_text || '').trim()
          const preview = String(page.ocr_text || '').trim().replace(/\s+/g, ' ').slice(0, 80)

          return (
            <Button
              key={page.id}
              type="text"
              onClick={() => onSelectPage(pageIndex)}
              style={{
                height: densityMeta.minHeight,
                borderRadius: 10,
                border: `1px solid ${state.borderColor}`,
                background: state.background,
                padding: 0,
                overflow: 'hidden',
                textAlign: 'left',
              }}
            >
              <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
                <div
                  style={{
                    padding: '8px 10px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    borderBottom: '1px solid rgba(255,255,255,0.06)',
                  }}
                >
                  <strong style={{ color: 'var(--gs-text-primary)', fontSize: 13 }}>第 {page.page_num} 页</strong>
                  <Tag color={state.tagColor} style={{ margin: 0 }}>
                    {state.label}
                  </Tag>
                </div>

                <div
                  style={{
                    flex: 1,
                    padding: '10px 10px 8px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                    minHeight: 0,
                  }}
                >
                  <Tag color={hasOcr ? 'processing' : 'default'} style={{ width: 'fit-content', margin: 0 }}>
                    {hasOcr ? '有 OCR' : '无 OCR'}
                  </Tag>

                  <div
                    style={{
                      flex: 1,
                      minHeight: 0,
                      overflow: 'hidden',
                      color: hasOcr ? 'var(--gs-text-secondary)' : state.textColor,
                      fontSize: 12,
                      lineHeight: 1.6,
                      whiteSpace: 'normal',
                    }}
                  >
                    {hasOcr ? preview || '本页已有 OCR 文本' : '本页还没有可用 OCR 文本'}
                  </div>
                </div>
              </div>
            </Button>
          )
        })}
      </div>
    </div>
  )
}
