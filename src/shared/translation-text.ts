export interface TranslationTextDecision {
  shouldTranslate: boolean
  mixedLanguage: boolean
}

export function shouldTranslatePageText(text: string): TranslationTextDecision {
  const ignoredLatinWords = new Set([
    'ai', 'ocr', 'pdf', 'text', 'table', 'figure', 'image', 'caption', 'header', 'footer',
    'number', 'seal', 'doc', 'title', 'paragraph', 'abstract', 'reference', 'vision',
    'footnote', 'formula', 'list', 'page', 'pages', 'layout', 'block', 'line', 'word',
    'words', 'column', 'row', 'cell', 'stamp', 'watermark', 'body', 'content', 'section',
  ])
  const normalizedText = String(text || '')
    .replace(/(?:doc|paragraph|vision|page|layout|body|image|table|figure|formula|list)[_-](?:title|footnote|header|footer|number|caption|text|block)/gi, ' ')
    .replace(/\b(?:[ivxlcdm]+|[a-z])\b\.?/gi, ' ')
  const chars = Array.from(normalizedText)
  const chineseCount = chars.filter((char) => /[\p{Script=Han}]/u.test(char)).length
  const kanaCount = chars.filter((char) => /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(char)).length
  const hangulCount = chars.filter((char) => /[\p{Script=Hangul}]/u.test(char)).length
  const otherForeignScriptCount = chars.filter((char) => (
    /[\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Thai}\p{Script=Devanagari}]/u.test(char)
  )).length
  const latinWords = normalizedText.match(/[A-Za-z][A-Za-z'-]{1,}/g) || []
  const meaningfulLatinWords = latinWords.filter((word) => {
    const normalized = word.toLowerCase()
    if (ignoredLatinWords.has(normalized)) return false
    if (/^[ivxlcdm]+$/i.test(word)) return false
    return word.length >= 3
  })
  const latinCharCount = meaningfulLatinWords.reduce((sum, word) => sum + word.length, 0)
  const foreignCount = latinCharCount + kanaCount + hangulCount + otherForeignScriptCount
  const totalMeaningful = chineseCount + foreignCount
  const chineseRatio = totalMeaningful > 0 ? chineseCount / totalMeaningful : 0

  if (totalMeaningful < 24) return { shouldTranslate: false, mixedLanguage: false }
  const hasJapaneseKana = kanaCount >= 8 || (kanaCount >= 3 && kanaCount / Math.max(1, totalMeaningful) >= 0.04)
  if (hasJapaneseKana) {
    return { shouldTranslate: true, mixedLanguage: chineseCount > 0 }
  }
  if (
    chineseCount >= 60
    && chineseRatio >= 0.72
    && meaningfulLatinWords.length < 28
    && kanaCount + hangulCount + otherForeignScriptCount < 32
  ) {
    return { shouldTranslate: false, mixedLanguage: false }
  }

  const foreignRatio = foreignCount / totalMeaningful
  const shouldTranslate = chineseCount === 0
    ? foreignCount >= 20
    : foreignCount >= 120 && foreignRatio >= 0.28

  return {
    shouldTranslate,
    mixedLanguage: shouldTranslate && chineseCount > 0 && foreignCount > 0,
  }
}
