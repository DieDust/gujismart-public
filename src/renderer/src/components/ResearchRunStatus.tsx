import { useEffect, useState } from 'react'
import { Button, Progress, Space, Typography, message } from 'antd'
import { CopyOutlined } from '@ant-design/icons'
import type { AiResearchTaskStep } from '@shared/types'

export interface ResearchRunFailure { stage: string; message: string }

interface Props {
  planning: boolean
  previewing: boolean
  running: boolean
  reporting: boolean
  startedAt: number | null
  steps: AiResearchTaskStep[]
  failure: ResearchRunFailure | null
  recordCount: number
  completed: boolean
  reportReady: boolean
  pollError: string
  onRetryReport?: () => void
}

export default function ResearchRunStatus(props: Props) {
  const busy = props.planning || props.previewing || props.running || props.reporting
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    setNow(Date.now())
    if (!busy) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [busy, props.startedAt])
  if (!busy && !props.failure && !props.startedAt) return null
  const step = props.steps.find((item) => item.status === 'running' && (props.reporting ? item.step_key === 'report' : item.step_key !== 'report'))
  const title = props.failure ? `${props.failure.stage}失败`
    : props.planning ? '正在生成抽取方案'
      : props.previewing ? '正在检索与统计原文'
        : props.reporting ? '正在生成研究报告'
          : props.running ? step?.title || '正在准备抽取任务'
            : props.completed ? (props.reportReady ? '分析与报告已完成' : '抽取已完成') : '分析准备已结束'
  // Percentages belong to a backend step, never to an invented total duration.
  const percent = (props.running || props.reporting) && !props.planning && step && step.progress > 0 && Number.isFinite(step.progress)
    ? Math.round(Math.max(0, Math.min(1, step.progress)) * 100) : undefined
  const seconds = props.startedAt ? Math.max(0, Math.floor((now - props.startedAt) / 1000)) : 0
  return <section aria-label="研究分析进度" className="research-run-status" style={{ flexShrink: 0, padding: '10px 16px', borderBottom: '1px solid var(--gs-glass-border)', overflowWrap: 'anywhere' }}>
    <Space wrap size={8}>
      <Typography.Text strong type={props.failure ? 'danger' : undefined}>{title}</Typography.Text>
      <Typography.Text type="secondary">已用 {Math.floor(seconds / 60)} 分 {seconds % 60} 秒</Typography.Text>
    </Space>
    {busy && !props.failure && (percent !== undefined
      ? <Progress size="small" percent={percent} status="active" format={(value) => `本阶段 ${value}%`} />
      : <progress aria-label="当前阶段处理中" style={{ display: 'block', width: '100%', height: 6, margin: '8px 0', accentColor: 'var(--gs-accent)' }} />)}
    <div style={{ fontSize: 12, marginTop: 4 }}>
      {props.failure ? <>
        <div>{props.recordCount > 0 ? `已保留 ${props.recordCount} 条抽取记录。` : '本次流程未完成。'}</div>
        <details><summary>错误详情</summary><div style={{ maxHeight: 100, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{props.failure.message}</div></details>
        <Button size="small" icon={<CopyOutlined />} onClick={() => {
          void navigator.clipboard.writeText(`${props.failure?.stage}: ${props.failure?.message}`).then(() => message.success('已复制错误详情')).catch(() => message.error('复制失败'))
        }}>复制错误</Button>
        {props.failure.stage === '生成报告' && props.onRetryReport && <Button size="small" disabled={busy} onClick={props.onRetryReport}>仅重试报告</Button>}
      </> : props.reporting ? `已保存 ${props.recordCount} 条记录。${step?.message || '等待报告返回。'}`
        : props.planning ? '等待聊天模型返回字段方案；暂无法估算剩余时间。'
          : props.previewing ? '正在读取所选范围的检索统计。'
            : props.running ? step?.message || '等待后台返回进度。'
              : props.completed ? `已保存 ${props.recordCount} 条记录。` : '尚未完成抽取。'}
      {props.pollError && <Typography.Text type="warning" style={{ display: 'block' }}>进度读取暂时失败，正在重试：{props.pollError}</Typography.Text>}
    </div>
  </section>
}
