import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { createWriteStream, existsSync, mkdirSync, statSync } from 'fs'
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { basename, dirname, extname, join, resolve, sep } from 'path'
import { app } from 'electron'
import JSZip from 'jszip'
import { getResponseErrorMessage, isAbortError } from '../shared/errors'
import type {
  LocalPaddleOcrDownloadOptions,
  LocalPaddleOcrDownloadProgress,
  LocalPaddleOcrDownloadSourceId,
  LocalPaddleOcrSource,
  LocalPaddleOcrStatus,
  OcrRecognizeLayoutBlock,
  OcrRecognizeResult,
  OcrRecognizeWordResult,
} from '../shared/types'
import type { OcrPageProgressPayload, OcrPageRecord, OcrPageResult } from './ocr'

type JsonRecord = Record<string, unknown>
type DownloadProgressReporter = (progress: LocalPaddleOcrDownloadProgress) => void

const PROJECT_GITHUB_REPO = 'DieDust/gujismart-public'
const LOCAL_PADDLE_OCR_ADDON_NAME = 'GujiSmart-OCR-PP-OCRv6-small-win-x64.zip'
const LOCAL_PADDLE_OCR_BUNDLE_VERSION = 'PP-OCRv6-small'
const LOCAL_PADDLE_OCR_ROOT = 'ocr-addons'
const LOCAL_PADDLE_OCR_DIR = 'pp-ocrv6-small'
const OFFICIAL_MODEL_BASE_URL = 'https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0'
const PP_OCRV6_SMALL_DET_NAME = 'PP-OCRv6_small_det_infer.tar'
const PP_OCRV6_SMALL_REC_NAME = 'PP-OCRv6_small_rec_infer.tar'

const LOCAL_PADDLE_OCR_SOURCES: LocalPaddleOcrSource[] = [
  {
    id: 'github_release',
    label: 'GujiSmart Release addon',
    kind: 'addon',
    url: `https://github.com/${PROJECT_GITHUB_REPO}/releases/latest/download/${LOCAL_PADDLE_OCR_ADDON_NAME}`,
  },
  {
    id: 'paddle_bos',
    label: 'Paddle 官方 BOS 模型源',
    kind: 'model',
    url: `${OFFICIAL_MODEL_BASE_URL}/${PP_OCRV6_SMALL_DET_NAME}`,
    bytes: 10055680,
  },
  {
    id: 'modelscope',
    label: 'ModelScope 官方 PP-OCRv6 集合',
    kind: 'catalog',
    url: 'https://www.modelscope.cn/collections/PaddlePaddle/PP-OCRv6',
  },
  {
    id: 'huggingface',
    label: 'HuggingFace 官方 PP-OCRv6 集合',
    kind: 'catalog',
    url: 'https://huggingface.co/collections/PaddlePaddle/pp-ocrv6',
  },
  {
    id: 'manual',
    label: '手动导入本地 addon',
    kind: 'manual',
    url: '',
  },
]

interface DownloadArtifact {
  sourceId: Exclude<LocalPaddleOcrDownloadSourceId, 'auto' | 'manual'>
  url: string
  fileName: string
  expectedBytes?: number
}

interface RunnerInvocationResult {
  payload: unknown
  stderr: string
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

function getLocalPaddleOcrInstallPath(): string {
  return join(app.getPath('userData'), LOCAL_PADDLE_OCR_ROOT, LOCAL_PADDLE_OCR_DIR)
}

function getLocalPaddleOcrDownloadPath(): string {
  return join(app.getPath('userData'), LOCAL_PADDLE_OCR_ROOT, 'downloads')
}

function getManifestPath(): string {
  return join(getLocalPaddleOcrInstallPath(), 'manifest.json')
}

function firstExistingPath(candidates: string[]): string | undefined {
  return candidates.find((candidate) => existsSync(candidate))
}

function getPathIfReadable(candidate: string): string | undefined {
  if (!existsSync(candidate)) return undefined
  try {
    const stat = statSync(candidate)
    return stat.isFile() || stat.isDirectory() ? candidate : undefined
  } catch {
    return undefined
  }
}

function resolveLocalPaddleOcrPaths() {
  const installPath = getLocalPaddleOcrInstallPath()
  const runnerPath = firstExistingPath([
    join(installPath, 'runner', 'gujismart-paddleocr-runner.exe'),
    join(installPath, 'gujismart-paddleocr-runner.exe'),
    join(installPath, 'runner', 'run_paddleocr.py'),
    join(installPath, 'run_paddleocr.py'),
  ])
  const pythonPath = firstExistingPath([
    join(installPath, 'python', 'python.exe'),
    join(installPath, 'runtime', 'python.exe'),
  ])
  const modelPath = firstExistingPath([
    join(installPath, 'models'),
    join(installPath, 'model'),
  ]) || join(installPath, 'models')
  const detModelPath = firstExistingPath([
    join(modelPath, 'PP-OCRv6_small_det_infer'),
    join(modelPath, 'det', 'PP-OCRv6_small_det_infer'),
    join(modelPath, PP_OCRV6_SMALL_DET_NAME),
    join(modelPath, 'det', PP_OCRV6_SMALL_DET_NAME),
  ])
  const recModelPath = firstExistingPath([
    join(modelPath, 'PP-OCRv6_small_rec_infer'),
    join(modelPath, 'rec', 'PP-OCRv6_small_rec_infer'),
    join(modelPath, PP_OCRV6_SMALL_REC_NAME),
    join(modelPath, 'rec', PP_OCRV6_SMALL_REC_NAME),
  ])
  return {
    installPath,
    runnerPath: runnerPath ? getPathIfReadable(runnerPath) : undefined,
    pythonPath: pythonPath ? getPathIfReadable(pythonPath) : undefined,
    modelPath,
    detModelPath: detModelPath ? getPathIfReadable(detModelPath) : undefined,
    recModelPath: recModelPath ? getPathIfReadable(recModelPath) : undefined,
  }
}

async function readManifestUpdatedAt(): Promise<string | undefined> {
  try {
    const raw = await readFile(getManifestPath(), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed) && typeof parsed.updatedAt === 'string' ? parsed.updatedAt : undefined
  } catch {
    return undefined
  }
}

export function listLocalPaddleOcrSources(): LocalPaddleOcrSource[] {
  return LOCAL_PADDLE_OCR_SOURCES.map((source) => ({ ...source }))
}

export async function getLocalPaddleOcrStatus(): Promise<LocalPaddleOcrStatus> {
  const paths = resolveLocalPaddleOcrPaths()
  const hasRunner = !!paths.runnerPath
  const hasModels = !!paths.detModelPath && !!paths.recModelPath
  const hasAnyInstallAsset = hasRunner || !!paths.detModelPath || !!paths.recModelPath || existsSync(getManifestPath())
  const installed = hasRunner && hasModels
  return {
    installed,
    state: installed ? 'installed' : hasAnyInstallAsset ? 'partial' : 'not_installed',
    bundleVersion: LOCAL_PADDLE_OCR_BUNDLE_VERSION,
    installPath: paths.installPath,
    runnerPath: paths.runnerPath,
    pythonPath: paths.pythonPath,
    modelPath: paths.modelPath,
    detModelPath: paths.detModelPath,
    recModelPath: paths.recModelPath,
    message: installed
      ? '本地 PaddleOCR 已就绪'
      : hasAnyInstallAsset
      ? '已检测到部分本地 OCR 文件，还缺少 runner 或完整模型，请导入完整 addon'
      : '本地 PaddleOCR 尚未安装',
    sources: listLocalPaddleOcrSources(),
    updatedAt: await readManifestUpdatedAt(),
  }
}

export async function checkLocalPaddleOcrSources(): Promise<LocalPaddleOcrSource[]> {
  const sources = listLocalPaddleOcrSources()
  return Promise.all(sources.map(async (source) => {
    if (!source.url) return { ...source, available: true }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8_000)
    try {
      const response = await fetch(source.url, { method: 'HEAD', signal: controller.signal })
      return {
        ...source,
        available: response.ok,
        statusCode: response.status,
        bytes: Number(response.headers.get('content-length') || source.bytes || 0) || source.bytes,
      }
    } catch (error) {
      return {
        ...source,
        available: false,
        error: getResponseErrorMessage(error, '源不可访问'),
      }
    } finally {
      clearTimeout(timeout)
    }
  }))
}

function getArtifactsForSource(source: LocalPaddleOcrDownloadSourceId): DownloadArtifact[] {
  if (source === 'github_release') {
    return [{
      sourceId: 'github_release',
      url: `https://github.com/${PROJECT_GITHUB_REPO}/releases/latest/download/${LOCAL_PADDLE_OCR_ADDON_NAME}`,
      fileName: LOCAL_PADDLE_OCR_ADDON_NAME,
    }]
  }
  if (source === 'paddle_bos') {
    return [
      {
        sourceId: 'paddle_bos',
        url: `${OFFICIAL_MODEL_BASE_URL}/${PP_OCRV6_SMALL_DET_NAME}`,
        fileName: PP_OCRV6_SMALL_DET_NAME,
        expectedBytes: 10055680,
      },
      {
        sourceId: 'paddle_bos',
        url: `${OFFICIAL_MODEL_BASE_URL}/${PP_OCRV6_SMALL_REC_NAME}`,
        fileName: PP_OCRV6_SMALL_REC_NAME,
        expectedBytes: 21442560,
      },
    ]
  }
  throw new Error('该源是模型目录页，请使用自动下载、官方源，或手动导入完整 addon')
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  hash.update(await readFile(filePath))
  return hash.digest('hex')
}

async function downloadArtifact(
  artifact: DownloadArtifact,
  outputPath: string,
  cumulativeBytes: number,
  expectedTotalBytes: number,
  report?: DownloadProgressReporter,
): Promise<{ filePath: string; bytes: number; sha256: string }> {
  await mkdir(outputPath, { recursive: true })
  const finalPath = join(outputPath, artifact.fileName)
  const partPath = `${finalPath}.part`
  const resumeBytes = existsSync(partPath) ? statSync(partPath).size : 0
  const headers: Record<string, string> = {}
  if (resumeBytes > 0) headers.Range = `bytes=${resumeBytes}-`

  const response = await fetch(artifact.url, { headers })
  if (!response.ok && !(response.status === 416 && resumeBytes > 0)) {
    throw new Error(`下载失败：HTTP ${response.status}`)
  }
  if (response.status === 416 && resumeBytes > 0) {
    await rename(partPath, finalPath)
    return {
      filePath: finalPath,
      bytes: statSync(finalPath).size,
      sha256: await sha256File(finalPath),
    }
  }
  const totalBytes = Number(response.headers.get('content-length') || 0)
  const expectedBytes = artifact.expectedBytes || (resumeBytes + totalBytes)
  const stream = createWriteStream(partPath, { flags: resumeBytes > 0 && response.status === 206 ? 'a' : 'w' })
  let bytesDone = resumeBytes > 0 && response.status === 206 ? resumeBytes : 0
  const reader = response.body?.getReader()
  if (!reader) throw new Error('下载响应没有可读取数据流')
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      const buffer = Buffer.from(chunk.value)
      bytesDone += buffer.length
      if (!stream.write(buffer)) {
        await new Promise<void>((resolveDrain) => stream.once('drain', resolveDrain))
      }
      report?.({
        state: 'downloading',
        sourceId: artifact.sourceId,
        fileName: artifact.fileName,
        bytesDone: cumulativeBytes + bytesDone,
        totalBytes: expectedTotalBytes || expectedBytes,
        progress: expectedTotalBytes > 0 ? Math.min(1, (cumulativeBytes + bytesDone) / expectedTotalBytes) : undefined,
        message: `正在下载 ${artifact.fileName}`,
      })
    }
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => {
      stream.once('error', rejectClose)
      stream.end(() => resolveClose())
    })
  }
  await rename(partPath, finalPath)
  const actualBytes = statSync(finalPath).size
  if (artifact.expectedBytes && actualBytes !== artifact.expectedBytes) {
    throw new Error(`${artifact.fileName} 文件大小校验失败：${actualBytes}/${artifact.expectedBytes}`)
  }
  return {
    filePath: finalPath,
    bytes: actualBytes,
    sha256: await sha256File(finalPath),
  }
}

async function ensureZipSafePath(root: string, relativePath: string): Promise<string> {
  const normalizedRoot = resolve(root)
  const targetPath = resolve(root, relativePath)
  if (targetPath !== normalizedRoot && !targetPath.startsWith(`${normalizedRoot}${sep}`)) {
    throw new Error(`addon 包含非法路径：${relativePath}`)
  }
  return targetPath
}

async function extractAddonZip(zipPath: string, report?: DownloadProgressReporter): Promise<void> {
  const installPath = getLocalPaddleOcrInstallPath()
  const zip = await JSZip.loadAsync(await readFile(zipPath))
  const entries = Object.values(zip.files)
  let extracted = 0
  for (const entry of entries) {
    const targetPath = await ensureZipSafePath(installPath, entry.name)
    if (entry.dir) {
      await mkdir(targetPath, { recursive: true })
      continue
    }
    await mkdir(dirname(targetPath), { recursive: true })
    await writeFile(targetPath, await entry.async('nodebuffer'))
    extracted += 1
    report?.({
      state: 'installing',
      sourceId: 'github_release',
      fileName: basename(zipPath),
      progress: entries.length > 0 ? Math.min(1, extracted / entries.length) : undefined,
      message: `正在安装本地 OCR addon：${extracted}/${entries.length}`,
    })
  }
}

async function installOfficialModelArtifacts(downloads: Array<{ filePath: string; bytes: number; sha256: string }>): Promise<void> {
  const modelDir = join(getLocalPaddleOcrInstallPath(), 'models')
  await mkdir(modelDir, { recursive: true })
  for (const item of downloads) {
    await copyFile(item.filePath, join(modelDir, basename(item.filePath)))
  }
}

async function writeInstallManifest(sourceId: LocalPaddleOcrDownloadSourceId, downloads: Array<{ filePath: string; bytes: number; sha256: string }>): Promise<void> {
  const manifest = {
    bundleVersion: LOCAL_PADDLE_OCR_BUNDLE_VERSION,
    sourceId,
    updatedAt: new Date().toISOString(),
    downloads: downloads.map((item) => ({
      fileName: basename(item.filePath),
      bytes: item.bytes,
      sha256: item.sha256,
    })),
  }
  await mkdir(getLocalPaddleOcrInstallPath(), { recursive: true })
  await writeFile(getManifestPath(), JSON.stringify(manifest, null, 2), 'utf8')
}

export async function importLocalPaddleOcrAddon(filePath: string, report?: DownloadProgressReporter): Promise<LocalPaddleOcrStatus> {
  const normalizedPath = String(filePath || '').trim()
  if (!normalizedPath || !existsSync(normalizedPath)) throw new Error('请选择可访问的本地 OCR addon 文件')
  if (extname(normalizedPath).toLowerCase() !== '.zip') throw new Error('目前仅支持导入 .zip 格式的 OCR addon')
  await mkdir(getLocalPaddleOcrInstallPath(), { recursive: true })
  await extractAddonZip(normalizedPath, (progress) => report?.({ ...progress, sourceId: 'manual' }))
  await writeInstallManifest('manual', [{
    filePath: normalizedPath,
    bytes: statSync(normalizedPath).size,
    sha256: await sha256File(normalizedPath),
  }])
  report?.({ state: 'completed', sourceId: 'manual', progress: 1, message: '本地 OCR addon 已导入' })
  return getLocalPaddleOcrStatus()
}

export async function downloadLocalPaddleOcrAddon(options: LocalPaddleOcrDownloadOptions = {}, report?: DownloadProgressReporter): Promise<LocalPaddleOcrStatus> {
  const source = options.source || 'auto'
  if (source === 'manual') {
    if (!options.manualPath) throw new Error('手动导入需要提供 addon 路径')
    return importLocalPaddleOcrAddon(options.manualPath, report)
  }

  const sourcePlan: Array<Exclude<LocalPaddleOcrDownloadSourceId, 'auto' | 'manual'>> = source === 'auto'
    ? ['github_release', 'paddle_bos']
    : source === 'github_release' || source === 'paddle_bos'
    ? [source]
    : []
  if (sourcePlan.length === 0) {
    throw new Error('该源不是可直接下载的 addon 文件，请使用自动源、官方源，或手动导入 addon')
  }

  let lastError: unknown = null
  await mkdir(getLocalPaddleOcrDownloadPath(), { recursive: true })
  await mkdir(getLocalPaddleOcrInstallPath(), { recursive: true })
  for (const sourceId of sourcePlan) {
    const artifacts = getArtifactsForSource(sourceId)
    const expectedTotalBytes = artifacts.reduce((sum, artifact) => sum + (artifact.expectedBytes || 0), 0)
    const downloads: Array<{ filePath: string; bytes: number; sha256: string }> = []
    let cumulativeBytes = 0
    try {
      report?.({ state: 'checking', sourceId, progress: 0, message: '正在检查本地 OCR 下载源' })
      for (const artifact of artifacts) {
        let result: { filePath: string; bytes: number; sha256: string } | null = null
        let artifactError: unknown = null
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          try {
            result = await downloadArtifact(
              artifact,
              getLocalPaddleOcrDownloadPath(),
              cumulativeBytes,
              expectedTotalBytes,
              report,
            )
            break
          } catch (error) {
            artifactError = error
            if (attempt < 2) {
              report?.({
                state: 'downloading',
                sourceId,
                fileName: artifact.fileName,
                bytesDone: cumulativeBytes,
                totalBytes: expectedTotalBytes,
                message: `${artifact.fileName} 下载失败，正在重试`,
                error: getResponseErrorMessage(error, '下载失败'),
              })
              await delay(800)
            }
          }
        }
        if (!result) throw artifactError || new Error(`${artifact.fileName} 下载失败`)
        downloads.push(result)
        cumulativeBytes += result.bytes
      }
      report?.({ state: 'installing', sourceId, progress: 0.9, message: '正在安装本地 OCR 文件' })
      if (sourceId === 'github_release') {
        await extractAddonZip(downloads[0].filePath, report)
      } else {
        await installOfficialModelArtifacts(downloads)
      }
      await writeInstallManifest(sourceId, downloads)
      const status = await getLocalPaddleOcrStatus()
      report?.({
        state: status.installed ? 'completed' : 'error',
        sourceId,
        progress: status.installed ? 1 : 0.95,
        message: status.installed ? '本地 OCR 已安装' : status.message,
        error: status.installed ? undefined : status.message,
      })
      return status
    } catch (error) {
      lastError = error
      await rm(getLocalPaddleOcrDownloadPath(), { recursive: true, force: true }).catch(() => undefined)
      report?.({
        state: 'error',
        sourceId,
        message: sourcePlan.length > 1 ? '当前源下载失败，准备尝试备用源' : '本地 OCR 下载失败',
        error: getResponseErrorMessage(error, '本地 OCR 下载失败'),
      })
    }
  }
  throw new Error(getResponseErrorMessage(lastError, '本地 OCR 下载失败'))
}

function normalizeRunnerOutput(page: OcrPageRecord, payload: unknown): OcrPageResult {
  const record = isRecord(payload) ? payload : { text: String(payload || '') }
  const wordsResult = Array.isArray(record.words_result)
    ? record.words_result as OcrRecognizeWordResult[]
    : []
  const layoutResult = Array.isArray(record.layout_result)
    ? record.layout_result as OcrRecognizeLayoutBlock[]
    : []
  const text = String(
    record.ocr_text
      || record.text
      || wordsResult.map((item) => item.words || '').filter(Boolean).join('\n')
      || layoutResult.map((item) => item.words || item.text || '').filter(Boolean).join('\n')
      || '',
  )
  const result: OcrRecognizeResult & JsonRecord = {
    ...record,
    text,
    ocr_text: text,
    source_type: String(record.source_type || 'local_paddle_ocr'),
    words_result: wordsResult,
    layout_result: layoutResult,
  }
  return {
    pageId: page.id,
    result,
    text,
    status: 'completed',
  }
}

function runLocalPaddleRunner(page: OcrPageRecord, status: LocalPaddleOcrStatus): Promise<RunnerInvocationResult> {
  return new Promise((resolveRun, rejectRun) => {
    if (!status.runnerPath) {
      rejectRun(new Error('本地 PaddleOCR runner 缺失，请重新导入完整 OCR addon'))
      return
    }
    if (!page.image_path) {
      rejectRun(new Error(`第 ${page.page_num || ''} 页缺少可识别图片`))
      return
    }
    const isPythonScript = extname(status.runnerPath).toLowerCase() === '.py'
    const command = isPythonScript ? status.pythonPath || 'python' : status.runnerPath
    const args = isPythonScript
      ? [status.runnerPath, '--image', page.image_path, '--model-dir', status.modelPath || '', '--json']
      : ['--image', page.image_path, '--model-dir', status.modelPath || '', '--json']
    const child = spawn(command, args.filter((item) => item.length > 0), {
      windowsHide: true,
      cwd: status.installPath,
      env: {
        ...process.env,
        GUJISMART_OCR_MODEL_DIR: status.modelPath || '',
        GUJISMART_OCR_DET_MODEL: status.detModelPath || '',
        GUJISMART_OCR_REC_MODEL: status.recModelPath || '',
      },
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', rejectRun)
    child.on('close', (code) => {
      const errorText = Buffer.concat(stderr).toString('utf8').trim()
      const outputText = Buffer.concat(stdout).toString('utf8').trim()
      if (code !== 0) {
        rejectRun(new Error(errorText || `本地 PaddleOCR runner 退出码 ${code}`))
        return
      }
      try {
        resolveRun({ payload: outputText ? JSON.parse(outputText) : {}, stderr: errorText })
      } catch {
        resolveRun({ payload: { text: outputText }, stderr: errorText })
      }
    })
  })
}

export async function recognizePagesWithLocalPaddle(
  pages: OcrPageRecord[],
  onProgress?: (payload: OcrPageProgressPayload) => void,
): Promise<OcrPageResult[]> {
  const status = await getLocalPaddleOcrStatus()
  if (!status.installed) {
    throw new Error(status.message || '本地 PaddleOCR 尚未安装，请先在设置页下载或导入本地 OCR addon')
  }
  const totalPages = pages.length
  let completedPages = 0
  const results: OcrPageResult[] = []
  for (const page of pages) {
    try {
      const output = await runLocalPaddleRunner(page, status)
      const result = normalizeRunnerOutput(page, output.payload)
      completedPages += 1
      onProgress?.({
        pageId: page.id,
        pageNum: typeof page.page_num === 'number' ? page.page_num : undefined,
        completedPages,
        totalPages,
        status: 'completed',
        result: result.result,
        text: result.text,
      })
      results.push(result)
    } catch (error) {
      if (isAbortError(error)) throw error
      const message = getResponseErrorMessage(error, '本地 PaddleOCR 识别失败')
      completedPages += 1
      onProgress?.({
        pageId: page.id,
        pageNum: typeof page.page_num === 'number' ? page.page_num : undefined,
        completedPages,
        totalPages,
        status: 'error',
        error: message,
      })
      results.push({
        pageId: page.id,
        result: null,
        text: '',
        status: 'error',
        error: message,
      })
    }
  }
  return results
}
