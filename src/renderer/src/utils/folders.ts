import type { Folder } from '@shared/types'

export type FolderTreeNode<T extends Folder = Folder> = T & {
  children: Array<FolderTreeNode<T>>
  depth: number
}

export function sortFolders<T extends Pick<Folder, 'name' | 'sort_order'>>(left: T, right: T): number {
  const orderGap = Number(left.sort_order || 0) - Number(right.sort_order || 0)
  if (orderGap !== 0) return orderGap
  return left.name.localeCompare(right.name, 'zh-Hans-CN')
}

export function buildFolderTree<T extends Folder>(folders: T[]): Array<FolderTreeNode<T>> {
  const nodeMap = new Map<string, FolderTreeNode<T>>()
  folders.forEach((folder) => {
    nodeMap.set(folder.id, { ...folder, children: [], depth: 0 })
  })

  const roots: Array<FolderTreeNode<T>> = []
  nodeMap.forEach((node) => {
    const parentId = node.parent_id || null
    const parent = parentId ? nodeMap.get(parentId) : null
    if (parent && parent.id !== node.id) {
      node.depth = parent.depth + 1
      parent.children.push(node)
      return
    }
    roots.push(node)
  })

  const sortTree = (nodes: Array<FolderTreeNode<T>>, depth = 0): Array<FolderTreeNode<T>> => (
    nodes
      .sort(sortFolders)
      .map((node) => {
        node.depth = depth
        node.children = sortTree(node.children, depth + 1)
        return node
      })
  )

  return sortTree(roots)
}

export function flattenVisibleFolders<T extends Folder>(nodes: Array<FolderTreeNode<T>>, collapsedIds: string[]): Array<FolderTreeNode<T>> {
  const collapsed = new Set(collapsedIds)
  const result: Array<FolderTreeNode<T>> = []
  const visit = (node: FolderTreeNode<T>) => {
    result.push(node)
    if (collapsed.has(node.id)) return
    node.children.forEach(visit)
  }
  nodes.forEach(visit)
  return result
}

export function collectFolderDescendantIds<T extends Pick<Folder, 'id' | 'parent_id'>>(folders: T[], folderId: string): string[] {
  const childrenByParent = new Map<string, string[]>()
  folders.forEach((folder) => {
    if (!folder.parent_id) return
    const current = childrenByParent.get(folder.parent_id) || []
    current.push(folder.id)
    childrenByParent.set(folder.parent_id, current)
  })

  const result: string[] = []
  const visit = (id: string) => {
    result.push(id)
    ;(childrenByParent.get(id) || []).forEach(visit)
  }
  visit(folderId)
  return result
}

export function isFolderDescendant<T extends Pick<Folder, 'id' | 'parent_id'>>(folders: T[], folderId: string, possibleParentId: string): boolean {
  const parentById = new Map(folders.map((folder) => [folder.id, folder.parent_id || null]))
  let current = parentById.get(folderId) || null
  while (current) {
    if (current === possibleParentId) return true
    current = parentById.get(current) || null
  }
  return false
}

