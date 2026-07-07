import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { createWriteStream, existsSync, statSync } from 'fs'
import { mkdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { basename, dirname, extname, join, resolve, sep } from 'path'
import { app } from 'electron'
import JSZip from 'jszip'
import { getResponseErrorMessage, isAbortError } from '../shared/errors'
import { queryOne } from './database'
import type {
  LocalPaddleOcrDownloadOptions,
  LocalPaddleOcrDownloadProgress,
  LocalPaddleOcrDownloadSourceId,
  LocalPaddleOcrRuntimeStatus,
  LocalPaddleOcrSource,
  LocalPaddleOcrStatus,
  OcrRecognizeLayoutBlock,
  OcrRecognizeResult,
  OcrRecognizeWordResult,
} from '../shared/types'
import type { OcrPageProgressPayload, OcrPageRecord, OcrPageResult } from './ocr'

type JsonRecord = Record<string, unknown>
type DownloadProgressReporter = (progress: LocalPaddleOcrDownloadProgress) => void
type LocalPaddleOcrSize = 'tiny' | 'small' | 'medium'

const LOCAL_PADDLE_OCR_ROOT = 'ocr-addons'
const DEFAULT_LOCAL_PADDLE_OCR_SIZE: LocalPaddleOcrSize = 'small'
const OFFICIAL_MODEL_BASE_URL = 'https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0'
const LOCAL_PADDLE_OCR_RUNTIME_DIR = 'runtime-ppocrv6'
const REQUIRED_PADDLE_VERSION = '3.2.1'
const MAX_TESTED_PADDLE_VERSION_EXCLUSIVE = '3.3.0'
const REQUIRED_PADDLE_OCR_VERSION = '3.7.0'
const REQUIRED_PADDLEX_VERSION = '3.7.0'
const PADDLE_CPU_INDEX_URL = 'https://www.paddlepaddle.org.cn/packages/stable/cpu/'
const LOCAL_PADDLE_OCR_MODEL_PROFILES: Record<LocalPaddleOcrSize, {
  label: string
  dirName: string
  bundleVersion: string
  detName: string
  recName: string
  detBytes: number
  recBytes: number
}> = {
  tiny: {
    label: 'PP-OCRv6 tiny',
    dirName: 'pp-ocrv6-tiny',
    bundleVersion: 'PP-OCRv6-tiny',
    detName: 'PP-OCRv6_tiny_det_infer.tar',
    recName: 'PP-OCRv6_tiny_rec_infer.tar',
    detBytes: 1955840,
    recBytes: 4597760,
  },
  small: {
    label: 'PP-OCRv6 small',
    dirName: 'pp-ocrv6-small',
    bundleVersion: 'PP-OCRv6-small',
    detName: 'PP-OCRv6_small_det_infer.tar',
    recName: 'PP-OCRv6_small_rec_infer.tar',
    detBytes: 10055680,
    recBytes: 21442560,
  },
  medium: {
    label: 'PP-OCRv6 medium',
    dirName: 'pp-ocrv6-medium',
    bundleVersion: 'PP-OCRv6-medium',
    detName: 'PP-OCRv6_medium_det_infer.tar',
    recName: 'PP-OCRv6_medium_rec_infer.tar',
    detBytes: 62279680,
    recBytes: 76851200,
  },
}

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

interface PythonCommand {
  command: string
  argsPrefix: string[]
  label: string
  source: 'managed' | 'system'
}

interface ProcessResult {
  code: number | null
  stdout: string
  stderr: string
}

class DownloadHttpError extends Error {
  readonly status: number
  readonly url: string
  readonly fileName: string

  constructor(status: number, url: string, fileName: string) {
    super(`下载失败：HTTP ${status}`)
    this.name = 'DownloadHttpError'
    this.status = status
    this.url = url
    this.fileName = fileName
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

function compareVersions(a: string | undefined, b: string): number {
  const left = String(a || '0').split(/[^\d]+/).filter(Boolean).map((part) => Number(part) || 0)
  const right = String(b || '0').split(/[^\d]+/).filter(Boolean).map((part) => Number(part) || 0)
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index] || 0
    const rightPart = right[index] || 0
    if (leftPart > rightPart) return 1
    if (leftPart < rightPart) return -1
  }
  return 0
}

function isVersionAtLeast(value: string | undefined, minimum: string): boolean {
  return compareVersions(value, minimum) >= 0
}

function isVersionBelow(value: string | undefined, maximumExclusive: string): boolean {
  return compareVersions(value, maximumExclusive) < 0
}

function isPaddleRuntimeVersionSupported(value: string | undefined): boolean {
  return isVersionAtLeast(value, REQUIRED_PADDLE_VERSION)
    && isVersionBelow(value, MAX_TESTED_PADDLE_VERSION_EXCLUSIVE)
}

function normalizeLocalPaddleOcrSize(value: unknown): LocalPaddleOcrSize {
  return value === 'tiny' || value === 'small' || value === 'medium' ? value : DEFAULT_LOCAL_PADDLE_OCR_SIZE
}

function getLocalPaddleOcrSizePreference(): LocalPaddleOcrSize {
  const value = queryOne<{ value?: string | null }>('SELECT value FROM settings WHERE key = ?', ['local_paddle_ocr_size'])?.value
  return normalizeLocalPaddleOcrSize(String(value || '').trim())
}

function getLocalPaddleOcrModelProfile(size = getLocalPaddleOcrSizePreference()) {
  return LOCAL_PADDLE_OCR_MODEL_PROFILES[size]
}

function isNonRetryableDownloadError(error: unknown): boolean {
  if (!(error instanceof DownloadHttpError)) return false
  return error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429
}

function createLocalPaddleOcrSources(size = getLocalPaddleOcrSizePreference()): LocalPaddleOcrSource[] {
  const profile = getLocalPaddleOcrModelProfile(size)
  return [
    {
      id: 'paddle_bos',
      label: `Paddle 官方模型源（${profile.label}）`,
      kind: 'model',
      url: `${OFFICIAL_MODEL_BASE_URL}/${profile.detName}`,
      bytes: profile.detBytes + profile.recBytes,
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
  ]
}

function getLocalPaddleOcrInstallPath(size = getLocalPaddleOcrSizePreference()): string {
  return join(app.getPath('userData'), LOCAL_PADDLE_OCR_ROOT, getLocalPaddleOcrModelProfile(size).dirName)
}

function getLocalPaddleOcrDownloadPath(): string {
  return join(app.getPath('userData'), LOCAL_PADDLE_OCR_ROOT, 'downloads')
}

function getLocalPaddleOcrRuntimePath(): string {
  return join(app.getPath('userData'), LOCAL_PADDLE_OCR_ROOT, LOCAL_PADDLE_OCR_RUNTIME_DIR)
}

function getLocalPaddleOcrRuntimePythonPath(): string {
  return join(getLocalPaddleOcrRuntimePath(), process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
}

function getManifestPath(size = getLocalPaddleOcrSizePreference()): string {
  return join(getLocalPaddleOcrInstallPath(size), 'manifest.json')
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

function getDirectoryIfReadable(candidate: string): string | undefined {
  if (!existsSync(candidate)) return undefined
  try {
    return statSync(candidate).isDirectory() ? candidate : undefined
  } catch {
    return undefined
  }
}

function runProcess(
  command: string,
  args: string[],
  options: {
    cwd?: string
    env?: NodeJS.ProcessEnv
    timeoutMs?: number
    onOutput?: (text: string) => void
  } = {},
): Promise<ProcessResult> {
  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        ...options.env,
      },
      windowsHide: true,
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let settled = false
    const timeout = options.timeoutMs
      ? setTimeout(() => {
        if (settled) return
        settled = true
        child.kill()
        rejectProcess(new Error(`命令执行超时：${command}`))
      }, options.timeoutMs)
      : null

    const handleOutput = (chunk: Buffer, target: Buffer[]) => {
      target.push(chunk)
      const text = chunk.toString('utf8').trim()
      if (text) options.onOutput?.(text)
    }

    child.stdout.on('data', (chunk: Buffer) => handleOutput(chunk, stdout))
    child.stderr.on('data', (chunk: Buffer) => handleOutput(chunk, stderr))
    child.on('error', (error) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      rejectProcess(error)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      resolveProcess({
        code,
        stdout: Buffer.concat(stdout).toString('utf8').trim(),
        stderr: Buffer.concat(stderr).toString('utf8').trim(),
      })
    })
  })
}

async function runRequiredProcess(
  command: string,
  args: string[],
  label: string,
  options: Parameters<typeof runProcess>[2] = {},
): Promise<ProcessResult> {
  const result = await runProcess(command, args, options)
  if (result.code !== 0) {
    const output = [result.stderr, result.stdout].filter(Boolean).join('\n').slice(-2200)
    throw new Error(`${label}失败：${output || `退出码 ${result.code}`}`)
  }
  return result
}

async function isPythonCommandAvailable(command: PythonCommand): Promise<boolean> {
  try {
    const result = await runProcess(command.command, [...command.argsPrefix, '--version'], { timeoutMs: 10_000 })
    return result.code === 0
  } catch {
    return false
  }
}

async function resolvePythonCommand(preferManaged = true): Promise<PythonCommand | undefined> {
  const candidates: PythonCommand[] = []
  const managedPythonPath = getLocalPaddleOcrRuntimePythonPath()
  if (preferManaged && existsSync(managedPythonPath)) {
    candidates.push({
      command: managedPythonPath,
      argsPrefix: [],
      label: 'GujiSmart 本地 OCR 运行环境',
      source: 'managed',
    })
  }
  const envPython = String(process.env.GUJISMART_PYTHON || '').trim()
  if (envPython) {
    candidates.push({ command: envPython, argsPrefix: [], label: envPython, source: 'system' })
  }
  if (process.platform === 'win32') {
    candidates.push(
      { command: 'python', argsPrefix: [], label: 'python', source: 'system' },
      { command: 'py', argsPrefix: ['-3'], label: 'py -3', source: 'system' },
    )
  } else {
    candidates.push(
      { command: 'python3', argsPrefix: [], label: 'python3', source: 'system' },
      { command: 'python', argsPrefix: [], label: 'python', source: 'system' },
    )
  }
  for (const candidate of candidates) {
    if (await isPythonCommandAvailable(candidate)) return candidate
  }
  return undefined
}

async function queryPaddleRuntimeVersions(command: PythonCommand): Promise<Record<string, string | undefined>> {
  const script = `
import importlib.metadata as metadata
import json

def version(name):
    try:
        return metadata.version(name)
    except Exception:
        return None

print(json.dumps({
    "paddle": version("paddlepaddle"),
    "paddleocr": version("paddleocr"),
    "paddlex": version("paddlex"),
}, ensure_ascii=False))
`
  const result = await runRequiredProcess(
    command.command,
    [...command.argsPrefix, '-c', script],
    '检测本地 OCR 运行环境',
    { timeoutMs: 20_000 },
  )
  const parsed: unknown = JSON.parse(result.stdout.split(/\r?\n/).filter(Boolean).pop() || '{}')
  return isRecord(parsed)
    ? {
      paddle: typeof parsed.paddle === 'string' ? parsed.paddle : undefined,
      paddleocr: typeof parsed.paddleocr === 'string' ? parsed.paddleocr : undefined,
      paddlex: typeof parsed.paddlex === 'string' ? parsed.paddlex : undefined,
    }
    : {}
}

function createRuntimeStatus(
  state: LocalPaddleOcrRuntimeStatus['state'],
  message: string,
  options: Partial<LocalPaddleOcrRuntimeStatus> = {},
): LocalPaddleOcrRuntimeStatus {
  return {
    state,
    supported: state === 'ready',
    runtimePath: getLocalPaddleOcrRuntimePath(),
    requiredPaddleVersion: REQUIRED_PADDLE_VERSION,
    requiredPaddleOcrVersion: REQUIRED_PADDLE_OCR_VERSION,
    requiredPaddlexVersion: REQUIRED_PADDLEX_VERSION,
    message,
    ...options,
  }
}

export async function getLocalPaddleOcrRuntimeStatus(): Promise<LocalPaddleOcrRuntimeStatus> {
  const command = await resolvePythonCommand(true)
  if (!command) {
    return createRuntimeStatus(
      'missing_python',
      '未检测到可用 Python，无法安装或运行本地 PaddleOCR。请先安装 Python 3.10/3.11，或稍后使用云端 OCR / AI OCR。',
    )
  }
  try {
    const versions = await queryPaddleRuntimeVersions(command)
    const base = {
      source: command.source,
      pythonPath: command.command,
      paddleVersion: versions.paddle,
      paddleocrVersion: versions.paddleocr,
      paddlexVersion: versions.paddlex,
    }
    const missing = [
      versions.paddle ? null : 'paddlepaddle',
      versions.paddleocr ? null : 'paddleocr',
      versions.paddlex ? null : 'paddlex',
    ].filter(Boolean)
    if (missing.length > 0) {
      return createRuntimeStatus(
        'missing_packages',
        `本地 OCR 运行环境缺少 ${missing.join('、')}，请点击“安装/升级运行环境”。`,
        base,
      )
    }
    const outdated = [
      isVersionAtLeast(versions.paddle, REQUIRED_PADDLE_VERSION) ? null : `PaddlePaddle ${versions.paddle}`,
      isVersionAtLeast(versions.paddleocr, REQUIRED_PADDLE_OCR_VERSION) ? null : `PaddleOCR ${versions.paddleocr}`,
      isVersionAtLeast(versions.paddlex, REQUIRED_PADDLEX_VERSION) ? null : `PaddleX ${versions.paddlex}`,
    ].filter(Boolean)
    if (outdated.length > 0) {
      return createRuntimeStatus(
        'outdated',
        `当前运行库版本过旧（${outdated.join('、')}），请点击“安装/升级运行环境”以支持 PP-OCRv6。`,
        base,
      )
    }
    return createRuntimeStatus(
      'ready',
      `本地 OCR 运行环境已支持 PP-OCRv6：PaddleOCR ${versions.paddleocr}，PaddleX ${versions.paddlex}。`,
      base,
    )
  } catch (error) {
    return createRuntimeStatus(
      'error',
      getResponseErrorMessage(error, '本地 OCR 运行环境检测失败'),
      {
        source: command.source,
        pythonPath: command.command,
        error: getResponseErrorMessage(error, '本地 OCR 运行环境检测失败'),
      },
    )
  }
}

async function runRuntimeInstallStep(
  python: PythonCommand,
  args: string[],
  label: string,
  progress: number,
  report?: DownloadProgressReporter,
): Promise<void> {
  report?.({
    state: 'installing',
    progress,
    message: label,
  })
  await runRequiredProcess(
    python.command,
    [...python.argsPrefix, ...args],
    label,
    {
      timeoutMs: 30 * 60_000,
      onOutput: (text) => {
        const compact = text.replace(/\s+/g, ' ').trim()
        if (!compact) return
        report?.({
          state: 'installing',
          progress,
          message: `${label}：${compact.slice(0, 120)}`,
        })
      },
    },
  )
}

export async function installLocalPaddleOcrRuntime(report?: DownloadProgressReporter): Promise<LocalPaddleOcrStatus> {
  const basePython = await resolvePythonCommand(false)
  if (!basePython) {
    throw new Error('未检测到可用 Python，无法安装本地 OCR 运行环境。请先安装 Python 3.10/3.11。')
  }
  const runtimePath = getLocalPaddleOcrRuntimePath()
  const runtimePythonPath = getLocalPaddleOcrRuntimePythonPath()
  await mkdir(dirname(runtimePath), { recursive: true })
  if (!existsSync(runtimePythonPath)) {
    report?.({
      state: 'installing',
      progress: 0.05,
      message: '正在创建本地 OCR 独立 Python 运行环境',
    })
    await runRequiredProcess(
      basePython.command,
      [...basePython.argsPrefix, '-m', 'venv', runtimePath],
      '创建本地 OCR Python 运行环境',
      { timeoutMs: 5 * 60_000 },
    )
  }

  const runtimePython: PythonCommand = {
    command: runtimePythonPath,
    argsPrefix: [],
    label: 'GujiSmart 本地 OCR 运行环境',
    source: 'managed',
  }
  await runRuntimeInstallStep(
    runtimePython,
    ['-m', 'pip', 'install', '-U', 'pip', 'setuptools', 'wheel'],
    '正在更新 pip 基础组件',
    0.15,
    report,
  )
  await runRuntimeInstallStep(
    runtimePython,
    [
      '-m',
      'pip',
      'install',
      '-U',
      `paddlepaddle>=${REQUIRED_PADDLE_VERSION}`,
      '--index-url',
      PADDLE_CPU_INDEX_URL,
      '--extra-index-url',
      'https://pypi.org/simple',
    ],
    '正在安装 PaddlePaddle 官方 CPU 推理引擎',
    0.38,
    report,
  )
  await runRuntimeInstallStep(
    runtimePython,
    [
      '-m',
      'pip',
      'install',
      '-U',
      `paddleocr>=${REQUIRED_PADDLE_OCR_VERSION}`,
      `paddlex>=${REQUIRED_PADDLEX_VERSION}`,
    ],
    '正在安装支持 PP-OCRv6 的 PaddleOCR / PaddleX',
    0.72,
    report,
  )

  const runtime = await getLocalPaddleOcrRuntimeStatus()
  if (!runtime.supported) {
    throw new Error(runtime.message || '本地 OCR 运行环境安装完成，但尚未支持 PP-OCRv6')
  }
  report?.({
    state: 'completed',
    progress: 1,
    message: '本地 OCR 运行环境已支持 PP-OCRv6',
  })
  return getLocalPaddleOcrStatus()
}

function resolveLocalPaddleOcrPaths(size = getLocalPaddleOcrSizePreference()) {
  const profile = getLocalPaddleOcrModelProfile(size)
  const installPath = getLocalPaddleOcrInstallPath(size)
  const detStem = profile.detName.replace(/\.tar$/i, '')
  const recStem = profile.recName.replace(/\.tar$/i, '')
  const runnerPath = firstExistingPath([
    join(installPath, 'runner', 'gujismart-paddleocr-runner.exe'),
    join(installPath, 'gujismart-paddleocr-runner.exe'),
    join(installPath, 'runner', 'run_paddleocr.py'),
    join(installPath, 'run_paddleocr.py'),
  ])
  const pythonPath = firstExistingPath([
    getLocalPaddleOcrRuntimePythonPath(),
    join(installPath, 'python', 'python.exe'),
    join(installPath, 'runtime', 'python.exe'),
  ])
  const modelPath = firstExistingPath([
    join(installPath, 'models'),
    join(installPath, 'model'),
  ]) || join(installPath, 'models')
  const detModelPath = firstExistingPath([
    join(modelPath, detStem),
    join(modelPath, 'det', detStem),
  ])
  const recModelPath = firstExistingPath([
    join(modelPath, recStem),
    join(modelPath, 'rec', recStem),
  ])
  const detTarPath = firstExistingPath([
    join(modelPath, profile.detName),
    join(modelPath, 'det', profile.detName),
  ])
  const recTarPath = firstExistingPath([
    join(modelPath, profile.recName),
    join(modelPath, 'rec', profile.recName),
  ])
  return {
    installPath,
    runnerPath: runnerPath ? getPathIfReadable(runnerPath) : undefined,
    pythonPath: pythonPath ? getPathIfReadable(pythonPath) : undefined,
    modelPath,
    detModelPath: detModelPath ? getDirectoryIfReadable(detModelPath) : undefined,
    recModelPath: recModelPath ? getDirectoryIfReadable(recModelPath) : undefined,
    detTarPath: detTarPath ? getPathIfReadable(detTarPath) : undefined,
    recTarPath: recTarPath ? getPathIfReadable(recTarPath) : undefined,
  }
}

async function readManifestUpdatedAt(size = getLocalPaddleOcrSizePreference()): Promise<string | undefined> {
  try {
    const raw = await readFile(getManifestPath(size), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed) && typeof parsed.updatedAt === 'string' ? parsed.updatedAt : undefined
  } catch {
    return undefined
  }
}

export function listLocalPaddleOcrSources(): LocalPaddleOcrSource[] {
  return createLocalPaddleOcrSources().map((source) => ({ ...source }))
}

export async function getLocalPaddleOcrStatus(): Promise<LocalPaddleOcrStatus> {
  const size = getLocalPaddleOcrSizePreference()
  const profile = getLocalPaddleOcrModelProfile(size)
  const paths = resolveLocalPaddleOcrPaths(size)
  const runtime = await getLocalPaddleOcrRuntimeStatus()
  const hasRunner = !!paths.runnerPath
  const hasModels = !!paths.detModelPath && !!paths.recModelPath
  const hasAnyInstallAsset = hasRunner || !!paths.detModelPath || !!paths.recModelPath || !!paths.detTarPath || !!paths.recTarPath || existsSync(getManifestPath(size))
  const modelInstalled = hasRunner && hasModels
  const installed = modelInstalled && runtime.supported
  return {
    installed,
    modelInstalled,
    state: installed ? 'installed' : hasAnyInstallAsset ? 'partial' : 'not_installed',
    bundleVersion: profile.bundleVersion,
    installPath: paths.installPath,
    runnerPath: paths.runnerPath,
    pythonPath: paths.pythonPath,
    modelPath: paths.modelPath,
    detModelPath: paths.detModelPath,
    recModelPath: paths.recModelPath,
    runtime,
    message: installed
      ? `本地 PaddleOCR ${profile.label} 已就绪`
      : modelInstalled
      ? `${profile.label} 模型已安装，${runtime.message}`
      : hasAnyInstallAsset
      ? `已检测到部分 ${profile.label} 本地 OCR 文件，还缺少运行脚本或完整模型，请重新下载`
      : `本地 PaddleOCR ${profile.label} 尚未安装`,
    sources: listLocalPaddleOcrSources(),
    updatedAt: await readManifestUpdatedAt(size),
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

function getArtifactsForSource(source: LocalPaddleOcrDownloadSourceId, size = getLocalPaddleOcrSizePreference()): DownloadArtifact[] {
  const profile = getLocalPaddleOcrModelProfile(size)
  if (source === 'paddle_bos') {
    return [
      {
        sourceId: 'paddle_bos',
        url: `${OFFICIAL_MODEL_BASE_URL}/${profile.detName}`,
        fileName: profile.detName,
        expectedBytes: profile.detBytes,
      },
      {
        sourceId: 'paddle_bos',
        url: `${OFFICIAL_MODEL_BASE_URL}/${profile.recName}`,
        fileName: profile.recName,
        expectedBytes: profile.recBytes,
      },
    ]
  }
  throw new Error('该源是模型目录页，请使用自动下载，或打开 PaddleOCR 官方页面查看 PP-OCRv6 模型说明')
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
    throw new DownloadHttpError(response.status, artifact.url, artifact.fileName)
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
    throw new Error(`OCR 压缩包包含非法路径：${relativePath}`)
  }
  return targetPath
}

function parseTarString(buffer: Buffer, start: number, length: number): string {
  let end = start
  const max = start + length
  while (end < max && buffer[end] !== 0) end += 1
  return buffer.subarray(start, end).toString('utf8').trim()
}

function parseTarOctal(buffer: Buffer, start: number, length: number): number {
  const raw = parseTarString(buffer, start, length).replace(/\0/g, '').trim()
  return raw ? parseInt(raw, 8) || 0 : 0
}

function normalizeTarEntryName(name: string): string {
  return name.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '')
}

function getOfficialPaddleModelName(fileName: string): string {
  return basename(fileName).replace(/_infer\.tar$/i, '')
}

async function extractTarFile(
  tarPath: string,
  targetRoot: string,
  report?: DownloadProgressReporter,
  sourceId: Exclude<LocalPaddleOcrDownloadSourceId, 'auto' | 'manual'> = 'paddle_bos',
): Promise<void> {
  const buffer = await readFile(tarPath)
  let offset = 0
  let extracted = 0
  let longName: string | null = null
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const nameRaw = parseTarString(header, 0, 100)
    const prefixRaw = parseTarString(header, 345, 155)
    const size = parseTarOctal(header, 124, 12)
    const typeFlag = header[156] || 0
    const dataStart = offset + 512
    const dataEnd = dataStart + size
    offset = dataStart + Math.ceil(size / 512) * 512
    if (dataEnd > buffer.length) throw new Error(`${basename(tarPath)} 解包失败：tar 文件不完整`)

    if (typeFlag === 76) {
      longName = normalizeTarEntryName(buffer.subarray(dataStart, dataEnd).toString('utf8').replace(/\0.*$/s, '').trim())
      continue
    }
    if (typeFlag === 120 || typeFlag === 103) continue

    const entryName = normalizeTarEntryName(longName || [prefixRaw, nameRaw].filter(Boolean).join('/'))
    longName = null
    if (!entryName) continue

    const targetPath = await ensureZipSafePath(targetRoot, entryName)
    if (typeFlag === 53 || entryName.endsWith('/')) {
      await mkdir(targetPath, { recursive: true })
      continue
    }
    if (typeFlag !== 0 && typeFlag !== 48) continue

    await mkdir(dirname(targetPath), { recursive: true })
    await writeFile(targetPath, buffer.subarray(dataStart, dataEnd))
    extracted += 1
    report?.({
      state: 'installing',
      sourceId,
      fileName: basename(tarPath),
      message: `正在解包官方模型：${basename(tarPath)}`,
      progress: 0.9,
    })
  }
  if (extracted === 0) throw new Error(`${basename(tarPath)} 解包失败：没有找到模型文件`)
}

const LOCAL_PADDLE_RUNNER_SCRIPT = String.raw`#!/usr/bin/env python
import argparse
import json
import os
import sys


try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass


def fail(message, code=2):
    sys.stderr.write(str(message) + "\n")
    sys.exit(code)


try:
    from paddleocr import PaddleOCR
except Exception as exc:
    fail(
        "Cannot import the official PaddleOCR Python package. "
        "Install the official runtime first: python -m pip install paddlepaddle paddleocr. "
        + str(exc),
        3,
    )


def to_plain(value):
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(key): to_plain(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [to_plain(item) for item in value]
    for attr_name in ("json", "to_dict", "dict"):
        if not hasattr(value, attr_name):
            continue
        attr = getattr(value, attr_name)
        try:
            return to_plain(attr() if callable(attr) else attr)
        except Exception:
            pass
    if hasattr(value, "__dict__"):
        return to_plain(vars(value))
    return str(value)


def as_list(value):
    return value if isinstance(value, list) else []


def first_list(record, names):
    if not isinstance(record, dict):
        return []
    for name in names:
        value = record.get(name)
        if isinstance(value, list):
            return value
    return []


def location_from_poly(poly):
    points = as_list(poly)
    if not points:
        return None
    xs = []
    ys = []
    for point in points:
        if isinstance(point, (list, tuple)) and len(point) >= 2:
            try:
                xs.append(float(point[0]))
                ys.append(float(point[1]))
            except Exception:
                pass
    if not xs or not ys:
        return None
    left = min(xs)
    top = min(ys)
    return {
        "left": left,
        "top": top,
        "width": max(xs) - left,
        "height": max(ys) - top,
        "poly": points,
    }


def append_text_item(words_result, layout_result, text, score=None, poly=None):
    text = str(text or "").strip()
    if not text:
        return
    location = location_from_poly(poly)
    item = {"words": text}
    if score is not None:
        item["probability"] = score
    if location:
        item["location"] = location
    words_result.append(item)
    block = {"type": "text", "label": "text", "words": text, "text": text}
    if location:
        block["location"] = location
    layout_result.append(block)


def collect_from_record(record, words_result, layout_result):
    if isinstance(record, dict) and isinstance(record.get("res"), dict):
        record = record["res"]
    if not isinstance(record, dict):
        return
    texts = first_list(record, ("rec_texts", "texts", "text_recognition_texts"))
    scores = first_list(record, ("rec_scores", "scores", "text_recognition_scores"))
    polys = first_list(record, ("rec_polys", "rec_boxes", "dt_polys", "text_det_polys"))
    for index, text in enumerate(texts):
        score = scores[index] if index < len(scores) else None
        poly = polys[index] if index < len(polys) else None
        append_text_item(words_result, layout_result, text, score, poly)


def collect_legacy_output(output, words_result, layout_result):
    if not isinstance(output, list):
        return
    for page in output:
        lines = page if isinstance(page, list) else []
        for line in lines:
            if not isinstance(line, (list, tuple)) or len(line) < 2:
                continue
            poly = line[0]
            payload = line[1]
            if isinstance(payload, (list, tuple)):
                text = payload[0] if payload else ""
                score = payload[1] if len(payload) > 1 else None
            else:
                text = payload
                score = None
            append_text_item(words_result, layout_result, text, score, poly)


def create_ocr(args):
    primary_kwargs = {
        "ocr_version": "PP-OCRv6",
        "use_doc_orientation_classify": False,
        "use_doc_unwarping": False,
        "use_textline_orientation": False,
        "text_detection_model_dir": args.det_model_dir,
        "text_recognition_model_dir": args.rec_model_dir,
    }
    if args.det_model_name:
        primary_kwargs["text_detection_model_name"] = args.det_model_name
    if args.rec_model_name:
        primary_kwargs["text_recognition_model_name"] = args.rec_model_name
    if args.device:
        primary_kwargs["device"] = args.device
    try:
        return PaddleOCR(**primary_kwargs)
    except Exception as primary_error:
        primary_message = str(primary_error)
        if (
            "Invalid OCR version" in primary_message
            or "UnknownModelError" in primary_message
            or "Model name mismatch" in primary_message
            or "PP-OCRv6" in primary_message
        ):
            fail(
                "当前 Python 环境中的官方 PaddleOCR/PaddleX 运行库不支持 PP-OCRv6。"
                "请升级官方运行库后重试：python -m pip install -U paddleocr paddlex paddlepaddle",
                5,
            )
        fallback_kwargs = {
            "det_model_dir": args.det_model_dir,
            "rec_model_dir": args.rec_model_dir,
            "use_angle_cls": False,
        }
        try:
            return PaddleOCR(**fallback_kwargs)
        except Exception as fallback_error:
            fallback_message = str(fallback_error)
            if "PP-OCRv6" in fallback_message or "Model name mismatch" in fallback_message:
                fail(
                    "当前 Python 环境中的官方 PaddleOCR/PaddleX 运行库不支持 PP-OCRv6。"
                    "请升级官方运行库后重试：python -m pip install -U paddleocr paddlex paddlepaddle",
                    5,
                )
            raise primary_error


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--model-dir", default=os.environ.get("GUJISMART_OCR_MODEL_DIR", ""))
    parser.add_argument("--det-model-dir", default=os.environ.get("GUJISMART_OCR_DET_MODEL", ""))
    parser.add_argument("--rec-model-dir", default=os.environ.get("GUJISMART_OCR_REC_MODEL", ""))
    parser.add_argument("--det-model-name", default=os.environ.get("GUJISMART_OCR_DET_MODEL_NAME", ""))
    parser.add_argument("--rec-model-name", default=os.environ.get("GUJISMART_OCR_REC_MODEL_NAME", ""))
    parser.add_argument("--device", default=os.environ.get("PADDLEOCR_DEVICE", "cpu"))
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    if not args.det_model_dir or not args.rec_model_dir:
        fail("Missing PP-OCRv6 detection or recognition model directory.", 4)
    ocr = create_ocr(args)
    if hasattr(ocr, "predict"):
        raw_output = ocr.predict(args.image)
    else:
        raw_output = ocr.ocr(args.image, cls=False)
    words_result = []
    layout_result = []
    collect_legacy_output(raw_output, words_result, layout_result)
    for item in as_list(raw_output):
        collect_from_record(to_plain(item), words_result, layout_result)
    text = "\n".join(item.get("words", "") for item in words_result if item.get("words"))
    print(json.dumps({
        "source_type": "local_paddle_ocr",
        "ocr_text": text,
        "text": text,
        "words_result": words_result,
        "layout_result": layout_result,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
`

async function writeOfficialPaddleRunner(size = getLocalPaddleOcrSizePreference()): Promise<void> {
  const runnerDir = join(getLocalPaddleOcrInstallPath(size), 'runner')
  await mkdir(runnerDir, { recursive: true })
  await writeFile(join(runnerDir, 'run_paddleocr.py'), LOCAL_PADDLE_RUNNER_SCRIPT, 'utf8')
}

async function extractAddonZip(zipPath: string, report?: DownloadProgressReporter, size = getLocalPaddleOcrSizePreference()): Promise<void> {
  const installPath = getLocalPaddleOcrInstallPath(size)
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
      sourceId: 'manual',
      fileName: basename(zipPath),
      progress: entries.length > 0 ? Math.min(1, extracted / entries.length) : undefined,
      message: `正在安装本地 OCR 兼容包：${extracted}/${entries.length}`,
    })
  }
}

async function installOfficialModelArtifacts(
  downloads: Array<{ filePath: string; bytes: number; sha256: string }>,
  size = getLocalPaddleOcrSizePreference(),
  report?: DownloadProgressReporter,
): Promise<void> {
  const modelDir = join(getLocalPaddleOcrInstallPath(size), 'models')
  await mkdir(modelDir, { recursive: true })
  for (const item of downloads) {
    await extractTarFile(item.filePath, modelDir, report)
  }
  await writeOfficialPaddleRunner(size)
}

async function writeInstallManifest(sourceId: LocalPaddleOcrDownloadSourceId, downloads: Array<{ filePath: string; bytes: number; sha256: string }>, size = getLocalPaddleOcrSizePreference()): Promise<void> {
  const profile = getLocalPaddleOcrModelProfile(size)
  const manifest = {
    bundleVersion: profile.bundleVersion,
    modelSize: size,
    modelName: profile.label,
    sourceId,
    updatedAt: new Date().toISOString(),
    downloads: downloads.map((item) => ({
      fileName: basename(item.filePath),
      bytes: item.bytes,
      sha256: item.sha256,
    })),
  }
  await mkdir(getLocalPaddleOcrInstallPath(size), { recursive: true })
  await writeFile(getManifestPath(size), JSON.stringify(manifest, null, 2), 'utf8')
}

export async function importLocalPaddleOcrAddon(filePath: string, report?: DownloadProgressReporter): Promise<LocalPaddleOcrStatus> {
  const normalizedPath = String(filePath || '').trim()
  const size = getLocalPaddleOcrSizePreference()
  if (!normalizedPath || !existsSync(normalizedPath)) throw new Error('请选择可访问的本地 OCR 兼容包文件')
  if (extname(normalizedPath).toLowerCase() !== '.zip') throw new Error('目前仅支持导入 .zip 格式的本地 OCR 兼容包')
  await mkdir(getLocalPaddleOcrInstallPath(size), { recursive: true })
  await extractAddonZip(normalizedPath, (progress) => report?.({ ...progress, sourceId: 'manual' }), size)
  await writeInstallManifest('manual', [{
    filePath: normalizedPath,
    bytes: statSync(normalizedPath).size,
    sha256: await sha256File(normalizedPath),
  }], size)
  report?.({ state: 'completed', sourceId: 'manual', progress: 1, message: '本地 OCR 兼容包已导入' })
  return getLocalPaddleOcrStatus()
}

export async function downloadLocalPaddleOcrAddon(options: LocalPaddleOcrDownloadOptions = {}, report?: DownloadProgressReporter): Promise<LocalPaddleOcrStatus> {
  const source = options.source || 'auto'
  const size = getLocalPaddleOcrSizePreference()
  if (source === 'manual') {
    if (!options.manualPath) throw new Error('手动导入需要提供本地 OCR 兼容包路径')
    return importLocalPaddleOcrAddon(options.manualPath, report)
  }

  const sourcePlan: Array<'paddle_bos'> = source === 'auto' || source === 'paddle_bos'
    ? ['paddle_bos']
    : []
  if (sourcePlan.length === 0) {
    throw new Error('该源不是可直接下载的文件，请使用自动下载，或打开官方页面查看 PP-OCRv6 模型说明')
  }

  let lastError: unknown = null
  await mkdir(getLocalPaddleOcrDownloadPath(), { recursive: true })
  await mkdir(getLocalPaddleOcrInstallPath(size), { recursive: true })
  for (let sourceIndex = 0; sourceIndex < sourcePlan.length; sourceIndex += 1) {
    const sourceId = sourcePlan[sourceIndex]
    const hasNextSource = sourceIndex < sourcePlan.length - 1
    const artifacts = getArtifactsForSource(sourceId, size)
    const expectedTotalBytes = artifacts.reduce((sum, artifact) => sum + (artifact.expectedBytes || 0), 0)
    const downloads: Array<{ filePath: string; bytes: number; sha256: string }> = []
    let cumulativeBytes = 0
    try {
      report?.({ state: 'checking', sourceId, progress: 0, message: '正在检查 Paddle 官方模型源' })
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
            if (isNonRetryableDownloadError(error)) break
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
      report?.({ state: 'installing', sourceId, progress: 0.9, message: '正在安装官方 PP-OCRv6 模型' })
      await installOfficialModelArtifacts(downloads, size, report)
      await writeInstallManifest(sourceId, downloads, size)
      const status = await getLocalPaddleOcrStatus()
      if (!status.modelInstalled && hasNextSource) {
        report?.({
          state: 'installing',
          sourceId,
          progress: 0.95,
          message: `${status.message || '本地 OCR 运行时已准备'}，继续下载官方 PP-OCRv6 模型`,
        })
        continue
      }
      if (!status.modelInstalled) {
        throw new Error(status.message || '本地 OCR 文件尚未完整安装')
      }
      report?.({
        state: 'completed',
        sourceId,
        progress: 1,
        message: status.installed
          ? `本地 OCR ${getLocalPaddleOcrModelProfile(size).label} 已安装`
          : `本地 OCR 模型已安装，运行环境还需安装/升级`,
      })
      return status
    } catch (error) {
      lastError = error
      await rm(getLocalPaddleOcrDownloadPath(), { recursive: true, force: true }).catch(() => undefined)
      const message = hasNextSource
        ? '当前源下载失败，准备尝试备用源'
        : '本地 OCR 下载失败'
      report?.({
        state: 'error',
        sourceId,
        message,
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
      rejectRun(new Error('本地 PaddleOCR 运行组件缺失，请在设置页重新点击下载/修复本地 OCR'))
      return
    }
    if (!page.image_path) {
      rejectRun(new Error(`第 ${page.page_num || ''} 页缺少可识别图片`))
      return
    }
    const isPythonScript = extname(status.runnerPath).toLowerCase() === '.py'
    const command = isPythonScript ? status.pythonPath || 'python' : status.runnerPath
    const modelSize = getLocalPaddleOcrSizePreference()
    const modelProfile = getLocalPaddleOcrModelProfile(modelSize)
    const detModelName = getOfficialPaddleModelName(modelProfile.detName)
    const recModelName = getOfficialPaddleModelName(modelProfile.recName)
    const args = isPythonScript
      ? [
        status.runnerPath,
        '--image',
        page.image_path,
        '--model-dir',
        status.modelPath || '',
        '--det-model-dir',
        status.detModelPath || '',
        '--rec-model-dir',
        status.recModelPath || '',
        '--det-model-name',
        detModelName,
        '--rec-model-name',
        recModelName,
        '--json',
      ]
      : [
        '--image',
        page.image_path,
        '--model-dir',
        status.modelPath || '',
        '--det-model-dir',
        status.detModelPath || '',
        '--rec-model-dir',
        status.recModelPath || '',
        '--det-model-name',
        detModelName,
        '--rec-model-name',
        recModelName,
        '--json',
      ]
    const child = spawn(command, args.filter((item) => item.length > 0), {
      windowsHide: true,
      cwd: status.installPath,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        GUJISMART_OCR_MODEL_DIR: status.modelPath || '',
        GUJISMART_OCR_DET_MODEL: status.detModelPath || '',
        GUJISMART_OCR_REC_MODEL: status.recModelPath || '',
        GUJISMART_OCR_DET_MODEL_NAME: detModelName,
        GUJISMART_OCR_REC_MODEL_NAME: recModelName,
        GUJISMART_OCR_MODEL_SIZE: modelSize,
        GUJISMART_OCR_MODEL_PROFILE: modelProfile.label,
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
    throw new Error(status.message || '本地 PaddleOCR 尚未安装，请先在设置页下载/修复本地 OCR')
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
