const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')

const checks = [
  {
    name: 'AiMarkdown renders markdown with GFM',
    file: 'src/renderer/src/components/AiMarkdown.tsx',
    test: (text) => text.includes('ReactMarkdown') && text.includes('remarkGfm') && text.includes('ai-citation-link'),
  },
  {
    name: 'AiPanel uses AiMarkdown and streaming APIs',
    file: 'src/renderer/src/components/AiPanel.tsx',
    test: (text) => text.includes('<AiMarkdown') && text.includes('askDocumentAiStream') && text.includes('runScopedLibraryAiStream'),
  },
  {
    name: 'Preload exposes stream and summary APIs',
    file: 'src/preload/index.ts',
    test: (text) => text.includes('askDocumentAiStream') && text.includes('runScopedLibraryAiStream') && text.includes('summarizeSelection') && text.includes('onAiStreamEvent'),
  },
  {
    name: 'OpenDocumentTarget supports TOC reveal and highlight excerpt',
    file: 'src/shared/types.ts',
    test: (text) => text.includes('revealToc?: boolean') && text.includes('highlightExcerpt?: string') && text.includes('AiStreamEvent') && text.includes('AiSummaryResult'),
  },
  {
    name: 'Reader selection toolbar supports summary and notes',
    file: 'src/renderer/src/components/SourcePageReader.tsx',
    test: (text) => text.includes('reader-selection-toolbar') && text.includes('summarizeSelection') && text.includes('保存为研究笔记'),
  },
]

const failures = []
for (const check of checks) {
  const text = read(check.file)
  if (!check.test(text)) failures.push(`${check.name} (${check.file})`)
}

if (failures.length) {
  console.error(`AI markdown/citation QA failed:\n- ${failures.join('\n- ')}`)
  process.exit(1)
}

console.log('AI markdown/citation QA passed.')
