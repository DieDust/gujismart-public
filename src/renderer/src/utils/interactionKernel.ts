export type CloseParticipantStatus = 'clean' | 'saved' | 'failed' | 'needs-confirmation'

export interface CloseParticipantResult {
  status: CloseParticipantStatus
  reason?: string
}

export interface ClosePreparation {
  canClose: boolean
  results: Array<CloseParticipantResult & { participantId: string }>
}

export class CloseCoordinator {
  private participants = new Map<string, () => Promise<CloseParticipantResult> | CloseParticipantResult>()

  register(id: string, prepare: () => Promise<CloseParticipantResult> | CloseParticipantResult): () => void {
    if (!id.trim()) throw new Error('close_participant_id_required')
    this.participants.set(id, prepare)
    return () => this.unregister(id)
  }

  unregister(id: string): void {
    this.participants.delete(id)
  }

  async prepareClose(): Promise<ClosePreparation> {
    const results = await Promise.all([...this.participants].map(async ([participantId, prepare]) => {
      try {
        return { participantId, ...await prepare() }
      } catch (error) {
        return { participantId, status: 'failed' as const, reason: error instanceof Error ? error.message : 'prepare_close_failed' }
      }
    }))
    return { canClose: results.every((result) => result.status === 'clean' || result.status === 'saved'), results }
  }
}

export interface LatestRequestToken {
  scope: string
  generation: number
}

export class LatestRequestGate {
  private generations = new Map<string, number>()

  begin(scope: string): LatestRequestToken {
    const generation = (this.generations.get(scope) || 0) + 1
    this.generations.set(scope, generation)
    return { scope, generation }
  }

  isCurrent(token: LatestRequestToken): boolean {
    return this.generations.get(token.scope) === token.generation
  }

  cancel(scope: string): void {
    this.generations.set(scope, (this.generations.get(scope) || 0) + 1)
  }
}

export class DragTransaction<T> {
  private previewValue: T
  private finished = false

  constructor(initialValue: T, private readonly onCommit: (value: T) => void) {
    this.previewValue = initialValue
  }

  preview(value: T): void {
    if (!this.finished) this.previewValue = value
  }

  commit(): boolean {
    if (this.finished) return false
    this.finished = true
    this.onCommit(this.previewValue)
    return true
  }

  cancel(): void {
    this.finished = true
  }
}

export function toggleSelectionId(selectedIds: string[], id: string): string[] {
  return selectedIds.includes(id)
    ? selectedIds.filter((selectedId) => selectedId !== id)
    : [...selectedIds, id]
}
