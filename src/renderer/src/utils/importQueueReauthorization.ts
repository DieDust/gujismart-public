import type { ImportSelectionBatchItem } from '@shared/types'

function normalizeLabel(value: string): string {
  const normalizedPath = value.trim().replace(/\\/g, '/')
  return (normalizedPath.split('/').pop() || normalizedPath).toLocaleLowerCase()
}

function consumeLabel(labels: string[], displayName: string): boolean {
  const normalized = normalizeLabel(displayName)
  const index = labels.findIndex((label) => normalizeLabel(label) === normalized)
  if (index < 0) return false
  labels.splice(index, 1)
  return true
}

export function getPendingImportDisplayLabels(
  pendingGrantIds: string[],
  displayNames?: Map<string, string>,
): string[] {
  if (!displayNames) return []
  return pendingGrantIds
    .map((grantId) => displayNames.get(grantId) || '')
    .filter(Boolean)
}

export function matchReauthorizedItems(
  requiredLabels: string[],
  items: ImportSelectionBatchItem[],
): { matchedItems: ImportSelectionBatchItem[]; remainingLabels: string[] } {
  const remainingLabels = [...requiredLabels]
  const matchedItems = items.filter((item) => consumeLabel(remainingLabels, item.displayName))
  return { matchedItems, remainingLabels }
}

export function matchReauthorizedSources(
  requiredLabels: string[],
  sources: Array<{ sourceId: string; displayName: string }>,
): { allowedSourceIds: Set<string>; remainingLabels: string[] } {
  const remainingLabels = [...requiredLabels]
  const allowedSourceIds = new Set<string>()
  for (const source of sources) {
    if (consumeLabel(remainingLabels, source.displayName)) allowedSourceIds.add(source.sourceId)
  }
  return { allowedSourceIds, remainingLabels }
}

export function transitionAuthorizationJobs<T extends { id: number }>(
  jobs: T[],
  replacedJobId: number,
  transition: { replacementEstablished: boolean; remainingJob?: T },
): T[] {
  if (!transition.replacementEstablished) return [...jobs]
  const remaining = jobs.filter((job) => job.id !== replacedJobId)
  return transition.remainingJob ? [transition.remainingJob, ...remaining] : remaining
}
