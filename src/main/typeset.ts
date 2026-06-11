import { getDataDir } from './database'
import { join } from 'path'
import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { getErrorMessage } from '../shared/errors'
import type {
  TypesetAnnotationItem,
  TypesetCompileResult,
  TypesetLuaTeXStatus,
  TypesetMetadata,
  TypesetPackageStatus,
  TypesetTemplate,
} from '../shared/types'

const execFileAsync = promisify(execFile)

export async function checkLuaTeX(): Promise<TypesetLuaTeXStatus> {
  const commands = ['lualatex', 'lualatex.exe']
  for (const cmd of commands) {
    try {
      const { stdout } = await execFileAsync(cmd, ['--version'], { timeout: 10000 })
      const versionMatch = stdout.match(/LuaTeX,\s*Version\s*([\d.]+)/)
      return {
        available: true,
        path: cmd,
        version: versionMatch ? versionMatch[1] : 'unknown'
      }
    } catch (e) {
      continue
    }
  }

  const texlivePaths = [
    'C:\\texlive\\2024\\bin\\windows\\lualatex.exe',
    'C:\\texlive\\2025\\bin\\windows\\lualatex.exe',
    '/usr/local/bin/lualatex',
    '/usr/bin/lualatex'
  ]

  for (const p of texlivePaths) {
    if (existsSync(p)) {
      try {
        const { stdout } = await execFileAsync(p, ['--version'], { timeout: 10000 })
        const versionMatch = stdout.match(/LuaTeX,\s*Version\s*([\d.]+)/)
        return {
          available: true,
          path: p,
          version: versionMatch ? versionMatch[1] : 'unknown'
        }
      } catch (e) {
        continue
      }
    }
  }

  return { available: false, path: '', version: '' }
}

export async function checkLuatexCn(): Promise<TypesetPackageStatus> {
  try {
    const { stdout } = await execFileAsync('kpsewhich', ['ltc-guji.sty'], { timeout: 10000 })
    if (stdout.trim()) {
      return { installed: true, version: 'installed' }
    }
  } catch (e) {}

  const homeDir = process.env.USERPROFILE || process.env.HOME || ''
  const userTexmfPaths = [
    join(homeDir, 'texmf', 'tex', 'latex', 'luatex-cn'),
  ]

  for (const p of userTexmfPaths) {
    if (existsSync(join(p, 'ltc-guji.sty'))) {
      return { installed: true, version: 'local' }
    }
  }

  return { installed: false, version: '' }
}

function escapeTeX(text: string): string {
  return text
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\$/g, '\\$')
    .replace(/&/g, '\\&')
    .replace(/%/g, '\\%')
    .replace(/#/g, '\\#')
    .replace(/_/g, '\\_')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}')
}

function annotationToTeX(item: TypesetAnnotationItem): string {
  const content = escapeTeX(item.content)

  switch (item.type) {
    case 'title':
      return `\\title{${content}}\n`
    case 'chapter':
      return `\\chapter{${content}}\n`
    case 'body':
      return `${content}`
    case 'jiaZhu':
      return `\\夹注{${content}}`
    case 'cePi':
      return `\\侧批{${content}}`
    case 'meiPi':
      return `\\眉批{${content}}`
    case 'jiaoZhu':
      return `\\脚注{${content}}`
    case 'seal':
      return `\\印章{${content}}`
    default:
      return content
  }
}

export function generateTeX(
  annotations: TypesetAnnotationItem[],
  template: TypesetTemplate = '四库全书',
  metadata?: TypesetMetadata
): string {
  const templateOption = template

  let bodyContent = ''
  let titleLine = ''
  let chapterLine = ''

  for (const item of annotations) {
    if (item.type === 'title') {
      titleLine = `\\title{${escapeTeX(item.content)}}\n`
    } else if (item.type === 'chapter') {
      chapterLine = `\\chapter{${escapeTeX(item.content)}}\n`
    } else {
      bodyContent += annotationToTeX(item)
    }
  }

  const docTitle = metadata?.title || titleLine.replace(/\\title\{(.+)\}\n?/, '$1') || '文献'
  const docAuthor = metadata?.author || ''
  const docDynasty = metadata?.dynasty || ''

  return `\\documentclass[${templateOption}]{ltc-guji}
\\句读模式

${titleLine || `\\title{${escapeTeX(docTitle)}}`}
${chapterLine}
\\begin{document}
\\begin{正文}

${bodyContent}

\\end{正文}
\\end{document}
`
}

export async function compileTeX(
  texContent: string,
  docId: string,
  times: number = 2
): Promise<TypesetCompileResult> {
  const dataDir = getDataDir()
  const compileDir = join(dataDir, 'tex_output', docId)
  if (!existsSync(compileDir)) {
    mkdirSync(compileDir, { recursive: true })
  }

  const texPath = join(compileDir, 'document.tex')
  writeFileSync(texPath, texContent, 'utf-8')

  const ltResult = await checkLuaTeX()
  if (!ltResult.available) {
    return {
      success: false,
      pdfPath: '',
      log: '',
      error: '未找到 LuaTeX，请先安装 TeX Live（推荐 2024 或更新版本）。下载地址：https://tug.org/texlive/acquire-netinstall.html'
    }
  }

  let fullLog = ''
  for (let i = 0; i < times; i++) {
    try {
      const { stdout, stderr } = await execFileAsync(
        ltResult.path,
        ['--interaction=nonstopmode', '--halt-on-error', 'document.tex'],
        {
          cwd: compileDir,
          timeout: 120000,
          maxBuffer: 10 * 1024 * 1024
        }
      )
      fullLog += stdout + stderr
    } catch (error: unknown) {
      const logPath = join(compileDir, 'document.log')
      let logContent = ''
      if (existsSync(logPath)) {
        logContent = readFileSync(logPath, 'utf-8')
      }
      const stderr = error && typeof error === 'object' && 'stderr' in error
        ? String((error as { stderr?: unknown }).stderr || '')
        : ''
      return {
        success: false,
        pdfPath: '',
        log: logContent || fullLog || stderr,
        error: `编译失败（第 ${i + 1} 次编译）: ${getErrorMessage(error, '未知错误')}`
      }
    }
  }

  const pdfPath = join(compileDir, 'document.pdf')
  if (existsSync(pdfPath)) {
    return {
      success: true,
      pdfPath,
      log: fullLog
    }
  }

  return {
    success: false,
    pdfPath: '',
    log: fullLog,
    error: '编译完成但未生成 PDF 文件'
  }
}
