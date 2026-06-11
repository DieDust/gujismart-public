import { spawn } from 'child_process'
import { app } from 'electron'
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { basename, extname, join } from 'path'
import { PDFDocument } from 'pdf-lib'

const QPDF_PAGE_COUNT_TIMEOUT_MS = 10_000

export interface MainPdfInfo {
  title: string
  pageCount: number
  source: 'qpdf' | 'pdf-lib'
}

function getResourceRoot(): string {
  return app.isPackaged ? process.resourcesPath : process.cwd()
}

function qpdfCandidatePaths(): string[] {
  const exeName = process.platform === 'win32' ? 'qpdf.exe' : 'qpdf'
  return [
    join(getResourceRoot(), 'vendor', 'qpdf', 'bin', exeName),
    join(getResourceRoot(), 'resources', 'vendor', 'qpdf', 'bin', exeName),
    join(process.cwd(), 'resources', 'vendor', 'qpdf', 'bin', exeName),
  ]
}

function resolveQpdfExecutable(): string {
  for (const candidate of qpdfCandidatePaths()) {
    if (existsSync(candidate)) return candidate
  }
  return 'qpdf'
}

function runQpdf(args: string[], timeoutMs = QPDF_PAGE_COUNT_TIMEOUT_MS): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(resolveQpdfExecutable(), args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`qpdf timed out after ${Math.round(timeoutMs / 1000)} seconds`))
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        resolvePromise({ stdout, stderr })
      } else {
        reject(new Error((stderr || stdout || `qpdf exited with code ${code}`).trim()))
      }
    })
  })
}

function defaultPdfTitle(filePath: string): string {
  return basename(filePath, extname(filePath)).trim() || '未命名文档'
}

async function readPageCountWithQpdf(filePath: string, warnOnFailure = true): Promise<number | null> {
  try {
    const result = await runQpdf(['--show-npages', filePath])
    const pageCount = Number(String(result.stdout || result.stderr || '').trim())
    return Number.isFinite(pageCount) && pageCount > 0 ? Math.floor(pageCount) : null
  } catch (error) {
    if (warnOnFailure) {
      console.warn('[PDF Info] qpdf page count failed; falling back to pdf-lib', error)
    }
    return null
  }
}

export async function getPdfPageCountFast(filePath: string): Promise<number | null> {
  if (!filePath || extname(filePath).toLowerCase() !== '.pdf') {
    return null
  }

  return readPageCountWithQpdf(filePath, false)
}

async function readInfoWithPdfLib(filePath: string): Promise<MainPdfInfo> {
  const bytes = await readFile(filePath)
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true })
  const title = String(pdf.getTitle() || '').trim() || defaultPdfTitle(filePath)
  return {
    title,
    pageCount: pdf.getPageCount(),
    source: 'pdf-lib',
  }
}

export async function getPdfInfo(filePath: string): Promise<MainPdfInfo> {
  if (!filePath || extname(filePath).toLowerCase() !== '.pdf') {
    throw new Error('PDF file path is invalid')
  }

  const qpdfPageCount = await readPageCountWithQpdf(filePath)
  if (qpdfPageCount && qpdfPageCount > 0) {
    return {
      title: defaultPdfTitle(filePath),
      pageCount: qpdfPageCount,
      source: 'qpdf',
    }
  }

  return readInfoWithPdfLib(filePath)
}
