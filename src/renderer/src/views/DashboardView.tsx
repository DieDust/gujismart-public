import { useState, useEffect, useCallback } from 'react'
import { Card, Typography, Progress, Space, Button, Tag, Empty, Statistic, Row, Col, message } from 'antd'
import { ThunderboltOutlined, PauseCircleOutlined, PlayCircleOutlined, CloseCircleOutlined, CheckCircleOutlined, ClockCircleOutlined } from '@ant-design/icons'
import type { BatchProgressEvent, EmbeddingProgressEvent } from '@shared/types'

const { Title, Text } = Typography

const STATUS_COLOR: Record<string, string> = {
  pending: 'default',
  running: 'processing',
  paused: 'warning',
  completed: 'success',
  error: 'error',
  queued: 'warning',
  processing: 'processing',
  idle: 'default',
  ready: 'success',
}

const STATUS_TEXT: Record<string, string> = {
  pending: '等待中',
  running: '处理中',
  paused: '已暂停',
  completed: '已完成',
  error: '出错',
  queued: '排队中',
  processing: '向量化中',
  idle: '空闲',
  ready: '已完成',
}

function formatTime(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return `${minutes} 分 ${remainder} 秒`
}

function isEmbeddingQueueActive(progress: EmbeddingProgressEvent | null): boolean {
  if (!progress) return false
  if (progress.queuePaused && (progress.queueQueued > 0 || progress.queueProcessing > 0)) return true
  return progress.queueQueued > 0 || progress.queueProcessing > 0 || progress.status === 'queued' || progress.status === 'processing'
}

export default function DashboardView() {
  const [batchProgress, setBatchProgress] = useState<BatchProgressEvent | null>(null)
  const [embeddingProgress, setEmbeddingProgress] = useState<EmbeddingProgressEvent | null>(null)
  const [stats, setStats] = useState({ total: 0, unstored: 0, processed: 0, error: 0, processing: 0 })
  const [loading, setLoading] = useState(true)
  const [embeddingBusy, setEmbeddingBusy] = useState(false)

  const loadStats = useCallback(async () => {
    try {
      const docs = await window.api.listDocuments({})
      const total = docs.length
      const unstored = docs.filter((item) => item.import_status === 'unstored').length
      const processed = docs.filter((item) => item.import_status === 'processed').length
      const error = docs.filter((item) => item.import_status === 'error').length
      const processing = docs.filter((item) => item.import_status === 'processing').length
      setStats({ total, unstored, processed, error, processing })
    } catch (error) {
      console.error(error)
    } finally {
      setLoading(false)
    }
  }, [])

  const loadEmbeddingSnapshot = useCallback(async () => {
    try {
      const snapshot = await window.api.getEmbeddingProgressSnapshot()
      setEmbeddingProgress(snapshot)
    } catch (error) {
      console.warn('[Dashboard] load embedding snapshot failed', error)
    }
  }, [])

  useEffect(() => {
    void loadStats()
    void loadEmbeddingSnapshot()

    const unsubscribeBatch = window.api.onBatchProgress((data) => {
      setBatchProgress(data)
      if (data.status === 'completed') {
        void loadStats()
      }
    })

    const unsubscribeEmbedding = window.api.onEmbeddingProgress((data) => {
      setEmbeddingProgress(data)
    })

    const unsubscribeBackground = window.api.onBackgroundTaskStatusChanged((event) => {
      if (event.kind !== 'embedding-index') return
      // Keep snapshot in sync when only background task events arrive.
      void loadEmbeddingSnapshot()
    })

    return () => {
      unsubscribeBatch()
      unsubscribeEmbedding()
      unsubscribeBackground()
    }
  }, [loadEmbeddingSnapshot, loadStats])

  const handlePause = async () => {
    if (!batchProgress) return
    await window.api.pauseBatch(batchProgress.jobId)
    message.info('已暂停处理')
  }

  const handleResume = async () => {
    if (!batchProgress) return
    await window.api.resumeBatch(batchProgress.jobId)
    message.info('已恢复处理')
  }

  const handleCancel = async () => {
    if (!batchProgress) return
    await window.api.cancelBatch(batchProgress.jobId)
    setBatchProgress(null)
    message.info('已取消处理')
  }

  const handleEmbeddingPause = async () => {
    setEmbeddingBusy(true)
    try {
      const statsNext = await window.api.setEmbeddingQueuePaused(true)
      setEmbeddingProgress((current) => current ? {
        ...current,
        queuePaused: true,
        queueQueued: statsNext.docsQueued,
        queueProcessing: statsNext.docsProcessing,
        queueReady: statsNext.docsReady,
        queueError: statsNext.docsError,
        message: statsNext.message || '向量化队列已暂停',
      } : current)
      message.info('已暂停向量化队列')
    } catch (error) {
      message.error(error instanceof Error ? error.message : '暂停向量化失败')
    } finally {
      setEmbeddingBusy(false)
    }
  }

  const handleEmbeddingResume = async () => {
    setEmbeddingBusy(true)
    try {
      const statsNext = await window.api.setEmbeddingQueuePaused(false)
      setEmbeddingProgress((current) => current ? {
        ...current,
        queuePaused: false,
        queueQueued: statsNext.docsQueued,
        queueProcessing: statsNext.docsProcessing,
        queueReady: statsNext.docsReady,
        queueError: statsNext.docsError,
        message: statsNext.message || '向量化队列已继续',
      } : current)
      message.success('已继续向量化队列')
    } catch (error) {
      message.error(error instanceof Error ? error.message : '继续向量化失败')
    } finally {
      setEmbeddingBusy(false)
    }
  }

  const embeddingActive = isEmbeddingQueueActive(embeddingProgress)
  const sessionTotal = Math.max(
    1,
    Number(embeddingProgress?.sessionTotal || 0),
    Number(embeddingProgress?.queueQueued || 0)
      + Number(embeddingProgress?.queueProcessing || 0)
      + Number(embeddingProgress?.sessionCompleted || 0)
      + Number(embeddingProgress?.sessionFailed || 0),
  )
  const sessionDone = Number(embeddingProgress?.sessionCompleted || 0) + Number(embeddingProgress?.sessionFailed || 0)
  const embeddingPercent = embeddingProgress?.queuePaused
    ? Math.round((sessionDone / sessionTotal) * 100)
    : embeddingProgress?.status === 'idle' && !embeddingActive
      ? 100
      : Math.max(
        Math.round((sessionDone / sessionTotal) * 100),
        embeddingProgress?.status === 'processing' ? Number(embeddingProgress.progress || 0) : 0,
      )
  const batchActive = Boolean(batchProgress && batchProgress.status !== 'completed')
  const hasAnyTask = batchActive || embeddingActive || batchProgress?.status === 'completed'

  return (
    <div style={{ padding: '24px 32px', height: '100%', overflow: 'auto' }}>
      <Title level={3} style={{ color: 'var(--gs-gold)', marginBottom: 24 }}>
        处理队列
      </Title>

      <Row gutter={16} style={{ marginBottom: 24 }}>
        <Col span={6}>
          <Card size="small" loading={loading} style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <Statistic title="全部文献" value={stats.total} valueStyle={{ color: 'var(--gs-text-primary)' }} />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small" loading={loading} style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <Statistic title="未入库" value={stats.unstored} valueStyle={{ color: '#faad14' }} />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small" loading={loading} style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <Statistic title="已处理" value={stats.processed} valueStyle={{ color: '#52c41a' }} />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small" loading={loading} style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <Statistic title="处理失败" value={stats.error} valueStyle={{ color: '#ff4d4f' }} />
          </Card>
        </Col>
      </Row>

      {batchActive ? (
        <Card
          title={(
            <Space>
              <ThunderboltOutlined />
              <span>当前批量 OCR / AI 任务</span>
              <Tag color={STATUS_COLOR[batchProgress!.status]}>
                {STATUS_TEXT[batchProgress!.status] || batchProgress!.status}
              </Tag>
            </Space>
          )}
          style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', marginBottom: 24 }}
        >
          <Progress
            percent={Math.round(batchProgress!.progress)}
            status={batchProgress!.status === 'error' ? 'exception' : batchProgress!.status === 'paused' ? 'normal' : 'active'}
            style={{ marginBottom: 16 }}
          />

          <Row gutter={16}>
            <Col span={8}>
              <Text type="secondary">批次进度</Text>
              <div>
                <Text strong>第 {batchProgress!.currentBatch} / {batchProgress!.totalBatches} 批</Text>
              </div>
            </Col>
            <Col span={8}>
              <Text type="secondary">文献进度</Text>
              <div>
                <Text strong>{batchProgress!.processedCount + batchProgress!.failedCount} / {batchProgress!.totalCount}</Text>
                {batchProgress!.failedCount > 0 ? (
                  <Text type="danger" style={{ marginLeft: 8 }}>
                    （失败 {batchProgress!.failedCount} 篇）
                  </Text>
                ) : null}
              </div>
            </Col>
            <Col span={8}>
              <Text type="secondary">预计剩余</Text>
              <div>
                <Text strong>{batchProgress!.estimatedTime > 0 ? formatTime(batchProgress!.estimatedTime) : '计算中...'}</Text>
              </div>
            </Col>
          </Row>

          <div style={{ marginTop: 16, textAlign: 'right' }}>
            <Space>
              {batchProgress!.status === 'running' ? (
                <Button icon={<PauseCircleOutlined />} onClick={() => void handlePause()}>暂停</Button>
              ) : null}
              {batchProgress!.status === 'paused' ? (
                <Button type="primary" icon={<PlayCircleOutlined />} onClick={() => void handleResume()}>继续</Button>
              ) : null}
              <Button danger icon={<CloseCircleOutlined />} onClick={() => void handleCancel()}>取消</Button>
            </Space>
          </div>
        </Card>
      ) : null}

      {embeddingActive || (embeddingProgress && (embeddingProgress.sessionCompleted > 0 || embeddingProgress.sessionFailed > 0) && embeddingProgress.status !== 'idle') ? (
        <Card
          title={(
            <Space>
              <ThunderboltOutlined />
              <span>向量化任务</span>
              <Tag color={
                embeddingProgress?.queuePaused
                  ? 'warning'
                  : embeddingProgress?.status === 'error'
                    ? 'error'
                    : embeddingActive
                      ? 'processing'
                      : 'success'
              }
              >
                {embeddingProgress?.queuePaused
                  ? '已暂停'
                  : STATUS_TEXT[embeddingProgress?.status || 'processing'] || '向量化中'}
              </Tag>
            </Space>
          )}
          style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', marginBottom: 24 }}
        >
          <Progress
            percent={Math.max(0, Math.min(100, embeddingPercent))}
            status={
              embeddingProgress?.status === 'error'
                ? 'exception'
                : embeddingProgress?.queuePaused
                  ? 'normal'
                  : embeddingActive
                    ? 'active'
                    : 'success'
            }
            style={{ marginBottom: 16 }}
          />

          <Row gutter={16}>
            <Col span={8}>
              <Text type="secondary">本轮文献</Text>
              <div>
                <Text strong>
                  {sessionDone} / {sessionTotal}
                </Text>
                {Number(embeddingProgress?.sessionFailed || 0) > 0 ? (
                  <Text type="danger" style={{ marginLeft: 8 }}>
                    （失败 {embeddingProgress?.sessionFailed} 篇）
                  </Text>
                ) : null}
              </div>
            </Col>
            <Col span={8}>
              <Text type="secondary">队列状态</Text>
              <div>
                <Text strong>
                  处理中 {embeddingProgress?.queueProcessing || 0}
                  {' · '}
                  排队 {embeddingProgress?.queueQueued || 0}
                </Text>
              </div>
            </Col>
            <Col span={8}>
              <Text type="secondary">索引累计</Text>
              <div>
                <Text strong>
                  已就绪 {embeddingProgress?.queueReady || 0}
                  {' · '}
                  失败 {embeddingProgress?.queueError || 0}
                </Text>
              </div>
            </Col>
          </Row>

          {embeddingProgress?.message ? (
            <div style={{ marginTop: 12 }}>
              <Text type="secondary">{embeddingProgress.message}</Text>
            </div>
          ) : null}

          <div style={{ marginTop: 16, textAlign: 'right' }}>
            <Space>
              {embeddingProgress?.queuePaused ? (
                <Button
                  type="primary"
                  loading={embeddingBusy}
                  icon={<PlayCircleOutlined />}
                  onClick={() => void handleEmbeddingResume()}
                >
                  继续向量化
                </Button>
              ) : embeddingActive ? (
                <Button
                  loading={embeddingBusy}
                  icon={<PauseCircleOutlined />}
                  onClick={() => void handleEmbeddingPause()}
                >
                  暂停向量化
                </Button>
              ) : null}
            </Space>
          </div>
        </Card>
      ) : null}

      {!hasAnyTask && !embeddingActive ? (
        <Card style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', marginBottom: 24 }}>
          {batchProgress?.status === 'completed' ? (
            <div style={{ textAlign: 'center', padding: 24 }}>
              <CheckCircleOutlined style={{ fontSize: 48, color: '#52c41a', marginBottom: 16 }} />
              <div>
                <Text strong style={{ fontSize: 16, color: 'var(--gs-text-primary)' }}>处理完成</Text>
              </div>
              <div style={{ marginTop: 8 }}>
                <Text type="secondary">
                  成功 {batchProgress.processedCount} 篇
                  {batchProgress.failedCount > 0 ? `，失败 ${batchProgress.failedCount} 篇` : ''}
                </Text>
              </div>
            </div>
          ) : (
            <Empty description="暂无处理任务" image={<ClockCircleOutlined style={{ fontSize: 48, opacity: 0.15 }} />}>
              <Text type="secondary">在文献库中选择文献后，可以启动批量 OCR、AI 处理或向量化。</Text>
            </Empty>
          )}
        </Card>
      ) : null}

      {batchProgress?.status === 'completed' && !batchActive ? (
        <Card style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', marginBottom: 24 }}>
          <div style={{ textAlign: 'center', padding: 16 }}>
            <CheckCircleOutlined style={{ fontSize: 36, color: '#52c41a', marginBottom: 12 }} />
            <div>
              <Text strong style={{ color: 'var(--gs-text-primary)' }}>批量 OCR / AI 已完成</Text>
            </div>
            <div style={{ marginTop: 6 }}>
              <Text type="secondary">
                成功 {batchProgress.processedCount} 篇
                {batchProgress.failedCount > 0 ? `，失败 ${batchProgress.failedCount} 篇` : ''}
              </Text>
            </div>
          </div>
        </Card>
      ) : null}
    </div>
  )
}
