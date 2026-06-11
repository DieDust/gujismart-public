import { useState, useEffect } from 'react'
import { Modal, Button, Input, Space, Typography, Alert, Checkbox, message, Progress } from 'antd'
import { FolderOpenOutlined, LinkOutlined, ScanOutlined, SyncOutlined, FileOutlined } from '@ant-design/icons'
import type { Folder, FolderImportFile } from '@shared/types'

const { Text } = Typography
const DEFAULT_BATCH_SIZE = 5

function delay(ms = 0): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const safeSize = Math.max(1, Math.floor(size || DEFAULT_BATCH_SIZE))
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += safeSize) {
    chunks.push(items.slice(index, index + safeSize))
  }
  return chunks
}

interface FolderLinkDialogProps {
  visible: boolean
  folder: Folder | null
  onClose: () => void
  onSynced?: () => void
}

export default function FolderLinkDialog({ visible, folder, onClose, onSynced }: FolderLinkDialogProps) {
  const [externalPath, setExternalPath] = useState('')
  const [files, setFiles] = useState<FolderImportFile[]>([])
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set())
  const [scanning, setScanning] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncProgress, setSyncProgress] = useState(0)
  const [confirmVisible, setConfirmVisible] = useState(false)

  useEffect(() => {
    if (visible && folder) {
      setExternalPath(folder.external_path || '')
      setFiles([])
      setSelectedFiles(new Set())
      setSyncProgress(0)
      if (folder.external_path) {
        void scanFolder(folder.external_path)
      }
    }
  }, [visible, folder])

  const handleSelectFolder = async () => {
    const path = await window.api.selectExternalFolder()
    if (path) {
      setExternalPath(path)
      void scanFolder(path)
    }
  }

  const scanFolder = async (path: string) => {
    setScanning(true)
    try {
      const fileList = await window.api.scanFolderPath(path)
      setFiles(fileList)
      setSelectedFiles(new Set<string>(fileList.map((item) => String(item.path))))
    } catch (error) {
      console.error(error)
      message.error('扫描文件夹失败')
    } finally {
      setScanning(false)
    }
  }

  const toggleFile = (path: string) => {
    setSelectedFiles((previous) => {
      const next = new Set(previous)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const toggleAll = () => {
    if (selectedFiles.size === files.length) {
      setSelectedFiles(new Set())
    } else {
      setSelectedFiles(new Set(files.map((item) => item.path)))
    }
  }

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  const totalSize = files
    .filter((item) => selectedFiles.has(item.path))
    .reduce((sum, item) => sum + item.size, 0)

  const handleSyncClick = () => {
    if (selectedFiles.size === 0) {
      message.warning('请选择要同步的文件')
      return
    }
    setConfirmVisible(true)
  }

  const handleConfirmSync = async () => {
    if (!folder) return

    setConfirmVisible(false)
    setSyncing(true)
    setSyncProgress(0)

    try {
      await window.api.updateFolder(folder.id, { external_path: externalPath })

      const filePaths = Array.from(selectedFiles)
      const results = await window.api.importDocuments(filePaths, { ocrEngine: 'paddle' })
      const needsOcrIds: string[] = []
      for (let index = 0; index < results.length; index += 1) {
        const result = results[index]
        if (!result.success || !result.id) continue
        await window.api.addDocumentToFolder(result.id, folder.id)
        if (result.sourceType === 'paddle-json' || result.sourceType === 'ebook-text' || result.sourceType === 'duplicate-pdf' || result.sourceType === 'restored-pdf') {
          continue
        }
        needsOcrIds.push(result.id)
      }
      const autoOcrBackground = await window.api.getSetting('auto_ocr_after_import')
      if (autoOcrBackground !== 'false' && needsOcrIds.length > 0) {
        const hasToken = await window.api.checkOcrToken()
        if (hasToken) {
          const rawBatchSize = await window.api.getSetting('batch_size')
          const parsedBatchSize = Number.parseInt(String(rawBatchSize || ''), 10)
          const configuredBatchSize = Number.isFinite(parsedBatchSize) && parsedBatchSize > 0 ? parsedBatchSize : DEFAULT_BATCH_SIZE
          const batchSize = Math.max(1, configuredBatchSize)
          const batches = chunkArray(Array.from(new Set(needsOcrIds)), batchSize)
          void (async () => {
            for (const batch of batches) {
              await window.api.batchOcr(batch, { engine: 'paddle', concurrency: batchSize })
              await delay(0)
            }
          })()
            .then(() => message.success('文件夹同步 OCR 已完成'))
            .catch((error) => {
              console.error(error)
              message.error('文件夹同步 OCR 失败')
            })
        } else {
          message.warning('文件已同步，但未配置 PaddleOCR API Token，请在设置页填写后再批量 OCR。')
        }
      }

      const successCount = results.filter((item) => item.success).length
      const failCount = results.filter((item) => !item.success).length

      setSyncProgress(100)

      if (failCount > 0) {
        message.warning(`同步完成：成功 ${successCount} 个，失败 ${failCount} 个`)
      } else {
        message.success(`成功同步 ${successCount} 个文件`)
      }

      onSynced?.()
      setTimeout(() => onClose(), 1500)
    } catch (error) {
      console.error(error)
      message.error(`同步失败：${(error as Error).message}`)
    } finally {
      setSyncing(false)
    }
  }

  return (
    <>
      <Modal
        title={(
          <Space>
            <LinkOutlined />
            <span>关联外部文件夹</span>
            {folder ? <Text type="secondary">“{folder.name}”</Text> : null}
          </Space>
        )}
        open={visible}
        onCancel={onClose}
        width={640}
        footer={null}
      >
        <div style={{ marginBottom: 16 }}>
          <Space.Compact style={{ width: '100%' }}>
            <Input
              placeholder="选择或输入外部文件夹路径"
              value={externalPath}
              onChange={(event) => setExternalPath(event.target.value)}
              prefix={<FolderOpenOutlined />}
            />
            <Button onClick={() => void handleSelectFolder()}>浏览</Button>
            <Button icon={<ScanOutlined />} onClick={() => void scanFolder(externalPath)} loading={scanning} disabled={!externalPath}>
              扫描
            </Button>
          </Space.Compact>
        </div>

        {files.length > 0 ? (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <Space>
                <Checkbox
                  checked={selectedFiles.size === files.length}
                  indeterminate={selectedFiles.size > 0 && selectedFiles.size < files.length}
                  onChange={toggleAll}
                >
                  全选
                </Checkbox>
                <Text type="secondary">
                  已选 {selectedFiles.size} / {files.length} 个文件，共 {formatSize(totalSize)}
                </Text>
              </Space>
            </div>

            <div style={{ maxHeight: 300, overflow: 'auto', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 6, padding: 8 }}>
              {files.map((file) => (
                <div
                  key={file.path}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    padding: '4px 8px',
                    cursor: 'pointer',
                    borderRadius: 4,
                    background: selectedFiles.has(file.path) ? 'rgba(24,144,255,0.08)' : 'transparent',
                  }}
                  onClick={() => toggleFile(file.path)}
                >
                  <Checkbox checked={selectedFiles.has(file.path)} style={{ marginRight: 8 }} />
                  <FileOutlined style={{ marginRight: 8, color: file.ext === '.pdf' ? '#ff4d4f' : '#1890ff' }} />
                  <Text style={{ flex: 1 }} ellipsis>{file.name}</Text>
                  <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>{formatSize(file.size)}</Text>
                </div>
              ))}
            </div>

            {syncing ? <Progress percent={syncProgress} style={{ marginTop: 16 }} /> : null}

            <div style={{ marginTop: 16, textAlign: 'right' }}>
              <Space>
                <Button onClick={onClose}>取消</Button>
                <Button
                  type="primary"
                  icon={<SyncOutlined />}
                  onClick={handleSyncClick}
                  loading={syncing}
                  disabled={selectedFiles.size === 0}
                >
                  同步选中文件（{selectedFiles.size}）
                </Button>
              </Space>
            </div>
          </>
        ) : null}

        {files.length === 0 && externalPath && !scanning ? (
          <div style={{ textAlign: 'center', padding: 32, color: 'var(--gs-text-tertiary)' }}>
            该文件夹中没有找到受支持的文件（PDF 或图片）。
          </div>
        ) : null}
      </Modal>

      <Modal
        title="同步确认"
        open={confirmVisible}
        onCancel={() => setConfirmVisible(false)}
        onOk={() => void handleConfirmSync()}
        okText="确认同步"
        cancelText="取消"
      >
        <Alert
          message="系统会复制所选文件到软件数据目录，以避免源文件被误删后影响文献库。"
          description={(
            <div style={{ marginTop: 8 }}>
              <div>已选择 <strong>{selectedFiles.size}</strong> 个文件</div>
              <div>总大小 <strong>{formatSize(totalSize)}</strong></div>
              <div style={{ marginTop: 8, color: 'var(--gs-text-tertiary)', fontSize: 12 }}>
                同步后，这些文件会进入文献库，并沿用文库主导入流程；如开启“导入后自动 OCR”，会由文库页统一后台识别。
              </div>
            </div>
          )}
          type="warning"
          showIcon
        />
      </Modal>
    </>
  )
}
