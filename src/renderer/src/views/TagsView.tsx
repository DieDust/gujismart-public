import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Empty, Input, Modal, Space, Spin, Tag, Tooltip, Typography, message } from 'antd'
import {
  CheckSquareOutlined,
  CloseOutlined,
  DeleteOutlined,
  EditOutlined,
  FileAddOutlined,
  PlusOutlined,
  SearchOutlined,
} from '@ant-design/icons'
import type { DocumentListItem, Tag as SharedTag } from '@shared/types'
import { sameStringArray, useDragMultiSelect } from '../utils/dragMultiSelect'
import { LIBRARY_RELATIONS_CHANGED_EVENT } from '../utils/libraryEvents'

const { Title, Text } = Typography

type TagItem = SharedTag
type DocumentOption = Pick<DocumentListItem, 'id' | 'title' | 'author' | 'doc_type' | 'tag_ids'>

interface TagsViewProps {
  onOpenTag?: (tagId: string) => void
}

const presetColors = ['#faad14', '#f5222d', '#fa8c16', '#52c41a', '#13c2c2', '#1890ff', '#2f54eb', '#722ed1', '#eb2f96']

type TagSemanticKind = 'manual' | 'docType' | 'responsibility' | 'carrier' | 'publication' | 'subject' | 'other'

const TAG_KIND_META: Record<TagSemanticKind, { label: string; order: number; color: string }> = {
  manual: { label: '自建标签', order: 0, color: '#faad14' },
  docType: { label: '文献类型', order: 1, color: '#1890ff' },
  responsibility: { label: '责任者', order: 2, color: '#f5222d' },
  carrier: { label: '载体与出处', order: 3, color: '#2f54eb' },
  publication: { label: '出版与版本', order: 4, color: '#722ed1' },
  subject: { label: '主题关键词', order: 5, color: '#52c41a' },
  other: { label: '其他标签', order: 6, color: '#13c2c2' }
}

function normalizeColor(color?: string | null): string {
  return (color || '').trim().toLowerCase()
}

function getTagKind(tag: TagItem): TagSemanticKind {
  const source = tag.source || ''
  if (source === 'manual') return 'manual'
  if (source === '_doc_type' || source === 'doc_type') return 'docType'
  if (['author', 'editor', 'translator'].includes(source)) return 'responsibility'
  if (['journal', 'newspaper', 'collection', 'book_title', 'meeting_name', 'university'].includes(source)) return 'carrier'
  if (['publisher', 'publish_place', 'publication_time', 'publication_year', 'issue_date', 'engraving_style', 'dynasty', 'version'].includes(source)) return 'publication'
  if (source === 'keywords') return 'subject'

  const color = normalizeColor(tag.color)
  if (color === normalizeColor(TAG_KIND_META.docType.color)) return 'docType'
  if (color === normalizeColor(TAG_KIND_META.responsibility.color)) return 'responsibility'
  if (color === normalizeColor(TAG_KIND_META.carrier.color)) return 'carrier'
  if (color === normalizeColor(TAG_KIND_META.subject.color)) return 'subject'
  if (color === normalizeColor(TAG_KIND_META.publication.color)) return 'publication'
  return 'other'
}

function truncateLabel(value: string, maxLength = 22): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value
}

function getTooltipTitle(value: string, maxLength: number): string | undefined {
  return value.length > maxLength ? value : undefined
}

function splitPipe(value?: string | null): string[] {
  return value ? value.split('|').map((item) => item.trim()).filter(Boolean) : []
}

function isTagItem(value: TagItem | undefined): value is TagItem {
  return !!value
}

export default function TagsView({ onOpenTag }: TagsViewProps) {
  const tagListRef = useRef<HTMLDivElement | null>(null)
  const documentPickerListRef = useRef<HTMLDivElement | null>(null)
  const suppressTagClickRef = useRef(false)
  const suppressDocumentClickRef = useRef(false)
  const [tags, setTags] = useState<TagItem[]>([])
  const [loading, setLoading] = useState(true)
  const [keyword, setKeyword] = useState('')
  const [batchMode, setBatchMode] = useState(false)
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([])
  const [showNewTag, setShowNewTag] = useState(false)
  const [newTagName, setNewTagName] = useState('')
  const [newTagColor, setNewTagColor] = useState('#faad14')
  const [editingTagId, setEditingTagId] = useState<string | null>(null)
  const [editingTagName, setEditingTagName] = useState('')
  const [editingTagColor, setEditingTagColor] = useState('#faad14')
  const [documentPickerOpen, setDocumentPickerOpen] = useState(false)
  const [documentPickerTagIds, setDocumentPickerTagIds] = useState<string[]>([])
  const [documents, setDocuments] = useState<DocumentOption[]>([])
  const [documentKeyword, setDocumentKeyword] = useState('')
  const [documentLoading, setDocumentLoading] = useState(false)
  const [selectedDocIds, setSelectedDocIds] = useState<string[]>([])

  const loadTags = async (search?: string) => {
    setLoading(true)
    try {
      const items = await window.api.listTags(search)
      setTags(items)
    } catch (error) {
      console.error(error)
      message.error('加载标签失败')
    } finally {
      setLoading(false)
    }
  }

  const loadDocuments = async (search?: string) => {
    setDocumentLoading(true)
    try {
      const items = await window.api.listDocuments({ search: search?.trim() || undefined, limit: 1000 })
      setDocuments(items)
    } catch (error) {
      console.error(error)
      message.error('加载文献失败')
    } finally {
      setDocumentLoading(false)
    }
  }

  useEffect(() => {
    void loadTags()
  }, [])

  useEffect(() => {
    const handleLibraryRelationsChanged = () => {
      void loadTags(keyword || undefined)
      if (documentPickerOpen) {
        void loadDocuments(documentKeyword || undefined)
      }
    }

    window.addEventListener(LIBRARY_RELATIONS_CHANGED_EVENT, handleLibraryRelationsChanged)
    return () => window.removeEventListener(LIBRARY_RELATIONS_CHANGED_EVENT, handleLibraryRelationsChanged)
  }, [documentKeyword, documentPickerOpen, keyword])

  useEffect(() => {
    let refreshTimer: number | null = null
    const unsubscribe = window.api.onMetadataReclassificationProgress((payload) => {
      if (payload.status !== 'progress' && payload.status !== 'completed') return
      if (refreshTimer) {
        window.clearTimeout(refreshTimer)
      }
      refreshTimer = window.setTimeout(() => {
        void loadTags(keyword || undefined)
        refreshTimer = null
      }, payload.status === 'completed' ? 80 : 800)
    })

    return () => {
      unsubscribe()
      if (refreshTimer) {
        window.clearTimeout(refreshTimer)
      }
    }
  }, [keyword])

  useEffect(() => {
    if (!batchMode && selectedTagIds.length > 0) {
      setSelectedTagIds([])
    }
  }, [batchMode, selectedTagIds.length])

  const filteredTags = useMemo(() => tags, [tags])
  const tagIdOrder = useMemo(() => filteredTags.map((tag) => tag.id), [filteredTags])
  const documentIdOrder = useMemo(() => documents.map((doc) => doc.id), [documents])
  const selectedTagIdSet = useMemo(() => new Set(selectedTagIds), [selectedTagIds])
  const selectedDocIdSet = useMemo(() => new Set(selectedDocIds), [selectedDocIds])

  const groupedTags = useMemo(() => {
    const groups = new Map<TagSemanticKind, TagItem[]>()

    filteredTags.forEach((tag) => {
      const key = getTagKind(tag)
      const current = groups.get(key) || []
      current.push(tag)
      groups.set(key, current)
    })

    return Array.from(groups.entries())
      .sort((a, b) => TAG_KIND_META[a[0]].order - TAG_KIND_META[b[0]].order)
      .map(([kind, items]) => ({
        kind,
        label: TAG_KIND_META[kind].label,
        color: TAG_KIND_META[kind].color,
        items: items.sort((a, b) => {
          const usageGap = (b.usage_count || 0) - (a.usage_count || 0)
          return usageGap !== 0 ? usageGap : a.name.localeCompare(b.name, 'zh-Hans-CN')
        })
      }))
  }, [filteredTags])

  const pickerTags = useMemo(() => (
    documentPickerTagIds
      .map((tagId) => tags.find((item) => item.id === tagId))
      .filter(isTagItem)
  ), [documentPickerTagIds, tags])

  const { startDragSelect: handleTagListMouseDown } = useDragMultiSelect<HTMLDivElement>({
    rootRef: tagListRef,
    itemSelector: '[data-tag-select-item="true"]',
    selectedIds: selectedTagIds,
    orderedIds: tagIdOrder,
    enabled: !loading && filteredTags.length > 0,
    isBlockedTarget: (target) => {
      if (!(target instanceof HTMLElement)) return true
      return !!target.closest('button,input,textarea,select,a,[contenteditable="true"],.ant-dropdown,.ant-popover,.ant-modal')
    },
    activeClassName: 'is-marquee-selecting',
    previewClassName: 'is-drag-select-preview',
    reactPreview: false,
    onCommit: (nextIds) => {
      if (!sameStringArray(selectedTagIds, nextIds)) {
        setSelectedTagIds(nextIds)
      }
      if (nextIds.length > 0) setBatchMode(true)
    },
    onDragEnd: () => {
      suppressTagClickRef.current = true
      window.setTimeout(() => {
        suppressTagClickRef.current = false
      }, 0)
    },
  })

  const { startDragSelect: handleDocumentPickerMouseDown } = useDragMultiSelect<HTMLDivElement>({
    rootRef: documentPickerListRef,
    itemSelector: '[data-document-picker-select-item="true"]',
    selectedIds: selectedDocIds,
    orderedIds: documentIdOrder,
    enabled: documentPickerOpen && !documentLoading && documents.length > 0,
    isBlockedTarget: (target) => {
      if (!(target instanceof HTMLElement)) return true
      return !!target.closest('input,textarea,select,a,[contenteditable="true"],.ant-dropdown,.ant-popover')
    },
    activeClassName: 'is-marquee-selecting',
    previewClassName: 'is-drag-select-preview',
    reactPreview: false,
    onCommit: (nextIds) => {
      if (!sameStringArray(selectedDocIds, nextIds)) {
        setSelectedDocIds(nextIds)
      }
    },
    onDragEnd: () => {
      suppressDocumentClickRef.current = true
      window.setTimeout(() => {
        suppressDocumentClickRef.current = false
      }, 0)
    },
  })

  const toggleSelectedTag = (tagId: string) => {
    setSelectedTagIds((current) => (
      current.includes(tagId)
        ? current.filter((id) => id !== tagId)
        : [...current, tagId]
    ))
  }

  const toggleSelectedDoc = (docId: string) => {
    setSelectedDocIds((current) => (
      current.includes(docId)
        ? current.filter((id) => id !== docId)
        : [...current, docId]
    ))
  }

  const handleCreateTag = async () => {
    if (!newTagName.trim()) {
      message.info('请输入标签名称')
      return
    }

    await window.api.createTag({ name: newTagName.trim(), color: newTagColor, source: 'manual' })
    setNewTagName('')
    setNewTagColor('#faad14')
    setShowNewTag(false)
    message.success('标签已创建')
    void loadTags(keyword)
  }

  const handleUpdateTag = async (tagId: string) => {
    if (!editingTagName.trim()) {
      message.info('请输入标签名称')
      return
    }

    await window.api.updateTag(tagId, { name: editingTagName.trim(), color: editingTagColor, source: 'manual' })
    setEditingTagId(null)
    setEditingTagName('')
    setEditingTagColor('#faad14')
    message.success('标签已更新')
    void loadTags(keyword)
  }

  const handleDeleteTag = async (tagId: string, name: string) => {
    Modal.confirm({
      title: '删除标签',
      content: `确定删除标签“${name}”吗？文献本体不会被删除。`,
      okText: '删除',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        await window.api.deleteTag(tagId)
        message.success('标签已删除')
        void loadTags(keyword)
      }
    })
  }

  const handleBatchDelete = async () => {
    if (selectedTagIds.length === 0) {
      message.info('请先选择要删除的标签')
      return
    }

    const selectedNames = tags
      .filter((tagItem) => selectedTagIdSet.has(tagItem.id))
      .map((tagItem) => tagItem.name)

    Modal.confirm({
      title: '批量删除标签',
      content: (
        <div>
          <p>确定删除已选的 {selectedTagIds.length} 个标签吗？文献本体不会被删除。</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 12 }}>
            {selectedNames.slice(0, 12).map((name) => (
              <Tag key={name} style={{ margin: 0 }}>{name}</Tag>
            ))}
            {selectedNames.length > 12 ? <Tag style={{ margin: 0 }}>+{selectedNames.length - 12}</Tag> : null}
          </div>
        </div>
      ),
      okText: '删除',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        await Promise.all(selectedTagIds.map((tagId) => window.api.deleteTag(tagId)))
        message.success(`已删除 ${selectedTagIds.length} 个标签`)
        setSelectedTagIds([])
        setBatchMode(false)
        void loadTags(keyword)
      }
    })
  }

  const openDocumentPicker = async (tagIds: string[]) => {
    const uniqueTagIds = [...new Set(tagIds)]
    if (uniqueTagIds.length === 0) {
      message.info('请先选择标签')
      return
    }
    setDocumentPickerTagIds(uniqueTagIds)
    setSelectedDocIds([])
    setDocumentKeyword('')
    setDocumentPickerOpen(true)
    await loadDocuments()
  }

  const handleApplyDocumentsToTags = async () => {
    if (selectedDocIds.length === 0) {
      message.info('请先选择文献')
      return
    }
    if (documentPickerTagIds.length === 0) {
      message.info('请先选择标签')
      return
    }

    try {
      await window.api.addDocumentTags(selectedDocIds, documentPickerTagIds)
      message.success(`已把 ${selectedDocIds.length} 篇文献添加到 ${documentPickerTagIds.length} 个标签`)
      setDocumentPickerOpen(false)
      setSelectedDocIds([])
      setDocumentPickerTagIds([])
      void loadTags(keyword)
    } catch (error) {
      console.error(error)
      message.error('批量添加文献失败')
    }
  }

  return (
    <div style={{ padding: '24px 32px', height: '100%', overflow: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <Title level={3} style={{ margin: 0, color: 'var(--gs-gold)' }}>
          标签管理中心
        </Title>
        <Space>
          {batchMode ? (
            <>
              <Button icon={<FileAddOutlined />} disabled={selectedTagIds.length === 0} onClick={() => void openDocumentPicker(selectedTagIds)}>
                添加文献{selectedTagIds.length > 0 ? ` (${selectedTagIds.length})` : ''}
              </Button>
              <Button danger icon={<DeleteOutlined />} onClick={() => void handleBatchDelete()}>
                删除已选{selectedTagIds.length > 0 ? ` (${selectedTagIds.length})` : ''}
              </Button>
              <Button icon={<CloseOutlined />} onClick={() => { setBatchMode(false); setSelectedTagIds([]) }}>
                取消批量
              </Button>
            </>
          ) : (
            <Button icon={<CheckSquareOutlined />} onClick={() => setBatchMode(true)}>
              批量操作
            </Button>
          )}
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setShowNewTag(true)}>
            新建标签
          </Button>
        </Space>
      </div>

      <div>
        <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 10, padding: 18 }}>
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Input
              prefix={<SearchOutlined />}
              placeholder="搜索标签"
              value={keyword}
              allowClear
              onChange={(event) => setKeyword(event.target.value)}
              onPressEnter={() => void loadTags(keyword)}
            />
            <Text type="secondary">
              共 {filteredTags.length} 个标签。自建标签会排在最上方，点击标签可跳到文献库筛选。
            </Text>
          </Space>

          {loading ? (
            <div style={{ textAlign: 'center', padding: 48 }}>
              <Spin />
            </div>
          ) : filteredTags.length === 0 ? (
            <Empty description="暂无标签" style={{ marginTop: 36 }} />
          ) : (
            <div
              ref={tagListRef}
              onMouseDown={handleTagListMouseDown}
              style={{
                marginTop: 18,
                display: 'flex',
                flexDirection: 'column',
                gap: 18,
                paddingLeft: 56,
                boxSizing: 'border-box',
                cursor: 'crosshair',
              }}
            >
              {groupedTags.map((group) => (
                <div key={group.kind}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                    <Text strong>{group.label}</Text>
                    <Text type="secondary">{group.items.length} 个标签</Text>
                  </div>

                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                    {group.items.map((tagItem) => {
                      const selected = selectedTagIdSet.has(tagItem.id)
                      return (
                        <div
                          key={tagItem.id}
                          data-tag-select-item="true"
                          data-select-id={tagItem.id}
                          onClick={() => {
                            if (suppressTagClickRef.current) return
                            if (batchMode && editingTagId !== tagItem.id) {
                              toggleSelectedTag(tagItem.id)
                            }
                          }}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            minWidth: 0,
                            maxWidth: '100%',
                            padding: '8px 12px',
                            borderRadius: 8,
                            background: selected ? 'rgba(24,144,255,0.14)' : 'rgba(255,255,255,0.04)',
                            border: selected ? '1px solid rgba(24,144,255,0.55)' : '1px solid rgba(255,255,255,0.08)',
                            cursor: batchMode ? 'pointer' : 'default'
                          }}
                        >
                          {editingTagId === tagItem.id ? (
                            <Space size={6}>
                              <input type="color" value={editingTagColor} onChange={(event) => setEditingTagColor(event.target.value)} />
                              <Input
                                size="small"
                                value={editingTagName}
                                onChange={(event) => setEditingTagName(event.target.value)}
                                onPressEnter={() => void handleUpdateTag(tagItem.id)}
                              />
                              <Button size="small" type="link" onClick={() => void handleUpdateTag(tagItem.id)}>保存</Button>
                            </Space>
                          ) : (
                            <>
                              {batchMode ? (
                                <div
                                  style={{
                                    width: 16,
                                    height: 16,
                                    borderRadius: 4,
                                    border: selected ? '2px solid #1890ff' : '2px solid rgba(255,255,255,0.3)',
                                    background: selected ? '#1890ff' : 'transparent',
                                    color: '#fff',
                                    fontSize: 10,
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    flexShrink: 0
                                  }}
                                >
                                  {selected ? '✓' : ''}
                                </div>
                              ) : null}

                              <Tooltip title={getTooltipTitle(tagItem.name, 22)}>
                                <Tag
                                  color={group.color}
                                  style={{
                                    marginInlineEnd: 0,
                                    maxWidth: 220,
                                    overflow: 'hidden',
                                    whiteSpace: 'nowrap',
                                    textOverflow: 'ellipsis',
                                    cursor: 'pointer'
                                  }}
                                  onClick={(event) => {
                                    event.stopPropagation()
                                    if (suppressTagClickRef.current) return
                                    if (batchMode) {
                                      toggleSelectedTag(tagItem.id)
                                      return
                                    }
                                    onOpenTag?.(tagItem.id)
                                  }}
                                >
                                  {truncateLabel(tagItem.name)}
                                </Tag>
                              </Tooltip>

                              <Button
                                type="text"
                                size="small"
                                style={{ color: 'var(--gs-text-secondary)', paddingInline: 4 }}
                                onClick={(event) => {
                                  event.stopPropagation()
                                  if (suppressTagClickRef.current) return
                                  if (batchMode) {
                                    toggleSelectedTag(tagItem.id)
                                    return
                                  }
                                  onOpenTag?.(tagItem.id)
                                }}
                              >
                                {tagItem.usage_count || 0} 篇
                              </Button>

                              <Button
                                type="text"
                                size="small"
                                icon={<FileAddOutlined />}
                                disabled={batchMode}
                                onClick={(event) => {
                                  event.stopPropagation()
                                  void openDocumentPicker([tagItem.id])
                                }}
                              />

                              <Button
                                type="text"
                                size="small"
                                icon={<EditOutlined />}
                                disabled={batchMode}
                                onClick={(event) => {
                                  event.stopPropagation()
                                  setEditingTagId(tagItem.id)
                                  setEditingTagName(tagItem.name)
                                  setEditingTagColor(tagItem.color || '#faad14')
                                }}
                              />

                              <Button
                                type="text"
                                size="small"
                                danger
                                icon={<DeleteOutlined />}
                                disabled={batchMode}
                                onClick={(event) => {
                                  event.stopPropagation()
                                  void handleDeleteTag(tagItem.id, tagItem.name)
                                }}
                              />
                            </>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <Modal
        title="新建标签"
        open={showNewTag}
        onCancel={() => setShowNewTag(false)}
        onOk={() => void handleCreateTag()}
        okText="创建"
        cancelText="取消"
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Input placeholder="标签名称" value={newTagName} onChange={(event) => setNewTagName(event.target.value)} />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {presetColors.map((color) => (
              <button
                key={color}
                type="button"
                onClick={() => setNewTagColor(color)}
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 8,
                  border: newTagColor === color ? '2px solid #fff' : '1px solid rgba(255,255,255,0.12)',
                  background: color,
                  cursor: 'pointer'
                }}
              />
            ))}
          </div>
        </Space>
      </Modal>

      <Modal
        title="添加文献到标签"
        open={documentPickerOpen}
        onCancel={() => {
          setDocumentPickerOpen(false)
          setSelectedDocIds([])
          setDocumentPickerTagIds([])
        }}
        onOk={() => void handleApplyDocumentsToTags()}
        okText="添加"
        cancelText="取消"
        width={720}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {pickerTags.map((tagItem) => (
              <Tag key={tagItem.id} color={TAG_KIND_META[getTagKind(tagItem)].color} style={{ margin: 0 }}>
                {tagItem.name}
              </Tag>
            ))}
          </div>
          <Input.Search
            placeholder="搜索文献标题、作者或元数据"
            value={documentKeyword}
            allowClear
            onChange={(event) => setDocumentKeyword(event.target.value)}
            onSearch={(value) => void loadDocuments(value)}
          />
          <div
            ref={documentPickerListRef}
            onMouseDown={handleDocumentPickerMouseDown}
            style={{ maxHeight: 380, overflowY: 'auto', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8 }}
          >
            {documentLoading ? (
              <div style={{ textAlign: 'center', padding: 36 }}>
                <Spin />
              </div>
            ) : documents.length === 0 ? (
              <Empty description="暂无文献" style={{ margin: 24 }} />
            ) : (
              documents.map((doc) => {
                const checked = selectedDocIdSet.has(doc.id)
                const docTagIds = splitPipe(doc.tag_ids)
                const alreadyInAllTags = documentPickerTagIds.every((tagId) => docTagIds.includes(tagId))
                return (
                  <button
                    key={doc.id}
                    type="button"
                    data-document-picker-select-item="true"
                    data-select-id={doc.id}
                    onClick={() => {
                      if (suppressDocumentClickRef.current) return
                      toggleSelectedDoc(doc.id)
                    }}
                    style={{
                      width: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '10px 12px',
                      border: 0,
                      borderBottom: '1px solid rgba(255,255,255,0.06)',
                      background: checked ? 'rgba(24,144,255,0.14)' : 'transparent',
                      color: 'var(--gs-text-primary)',
                      cursor: 'pointer',
                      textAlign: 'left'
                    }}
                  >
                    <span
                      style={{
                        width: 16,
                        height: 16,
                        borderRadius: 4,
                        border: checked ? '2px solid #1890ff' : '2px solid rgba(255,255,255,0.35)',
                        background: checked ? '#1890ff' : 'transparent',
                        color: '#fff',
                        fontSize: 10,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0
                      }}
                    >
                      {checked ? '✓' : ''}
                    </span>
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span style={{ display: 'block', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                        {doc.title || '未命名文献'}
                      </span>
                      <span style={{ display: 'block', color: 'var(--gs-text-secondary)', fontSize: 12, marginTop: 2 }}>
                        {[doc.author, doc.doc_type].filter(Boolean).join(' / ') || '未填写作者与类型'}
                      </span>
                    </span>
                    {alreadyInAllTags ? <Tag style={{ margin: 0 }}>已在标签中</Tag> : null}
                  </button>
                )
              })
            )}
          </div>
          <Text type="secondary">已选 {selectedDocIds.length} 篇文献</Text>
        </Space>
      </Modal>
    </div>
  )
}
