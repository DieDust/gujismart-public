import { useEffect, useMemo, useState } from 'react'
import { Button, Empty, Segmented, Space, Tag } from 'antd'
import type { DocumentPage } from '@shared/types'

type BirdDensity = 'small' | 'medium' | 'large'
type BirdFilter = 'all' | 'ocr_error'

type BirdPageItem = Pick<
  DocumentPage,
  'id' | 'page_num' | 'proof_status' | 'ocr_status' | 'ocr_text' | 'ocr_result' | 'has_ocr_text' | 'needs_layout_attention'
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

function isOcrErrorPage(page: BirdPageItem): boolean {
  return String(page.ocr_status || '').trim() === 'error'
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

/** Compact page list for banner: 3、7-9、12 */
function formatFailedPageList(pageNums: number[]): string {
  const nums = [...new Set(pageNums.filter((n) => Number.isFinite(n) && n > 0))].sort((a, b) => a - b)
  if (nums.length === 0) return ''
  const parts: string[] = []
  let start = nums[0]
  let end = nums[0]
  for (let i = 1; i <= nums.length; i += 1) {
    const current = nums[i]
    if (current === end + 1) {
      end = current
      continue
    }
    parts.push(start === end ? `${start}` : `${start}-${end}`)
    start = current
    end = current
  }
  return parts.join('、')
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
  // Current page still wins for navigation feedback, but keep OCR-error tag visible.
  if (currentPageIndex === pageIndex && !isOcrErrorPage(page)) {
    return {
      label: '当前页',
      borderColor: '#1677ff',
      background: 'rgba(22, 119, 255, 0.18)',
      textColor: '#91caff',
      tagColor: 'blue',
    }
  }

  if (isOcrErrorPage(page)) {
    return {
      label: currentPageIndex === pageIndex ? '当前·OCR失败' : 'OCR失败',
      borderColor: '#ff4d4f',
      background: 'rgba(255, 77, 79, 0.16)',
      textColor: '#ffccc7',
      tagColor: 'error',
    }
  }

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
  const [filter, setFilter] = useState<BirdFilter>('all')

  const ocrErrorEntries = useMemo(
    () => pages
      .map((page, pageIndex) => ({ page, pageIndex }))
      .filter(({ page }) => isOcrErrorPage(page)),
    [pages],
  )
  const ocrErrorPageNums = useMemo(
    () => ocrErrorEntries.map(({ page }) => Number(page.page_num || 0)).filter((n) => n > 0),
    [ocrErrorEntries],
  )
  const ocrErrorPageList = useMemo(() => formatFailedPageList(ocrErrorPageNums), [ocrErrorPageNums])

  const filteredEntries = useMemo(() => {
    if (filter === 'ocr_error') return ocrErrorEntries
    return pages.map((page, pageIndex) => ({ page, pageIndex }))
  }, [filter, ocrErrorEntries, pages])

  useEffect(() => {
    if (filter === 'ocr_error') {
      setWindowIndex(0)
      return
    }
    setWindowIndex(Math.floor(currentPageIndex / densityMeta.batchSize))
  }, [currentPageIndex, densityMeta.batchSize, filter])

  const totalWindows = Math.max(1, Math.ceil(filteredEntries.length / densityMeta.batchSize))
  const startIndex = windowIndex * densityMeta.batchSize
  const endIndex = Math.min(filteredEntries.length, startIndex + densityMeta.batchSize)

  const visiblePages = useMemo(
    () => filteredEntries.slice(startIndex, endIndex),
    [endIndex, filteredEntries, startIndex],
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
          {ocrErrorEntries.length > 0 ? (
            <Segmented
              size="small"
              value={filter}
              onChange={(value) => setFilter(value as BirdFilter)}
              options={[
                { value: 'all', label: '全部' },
                { value: 'ocr_error', label: `OCR失败 ${ocrErrorEntries.length}` },
              ]}
            />
          ) : null}
        </Space>

        <Space size={4} wrap>
          <Button size="small" disabled={windowIndex <= 0} onClick={() => setWindowIndex((value) => Math.max(0, value - 1))}>
            上一组
          </Button>
          <span style={{ fontSize: 12, color: 'var(--gs-text-secondary)' }}>
            {filteredEntries.length === 0
              ? '0'
              : `${startIndex + 1}-${endIndex} / ${filteredEntries.length}`}
          </span>
          <Button size="small" disabled={windowIndex >= totalWindows - 1} onClick={() => setWindowIndex((value) => Math.min(totalWindows - 1, value + 1))}>
            下一组
          </Button>
        </Space>
      </div>

      {ocrErrorEntries.length > 0 ? (
        <div
          style={{
            flexShrink: 0,
            margin: '8px 12px 0',
            padding: '8px 10px',
            borderRadius: 8,
            background: 'rgba(255, 77, 79, 0.10)',
            border: '1px solid rgba(255, 77, 79, 0.28)',
            color: '#ffccc7',
            fontSize: 12,
            lineHeight: 1.55,
          }}
        >
          <div style={{ marginBottom: 6, fontWeight: 500 }}>
            OCR完成，第 {ocrErrorPageList || '?'} 页 OCR 未成功（共 {ocrErrorEntries.length} 页，点页码跳转）
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {ocrErrorEntries.map(({ page, pageIndex }) => (
              <Button
                key={page.id}
                size="small"
                danger
                type={currentPageIndex === pageIndex ? 'primary' : 'default'}
                onClick={() => onSelectPage(pageIndex)}
                style={{ height: 24, paddingInline: 8, fontSize: 12 }}
              >
                第 {page.page_num || pageIndex + 1} 页
              </Button>
            ))}
          </div>
        </div>
      ) : null}

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
        {visiblePages.length === 0 ? (
          <Empty description={filter === 'ocr_error' ? '没有 OCR 失败页' : '暂无页面'} style={{ gridColumn: '1 / -1', marginTop: 32 }} />
        ) : visiblePages.map(({ page, pageIndex }) => {
          const state = getPageState(page, currentPageIndex, pageIndex)
          const hasOcr = typeof page.has_ocr_text === 'boolean'
            ? page.has_ocr_text
            : !!String(page.ocr_text || '').trim()
          const preview = String(page.ocr_text || '').trim().replace(/\s+/g, ' ').slice(0, 80)
          const ocrFailed = isOcrErrorPage(page)

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
                  <Tag color={ocrFailed ? 'error' : hasOcr ? 'processing' : 'default'} style={{ width: 'fit-content', margin: 0 }}>
                    {ocrFailed ? 'OCR 未成功' : hasOcr ? '有 OCR' : '无 OCR'}
                  </Tag>

                  <div
                    style={{
                      flex: 1,
                      minHeight: 0,
                      overflow: 'hidden',
                      color: ocrFailed ? state.textColor : hasOcr ? 'var(--gs-text-secondary)' : state.textColor,
                      fontSize: 12,
                      lineHeight: 1.6,
                      whiteSpace: 'normal',
                    }}
                  >
                    {ocrFailed
                      ? '本页识别失败，可打开后单独重试 OCR'
                      : hasOcr
                        ? preview || '本页已有 OCR 文本'
                        : '本页还没有可用 OCR 文本'}
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
