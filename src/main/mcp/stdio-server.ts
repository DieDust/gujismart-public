/**
 * Minimal MCP (Model Context Protocol) server over stdio.
 * No public network: AI clients spawn this process locally.
 */
import { createInterface } from 'readline'
import { MCP_TOOL_DEFINITIONS, callLibraryTool } from './library-tools'

const SERVER_INFO = {
  name: 'gujismart',
  version: '1.1.5',
}

type JsonRpcId = string | number | null

interface JsonRpcRequest {
  jsonrpc?: string
  id?: JsonRpcId
  method?: string
  params?: Record<string, unknown>
}

function writeMessage(payload: unknown): void {
  const body = JSON.stringify(payload)
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`)
}

function writeResult(id: JsonRpcId, result: unknown): void {
  writeMessage({ jsonrpc: '2.0', id, result })
}

function writeError(id: JsonRpcId, code: number, message: string): void {
  writeMessage({ jsonrpc: '2.0', id, error: { code, message } })
}

/** Also accept newline-delimited JSON (some clients use NDJSON instead of LSP framing). */
function parseIncoming(chunk: string): JsonRpcRequest[] {
  const trimmed = chunk.trim()
  if (!trimmed) return []
  if (trimmed.startsWith('{')) {
    try {
      return [JSON.parse(trimmed) as JsonRpcRequest]
    } catch {
      return []
    }
  }
  return []
}

async function handleRequest(message: JsonRpcRequest): Promise<void> {
  const id = message.id ?? null
  const method = String(message.method || '')
  const params = (message.params || {}) as Record<string, unknown>

  try {
    if (method === 'initialize') {
      writeResult(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      })
      return
    }

    if (method === 'notifications/initialized' || method === 'initialized') {
      return
    }

    if (method === 'ping') {
      writeResult(id, {})
      return
    }

    if (method === 'tools/list') {
      writeResult(id, {
        tools: MCP_TOOL_DEFINITIONS.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      })
      return
    }

    if (method === 'tools/call') {
      const name = String(params.name || '')
      const args = (params.arguments && typeof params.arguments === 'object'
        ? params.arguments
        : {}) as Record<string, unknown>
      const result = await callLibraryTool(name, args)
      writeResult(id, {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
        structuredContent: result,
        isError: Boolean(result && typeof result === 'object' && (result as { ok?: boolean }).ok === false),
      })
      return
    }

    if (id !== undefined && id !== null) {
      writeError(id, -32601, `Method not found: ${method}`)
    }
  } catch (error) {
    if (id !== undefined && id !== null) {
      writeError(id, -32000, error instanceof Error ? error.message : String(error))
    }
  }
}

/**
 * MCP over stdio: supports both Content-Length framing and newline JSON.
 */
export async function runMcpStdioServer(): Promise<void> {
  // Prevent accidental logging from corrupting the MCP stream.
  const originalLog = console.log
  const originalInfo = console.info
  const originalWarn = console.warn
  console.log = (...args: unknown[]) => {
    process.stderr.write(`${args.map(String).join(' ')}\n`)
  }
  console.info = (...args: unknown[]) => {
    process.stderr.write(`${args.map(String).join(' ')}\n`)
  }
  console.warn = (...args: unknown[]) => {
    process.stderr.write(`${args.map(String).join(' ')}\n`)
  }

  let buffer = ''
  process.stdin.setEncoding('utf8')

  const processBuffer = async () => {
    while (true) {
      // LSP-style Content-Length framing
      const headerEnd = buffer.indexOf('\r\n\r\n')
      if (headerEnd >= 0) {
        const header = buffer.slice(0, headerEnd)
        const match = /Content-Length:\s*(\d+)/i.exec(header)
        if (!match) {
          buffer = buffer.slice(headerEnd + 4)
          continue
        }
        const length = Number(match[1])
        const bodyStart = headerEnd + 4
        const bodyEnd = bodyStart + length
        if (buffer.length < bodyEnd) return
        const body = buffer.slice(bodyStart, bodyEnd)
        buffer = buffer.slice(bodyEnd)
        try {
          const message = JSON.parse(body) as JsonRpcRequest
          await handleRequest(message)
        } catch (error) {
          process.stderr.write(`[gujismart-mcp] bad frame: ${error}\n`)
        }
        continue
      }

      // NDJSON fallback: one JSON object per line
      const nl = buffer.indexOf('\n')
      if (nl < 0) return
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      for (const message of parseIncoming(line)) {
        await handleRequest(message)
      }
    }
  }

  process.stdin.on('data', (chunk: string) => {
    buffer += chunk
    void processBuffer()
  })

  process.stdin.on('end', () => {
    console.log = originalLog
    console.info = originalInfo
    console.warn = originalWarn
    process.exit(0)
  })

  process.stderr.write('[gujismart-mcp] ready (stdio MCP, read-only library tools)\n')
}

/** For regression tests without stdio loop. */
export async function handleMcpJsonRpcForTest(message: JsonRpcRequest): Promise<unknown> {
  const captured: unknown[] = []
  const originalWrite = process.stdout.write.bind(process.stdout)
  ;(process.stdout as { write: typeof process.stdout.write }).write = ((chunk: string | Uint8Array) => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    const idx = text.indexOf('{')
    if (idx >= 0) {
      try {
        captured.push(JSON.parse(text.slice(idx)))
      } catch {
        // ignore
      }
    }
    return true
  }) as typeof process.stdout.write
  try {
    await handleRequest(message)
  } finally {
    process.stdout.write = originalWrite
  }
  return captured[captured.length - 1]
}

export { createInterface }
