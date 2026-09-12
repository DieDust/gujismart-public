import { useEffect, useState } from 'react'
import { Alert, Button, Drawer, Empty, List, Progress, Select, Space, Spin, Tag, Typography } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import type { AiResearchTask, AiResearchTaskStep } from '@shared/types'
import { getErrorMessage } from '@shared/errors'

interface Props {
  open: boolean
  onClose: () => void
  onResult: (datasetId: string) => void
}

const STATUS: Record<string, string> = { draft: '未开始', running: '进行中', completed: '已完成', error: '失败' }

export default function ResearchTaskHistory({ open, onClose, onResult }: Props) {
  const [tasks, setTasks] = useState<AiResearchTask[]>([])
  const [taskId, setTaskId] = useState<string>()
  const [steps, setSteps] = useState<AiResearchTaskStep[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    if (!open) return
    let active = true
    let timer: ReturnType<typeof setTimeout>
    setLoading(true)
    setSteps([])
    const refresh = async () => {
      try {
        const items = await window.api.listAiResearchTasks()
        const selectedId = items.some((item) => item.id === taskId) ? taskId : items[0]?.id
        const detail = selectedId ? await window.api.listAiResearchTaskSteps(selectedId) : []
        if (!active) return
        setTasks(items)
        setTaskId(selectedId)
        setSteps(detail)
        setError('')
      } catch (reason: unknown) {
        if (active) setError(getErrorMessage(reason, '读取分析记录失败'))
      } finally {
        if (active) {
          setLoading(false)
          // Reports can start after extraction has completed, so keep polling while open.
          timer = setTimeout(() => void refresh(), 3000)
        }
      }
    }
    void refresh()
    return () => { active = false; clearTimeout(timer) }
  }, [open, taskId, revision])

  const task = tasks.find((item) => item.id === taskId)
  const failedSteps = steps.filter((step) => step.status === 'error')
  return <Drawer title="分析记录" open={open} onClose={onClose} width={520}
    extra={<Button aria-label="刷新分析记录" icon={<ReloadOutlined />} onClick={() => setRevision((value) => value + 1)} />}>
    {error && <Alert showIcon type="error" message={error} />}
    <Spin spinning={loading}>
      <Select aria-label="选择分析任务" style={{ width: '100%', marginBottom: 16 }} showSearch optionFilterProp="label"
        value={taskId} onChange={setTaskId} placeholder="选择分析任务"
        options={tasks.map((item) => ({ value: item.id, label: `${item.created_at} · ${item.title || item.goal}` }))} />
      {!task ? <Empty description="暂无分析记录" /> : <>
        <Typography.Paragraph>{task.goal}</Typography.Paragraph>
        <Space wrap style={{ marginBottom: 16 }}>
          <Tag color={task.status === 'error' ? 'error' : task.status === 'completed' ? 'success' : 'processing'}>
            抽取：{STATUS[task.status] || task.status}
          </Tag>
          <Typography.Text>{task.record_count || 0} 条已保存材料</Typography.Text>
          {task.dataset_id && <Button onClick={() => { onResult(task.dataset_id as string); onClose() }}>查看材料</Button>}
        </Space>
        {task.error_message && <Alert showIcon type="error" message="抽取失败"
          description={<Typography.Paragraph copyable style={{ whiteSpace: 'pre-wrap' }}>{task.error_message}</Typography.Paragraph>} />}
        {failedSteps.map((step) => <Alert key={step.id} showIcon type="error" message={`${step.title}失败`}
          description={<Typography.Paragraph copyable style={{ whiteSpace: 'pre-wrap' }}>{step.message}</Typography.Paragraph>} />)}
        <List dataSource={steps} locale={{ emptyText: '此任务没有保存步骤记录' }} renderItem={(step) => <List.Item>
          <div style={{ width: '100%', overflowWrap: 'anywhere' }}>
            <Space wrap><Typography.Text strong>{step.title}</Typography.Text><Tag>{STATUS[step.status] || step.status}</Tag></Space>
            <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', marginBlock: 8 }}>{step.message}</Typography.Paragraph>
            {step.status === 'running' && <Progress percent={Math.min(99, Math.max(0, Math.round(step.progress * 100)))} status="active" />}
          </div>
        </List.Item>} />
        {!steps.some((step) => step.step_key === 'report') && <Typography.Text type="secondary">没有保存报告阶段记录，无法据此判断报告是否生成成功。</Typography.Text>}
      </>}
    </Spin>
  </Drawer>
}
