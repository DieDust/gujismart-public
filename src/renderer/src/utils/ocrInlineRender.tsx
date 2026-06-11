import React from 'react'
import { parseOcrInlineText, type OcrInlineSegment, type OcrInlineStyle } from './ocrText'

type RenderOptions = {
  transformText?: (value: string) => string
}

function getTextDecoration(style: OcrInlineStyle): string | undefined {
  const decorations = [
    style.underline ? 'underline' : '',
    style.overline ? 'overline' : '',
  ].filter(Boolean)
  return decorations.length > 0 ? decorations.join(' ') : undefined
}

function renderStyledPiece(text: string, style: OcrInlineStyle, key: string): React.ReactNode {
  const contentStyle: React.CSSProperties = {
    fontWeight: style.bold ? 700 : undefined,
    fontStyle: style.italic ? 'italic' : undefined,
    textDecoration: getTextDecoration(style),
    textDecorationThickness: style.underline || style.overline ? '0.08em' : undefined,
    textUnderlineOffset: style.underline ? '0.12em' : undefined,
  }

  if (style.sup) {
    return (
      <sup key={key} style={{ ...contentStyle, fontSize: '0.72em', verticalAlign: 'super', margin: '0 1px', lineHeight: 0 }}>
        {text}
      </sup>
    )
  }

  if (style.sub) {
    return (
      <sub key={key} style={{ ...contentStyle, fontSize: '0.72em', verticalAlign: 'sub', margin: '0 1px', lineHeight: 0 }}>
        {text}
      </sub>
    )
  }

  return (
    <span key={key} style={contentStyle}>
      {text}
    </span>
  )
}

function renderSegments(segments: OcrInlineSegment[], keyPrefix: string, options: RenderOptions = {}): React.ReactNode[] {
  const transformText = options.transformText || ((value: string) => value)
  return segments.map((segment, index) => renderStyledPiece(transformText(segment.text), segment.style, `${keyPrefix}-${index}`))
}

export function renderOcrInlineText(text: string, keyPrefix: string, options: RenderOptions = {}): React.ReactNode[] {
  return renderSegments(parseOcrInlineText(text), keyPrefix, options)
}

export function renderOcrInlineHighlighted(
  text: string,
  keyword: string,
  keyPrefix: string,
  active = false,
  options: RenderOptions = {},
): React.ReactNode[] {
  const query = String(keyword || '').trim()
  if (!query) return renderOcrInlineText(text, keyPrefix, options)

  const transformText = options.transformText || ((value: string) => value)
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const regex = new RegExp(`(${escaped})`, 'gi')
  const nodes: React.ReactNode[] = []

  parseOcrInlineText(text).forEach((segment, segmentIndex) => {
    const displayText = transformText(segment.text)
    const pieces = displayText.split(regex)
    if (pieces.length <= 1) {
      nodes.push(renderStyledPiece(displayText, segment.style, `${keyPrefix}-${segmentIndex}`))
      return
    }

    pieces.forEach((piece, pieceIndex) => {
      if (!piece) return
      const key = `${keyPrefix}-${segmentIndex}-${pieceIndex}`
      if (pieceIndex % 2 === 1) {
        nodes.push(
          <mark
            key={key}
            data-search-hit="true"
            data-search-active={active ? 'true' : undefined}
            style={{
              backgroundColor: active ? '#ff9f1a' : '#ffc069',
              color: active ? '#1f1608' : 'inherit',
              padding: '0 2px',
              borderRadius: 2,
              fontWeight: active ? 800 : 600,
              outline: active ? '2px solid rgba(255,242,184,0.85)' : 'none',
            }}
          >
            {renderStyledPiece(piece, segment.style, `${key}-style`)}
          </mark>,
        )
        return
      }
      nodes.push(renderStyledPiece(piece, segment.style, key))
    })
  })

  return nodes
}
