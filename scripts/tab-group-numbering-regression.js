function getDefaultTabGroupTitle(index) {
  return `分组 ${index + 1}`
}

function isDefaultTabGroupTitle(value) {
  return /^分组\s*\d+$/.test(String(value || '').trim())
}

function getNextDefaultTabGroupIndex(tabGroups) {
  const usedNumbers = new Set()
  tabGroups.forEach((group) => {
    const match = String(group.title || '').trim().match(/^分组\s*(\d+)$/)
    const number = match ? Number(match[1]) : 0
    if (Number.isInteger(number) && number > 0) {
      usedNumbers.add(number)
    }
  })
  let nextNumber = 1
  while (usedNumbers.has(nextNumber)) nextNumber += 1
  return nextNumber - 1
}

function getTabGroupCreatedAt(group, fallbackIndex) {
  const match = String(group.id || '').match(/^tab-group:(\d+):/)
  const createdAt = match ? Number(match[1]) : NaN
  return Number.isFinite(createdAt) ? createdAt : Number.MAX_SAFE_INTEGER + fallbackIndex
}

function repairDefaultTabGroupTitlesByCreationOrder(tabGroups) {
  const indexedGroups = tabGroups.map((group, index) => ({ group, index }))
  const defaultGroups = indexedGroups.filter(({ group }) => isDefaultTabGroupTitle(group.title))
  if (defaultGroups.length < 2) return tabGroups

  const repairedTitles = new Map()
  defaultGroups
    .sort((left, right) => (
      getTabGroupCreatedAt(left.group, left.index) - getTabGroupCreatedAt(right.group, right.index)
      || left.index - right.index
    ))
    .forEach(({ group }, index) => {
      repairedTitles.set(group.id, getDefaultTabGroupTitle(index))
    })

  return tabGroups.map((group) => {
    const title = repairedTitles.get(group.id)
    return title && group.title !== title ? { ...group, title } : group
  })
}

function pruneTabGroupsForTabs(tabGroups, nextTabs) {
  const usedGroupIds = new Set(nextTabs.map((tab) => tab.groupId).filter(Boolean))
  return tabGroups.filter((group) => usedGroupIds.has(group.id))
}

function createDefaultTabGroup(currentGroups, groupId, nextTabs) {
  const activeGroups = nextTabs ? pruneTabGroupsForTabs(currentGroups, nextTabs) : currentGroups
  const nextIndex = getNextDefaultTabGroupIndex(activeGroups)
  return {
    id: groupId,
    title: getDefaultTabGroupTitle(nextIndex),
  }
}

const repairedGroups = repairDefaultTabGroupTitlesByCreationOrder([
  { id: 'tab-group:2000:newer', title: '分组 1' },
  { id: 'tab-group:1000:older', title: '分组 2' },
])
const olderGroup = repairedGroups.find((group) => group.id === 'tab-group:1000:older')
const newerGroup = repairedGroups.find((group) => group.id === 'tab-group:2000:newer')

if (olderGroup?.title !== '分组 1' || newerGroup?.title !== '分组 2') {
  throw new Error('startup repair should restore default group titles by creation order once')
}

const firstGroup = { id: 'tab-group:1000:first', title: '分组 1' }
const currentGroups = [
  firstGroup,
  { id: 'tab-group:9999:stale', title: '分组 4' },
]
const nextTabs = [
  { id: 'doc', groupId: 'tab-group:1000:first' },
  { id: 'home', groupId: 'tab-group:2000:second' },
]
const secondGroup = createDefaultTabGroup(currentGroups, 'tab-group:2000:second', nextTabs)

if (firstGroup.title !== '分组 1') {
  throw new Error('existing group title should stay stable after creating a later group')
}

if (secondGroup.title !== '分组 2') {
  throw new Error(`second visible group should be 分组 2, got ${secondGroup.title}`)
}

console.log('Tab group numbering regression checks passed')
