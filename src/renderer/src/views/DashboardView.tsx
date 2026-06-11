import { useState, useEffect, useCallback } from 'react'
import { Card, Typography, Progress, Space, Button, Tag, Empty, Statistic, Row, Col, message } from 'antd'
import { ThunderboltOutlined, PauseCircleOutlined, PlayCircleOutlined, CloseCircleOutlined, CheckCircleOutlined, ClockCircleOutlined } from '@ant-design/icons'
import type { BatchProgressEvent } from '@shared/types'

const { Title, Text } = Typography

const STATUS_COLOR: Record<string, string> = {
  pending: 'default',
  running: 'processing',
  paused: 'warning',
  completed: 'success',
  error: 'error',
}

const STATUS_TEXT: Record<string, string> = {
  pending: '等待中',
  running: '处理中',
  paused: '已暂停',
  completed: '已完成',
  error: '出错',
}

function formatTime(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return `${minutes} 分 ${remainder} 秒`
}

export default function DashboardView() {
  const [batchProgress, setBatchProgress] = useState<BatchProgressEvent | null>(null)
  const [stats, setStats] = useState({ total: 0, unstored: 0, processed: 0, error: 0, processing: 0 })
  const [loading, setLoading] = useState(true)

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

  useEffect(() => {
    void loadStats()

    const unsubscribe = window.api.onBatchProgress((data) => {
      setBatchProgress(data)
      if (data.status === 'completed') {
        void loadStats()
      }
    })

    return () => {
      unsubscribe()
    }
  }, [loadStats])

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

      {batchProgress && batchProgress.status !== 'completed' ? (
        <Card
          title={(
            <Space>
              <ThunderboltOutlined />
              <span>当前处理任务</span>
              <Tag color={STATUS_COLOR[batchProgress.status]}>
                {STATUS_TEXT[batchProgress.status] || batchProgress.status}
              </Tag>
            </Space>
          )}
          style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', marginBottom: 24 }}
        >
          <Progress
            percent={Math.round(batchProgress.progress)}
            status={batchProgress.status === 'error' ? 'exception' : batchProgress.status === 'paused' ? 'normal' : 'active'}
            style={{ marginBottom: 16 }}
          />

          <Row gutter={16}>
            <Col span={8}>
              <Text type="secondary">批次进度</Text>
              <div>
                <Text strong>第 {batchProgress.currentBatch} / {batchProgress.totalBatches} 批</Text>
              </div>
            </Col>
            <Col span={8}>
              <Text type="secondary">文献进度</Text>
              <div>
                <Text strong>{batchProgress.processedCount + batchProgress.failedCount} / {batchProgress.totalCount}</Text>
                {batchProgress.failedCount > 0 ? (
                  <Text type="danger" style={{ marginLeft: 8 }}>
                    （失败 {batchProgress.failedCount} 篇）
                  </Text>
                ) : null}
              </div>
            </Col>
            <Col span={8}>
              <Text type="secondary">预计剩余</Text>
              <div>
                <Text strong>{batchProgress.estimatedTime > 0 ? formatTime(batchProgress.estimatedTime) : '计算中...'}</Text>
              </div>
            </Col>
          </Row>

          <div style={{ marginTop: 16, textAlign: 'right' }}>
            <Space>
              {batchProgress.status === 'running' ? (
                <Button icon={<PauseCircleOutlined />} onClick={() => void handlePause()}>暂停</Button>
              ) : null}
              {batchProgress.status === 'paused' ? (
                <Button type="primary" icon={<PlayCircleOutlined />} onClick={() => void handleResume()}>继续</Button>
              ) : null}
              <Button danger icon={<CloseCircleOutlined />} onClick={() => void handleCancel()}>取消</Button>
            </Space>
          </div>
        </Card>
      ) : (
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
              <Text type="secondary">在文献库中选择文献后，可以启动批量 OCR 与 AI 处理。</Text>
            </Empty>
          )}
        </Card>
      )}
    </div>
  )
}
