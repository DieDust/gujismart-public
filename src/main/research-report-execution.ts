export const RESEARCH_REQUEST_TIMEOUT_MS = 300_000
export const RESEARCH_REPORT_PROMPT_BYTES = 24_000

// A shared lane limits this research workflow, not unrelated chat or OCR requests.
export function createResearchRequestLane() {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation)
    tail = result.catch(() => {})
    return result
  }
}

export const researchModelLane = createResearchRequestLane()

export async function retryResearchRequest<T>(operation: () => Promise<T>, options: {
  retryable: (error: unknown) => boolean
  onRetry: () => void
  wait?: () => Promise<void>
}): Promise<T> {
  try { return await operation() } catch (error) {
    if (!options.retryable(error)) throw error
    options.onRetry()
    await (options.wait || (() => new Promise<void>((resolve) => setTimeout(resolve, 5000))))()
    return operation()
  }
}

// UTF-8 is a conservative size budget across CJK and Latin models, not an exact token count.
export function packResearchText(text: string, budget: number): string[] {
  if (budget < 4) throw new Error('报告请求的文本预算不足')
  const chunks: string[] = []
  let current: string[] = []
  let bytes = 0
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8')
    if (bytes + size > budget) {
      chunks.push(current.join(''))
      current = []
      bytes = 0
    }
    current.push(char)
    bytes += size
  }
  if (current.length) chunks.push(current.join(''))
  return chunks
}

export async function generateResearchReportBatches(options: {
  context: string
  sources: Array<{ id: string; text: string }>
  generate: (prompt: string, label: string) => Promise<string>
  progress: (message: string, fraction: number) => void
}): Promise<string> {
  const summarize = '以下是连续材料的一个分段，边界可能位于同一条记录内。概括与研究问题相关的陈述，保留来源编号、文献名称、原文页码、冲突与不确定性。不推断缺失上下文，不把共现当事实关系，不累加重复统计。摘要不超过1000字。'
  const final = '根据下方材料回答研究问题。优先遵守用户指定的文体与篇幅；要求短摘要时只交付摘要，不强制套用完整报告目录或表格，不额外附长报告。短摘要最多三段，依次说明主要发现、证据边界、待核验事项；篇幅以上限的三分之二为目标，为标题与引用留出余量，不自行附加估算字数。引用使用文献名称和原文页码，来源编号仅供内部追溯，不向读者显示内部ID、分段编号、templateType或pending等英文状态，待核验状态用中文说明。少量命中不自动等于证据压缩。除非用户询问处理过程，不复述命中统计、分段或压缩机制。只说明与本问题有关的证据局限和回查事项，不提出没有材料依据的拼写纠错或背景推测。不编造材料；基于分段摘要的结论需回查原始记录。'
  const prefix = `${options.context}\n\n${summarize}\n${final}\n\n`
  const budget = RESEARCH_REPORT_PROMPT_BYTES - Buffer.byteLength(prefix, 'utf8')
  if (budget < 6000) throw new Error('报告目标或范围说明过长，请缩短额外要求后仅重试报告。已保存材料不受影响。')
  const packParts = (parts: string[]) => {
    const groups: string[] = []
    let group = ''
    for (const part of parts) {
      if (group && Buffer.byteLength(`${group}\n\n${part}`, 'utf8') > budget) {
        groups.push(group)
        group = ''
      }
      group += `${group ? '\n\n' : ''}${part}`
    }
    if (group) groups.push(group)
    return groups
  }
  const parts = options.sources.flatMap((source) => {
    const label = `来源编号：${source.id}`
    const segments = packResearchText(source.text, budget - Buffer.byteLength(label, 'utf8') - 100)
    return segments.map((text, i) => `${label}（分段 ${i + 1}/${segments.length}）\n${text}`)
  })
  let inputs = packParts(parts)
  let round = 0
  while (inputs.length > 1) {
    round += 1
    if (round > 10) throw new Error('报告汇总层数过多，已停止请求，请分研究问题生成报告。')
    const summaries: string[] = []
    for (let i = 0; i < inputs.length; i += 1) {
      const label = `第 ${round} 轮分段汇总 ${i + 1}/${inputs.length}`
      options.progress(`${label}，串行请求，单次最多等待 300 秒`, i / inputs.length)
      const summary = (await options.generate(`${options.context}\n\n${summarize}\n\n${inputs[i]}`, label)).trim()
      if (!summary) throw new Error(`${label}返回空内容，报告未完成。`)
      // Refuse unbounded output instead of silently discarding source coverage.
      if (Buffer.byteLength(summary, 'utf8') > budget / 3) throw new Error(`${label}摘要过长，无法安全合并；请仅重试报告。`)
      summaries.push(summary)
    }
    inputs = packParts(summaries)
  }
  options.progress(round ? '分段汇总完成，正在撰写最终报告' : '正在撰写报告，串行请求，单次最多等待 300 秒', 0)
  const result = (await options.generate(`${options.context}\n\n${final}\n\n${inputs[0] || ''}`, '最终报告')).trim()
  if (!result) throw new Error('模型返回空报告，已保存材料不受影响。')
  return result
}
