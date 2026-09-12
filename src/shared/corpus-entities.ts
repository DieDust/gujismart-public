import type { CorpusEntityMention, CorpusEntityReview, CorpusResearchFinding } from './types'

export interface CorpusEntityDecision extends CorpusEntityReview { id: string }
const normalized = (name: string) => name.normalize('NFC').trim().toLocaleLowerCase()
const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// A source-local naming assertion is not proof of identity across documents.
export function explicitAlias(name: string, alias: string, quote: string, uncertainty: string): boolean {
  if (name === alias || uncertainty.trim() || /不|非|未|否|疑|或|可能|据说|據說|相传|相傳|误|誤|假|有人认为|有人認為/.test(quote)) return false
  return new RegExp(`(?:^|[，,。；;\\s])${escaped(name)}[，,、\\s]*(?:字|号|號|又名|亦名|别名|別名|原名|旧称|舊稱|又称|又稱|即)[为為\\s]*${escaped(alias)}(?=$|[，,。；;\\s])`).test(quote)
}

export function resolveCorpusEntities(findings: CorpusResearchFinding[], decisions: CorpusEntityDecision[]): {
  items: CorpusEntityMention[]; canUndo: boolean; unprocessedFindings: number
} {
  const items: CorpusEntityMention[] = []
  const parents = new Map<string, string>()
  const root = (key: string): string => {
    let current = key
    while (parents.has(current) && parents.get(current) !== current) current = parents.get(current)!
    let path = key
    while (parents.has(path) && parents.get(path) !== path) { const next = parents.get(path)!; parents.set(path, current); path = next }
    return current
  }
  const occurrences = new Map<string, string>()
  for (const source of findings) {
    for (const [index, entity] of (source.entities || []).entries()) {
      const id = `${source.id}:${index}`
      parents.set(id, id)
      const aliases = entity.aliases.filter((alias) => explicitAlias(entity.name, alias.name, source.quote, source.uncertainty))
      const mention: CorpusEntityMention = { id, groupId: id, findingId: source.id, name: entity.name, kind: entity.kind,
        aliases: aliases.map((alias) => alias.name), suggestedAliases: entity.aliases.filter((alias) => !aliases.includes(alias)).map((alias) => alias.name),
        candidateCount: 0, groupSize: 1, reviewed: false, source }
      // Only identical anchored occurrences (or an explicit local alias occurrence)
      // coalesce automatically. A matching name on another page remains independent.
      for (const name of [entity.name, ...mention.aliases]) {
        const offset = source.quote.indexOf(name)
        if (offset < 0 || source.quote.indexOf(name, offset + name.length) >= 0) continue
        const key = JSON.stringify([source.docId, source.pageId, source.sourceHash, source.start + offset, entity.kind, name])
        const previous = occurrences.get(key)
        if (previous) parents.set(root(id), root(previous))
        else occurrences.set(key, id)
      }
      items.push(mention)
    }
  }
  for (const item of items) item.groupId = root(item.id)
  const stack: CorpusEntityDecision[] = []
  for (const decision of decisions) {
    if (decision.action === 'undo') stack.pop()
    else stack.push(decision)
  }
  const byId = new Map(items.map((item) => [item.id, item]))
  for (const decision of stack) {
    const selected = decision.mentionIds.map((id) => byId.get(id)).filter((item): item is CorpusEntityMention => !!item)
    if (decision.action === 'merge') {
      const groups = new Set(selected.map((item) => item.groupId))
      for (const item of items) if (groups.has(item.groupId)) { item.groupId = decision.id; item.reviewed = true }
    } else {
      for (const item of selected) {
        item.groupId = `${decision.id}:${item.id}`; item.reviewed = true
        item.suggestedAliases = [...new Set([...item.suggestedAliases, ...item.aliases])]; item.aliases = []
      }
    }
  }
  const sizes = new Map<string, number>()
  const candidates = new Map<string, Set<string>>()
  for (const item of items) {
    sizes.set(item.groupId, (sizes.get(item.groupId) || 0) + 1)
    for (const name of [item.name, ...item.aliases, ...item.suggestedAliases]) {
      const key = `${item.kind}:${normalized(name)}`
      const groups = candidates.get(key) || new Set<string>()
      groups.add(item.groupId); candidates.set(key, groups)
    }
  }
  for (const item of items) {
    item.groupSize = sizes.get(item.groupId)!
    // Candidate counts use name buckets, not a quadratic pairwise comparison.
    item.candidateCount = Math.max(0, ...[item.name, ...item.aliases, ...item.suggestedAliases]
      .map((name) => (candidates.get(`${item.kind}:${normalized(name)}`)?.size || 1) - 1))
  }
  return { items, canUndo: stack.length > 0, unprocessedFindings: findings.filter((finding) => !finding.entities).length }
}
