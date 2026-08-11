import { FolderAddOutlined } from '@ant-design/icons'
import type { MenuProps } from 'antd'
import type { Folder } from '@shared/types'
import type { FolderTreeNode } from './folders'

type ConcreteMenuItem = Exclude<NonNullable<MenuProps['items']>[number], null>

function renderFolderMenuLabel(name: string, direct = false) {
  const label = direct ? `加入“${name}”` : name
  return <span className="library-folder-menu-label" title={label}>{label}</span>
}
export function buildDocumentFolderMenuItems<T extends Folder>(
  folderTree: Array<FolderTreeNode<T>>,
  assignedFolderIds: string[],
): MenuProps['items'] {
  const assignedFolderIdSet = new Set(assignedFolderIds)
  const buildNode = (node: FolderTreeNode<T>): ConcreteMenuItem | null => {
    const childItems: ConcreteMenuItem[] = []
    node.children.forEach((child) => {
      const childItem = buildNode(child)
      if (childItem) childItems.push(childItem)
    })

    const canAddToNode = !assignedFolderIdSet.has(node.id)
    if (childItems.length === 0) {
      return canAddToNode
        ? { key: `folder_${node.id}`, label: renderFolderMenuLabel(node.name) }
        : null
    }

    const children: ConcreteMenuItem[] = []
    if (canAddToNode) {
      children.push({
        key: `folder_${node.id}`,
        label: renderFolderMenuLabel(node.name, true),
        icon: <FolderAddOutlined />,
      })
      children.push({ type: 'divider' })
    }
    children.push(...childItems)
    return {
      key: `folder-parent:${node.id}`,
      label: renderFolderMenuLabel(node.name),
      popupClassName: 'library-document-folder-submenu',
      children,
    }
  }

  const items: ConcreteMenuItem[] = []
  folderTree.forEach((node) => {
    const item = buildNode(node)
    if (item) items.push(item)
  })
  return items.length > 0
    ? items
    : [{ key: 'folder_none', label: '没有可加入的文件夹', disabled: true }]
}
