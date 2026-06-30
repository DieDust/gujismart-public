const path = require('path')
const os = require('os')
const fs = require('fs')
const { spawnSync } = require('child_process')

const baseDir = path.join(os.tmpdir(), 'gujismart-electron-stub')

exports.app = {
  getName: () => 'gujismart-test',
  getPath: (name) => {
    if (name === 'exe') return path.join(baseDir, 'gujismart-test.exe')
    if (name === 'appData') return path.join(baseDir, 'appData')
    if (name === 'userData') return path.join(baseDir, 'userData')
    if (name === 'documents') return path.join(baseDir, 'documents')
    return baseDir
  },
}

exports.nativeImage = {
  createFromPath: (filePath) => {
    return createNativeImageWrapper(() => ImageLoader.fromPath(filePath))
  },
  createFromBuffer: (buffer) => {
    return createNativeImageWrapper(() => ImageLoader.fromBuffer(buffer))
  },
}

class ImageLoader {
  constructor(width, height, rgba) {
    this.width = width
    this.height = height
    this.rgba = rgba
    this.canvas = null
  }

  static fromPath(filePath) {
    return ImageLoader.fromDecoded(decodeImageWithPillow({ filePath }))
  }

  static fromBuffer(buffer) {
    return ImageLoader.fromDecoded(decodeImageWithPillow({ buffer }))
  }

  static fromDecoded(decoded) {
    if (!decoded || decoded.width <= 0 || decoded.height <= 0 || !decoded.rgba?.length) {
      throw new Error('Invalid image')
    }
    return new ImageLoader(decoded.width, decoded.height, decoded.rgba)
  }

  toBitmap() {
    return rgbaToBgra(this.rgba)
  }

  toCanvas() {
    if (this.canvas) return this.canvas
    const { createCanvas, ImageData } = require('@napi-rs/canvas')
    const canvas = createCanvas(this.width, this.height)
    const imageData = new ImageData(new Uint8ClampedArray(this.rgba), this.width, this.height)
    canvas.getContext('2d').putImageData(imageData, 0, 0)
    this.canvas = canvas
    return canvas
  }

  toJPEG(quality) {
    return this.toCanvas().toBuffer('image/jpeg', Math.max(0, Math.min(100, Number(quality || 80))) / 100)
  }

  resize(options) {
    const width = Math.max(1, Math.round(Number(options.width || this.width)))
    const height = Math.max(1, Math.round(Number(options.height || this.height)))
    const { createCanvas } = require('@napi-rs/canvas')
    const resized = createCanvas(width, height)
    const context = resized.getContext('2d')
    context.drawImage(this.toCanvas(), 0, 0, width, height)
    const rgba = Buffer.from(context.getImageData(0, 0, width, height).data)
    return createNativeImageWrapper(() => new ImageLoader(width, height, rgba))
  }

  crop(rect) {
    const left = Math.max(0, Math.min(this.width - 1, Math.round(Number(rect?.x || 0))))
    const top = Math.max(0, Math.min(this.height - 1, Math.round(Number(rect?.y || 0))))
    const width = Math.max(1, Math.min(this.width - left, Math.round(Number(rect?.width || this.width))))
    const height = Math.max(1, Math.min(this.height - top, Math.round(Number(rect?.height || this.height))))
    const rgba = Buffer.alloc(width * height * 4)
    for (let row = 0; row < height; row += 1) {
      const sourceStart = ((top + row) * this.width + left) * 4
      const targetStart = row * width * 4
      this.rgba.copy(rgba, targetStart, sourceStart, sourceStart + width * 4)
    }
    return createNativeImageWrapper(() => new ImageLoader(width, height, rgba))
  }
}

function decodeImageWithPillow({ filePath, buffer }) {
  const python = String.raw`
import io
import pathlib
import sys
from PIL import Image

if len(sys.argv) > 1:
    image = Image.open(pathlib.Path(sys.argv[1]))
else:
    image = Image.open(io.BytesIO(sys.stdin.buffer.read()))
image = image.convert('RGBA')
width, height = image.size
sys.stdout.buffer.write(f"{width} {height}\n".encode('ascii'))
sys.stdout.buffer.write(image.tobytes())
`
  const args = filePath ? ['-c', python, filePath] : ['-c', python]
  const result = spawnSync('python', args, {
    input: buffer,
    maxBuffer: 256 * 1024 * 1024,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(result.stderr?.toString('utf8') || `Pillow image decode failed with ${result.status}`)
  }
  const separator = result.stdout.indexOf(10)
  if (separator <= 0) throw new Error('Pillow image decode returned no header')
  const [widthText, heightText] = result.stdout.slice(0, separator).toString('ascii').trim().split(/\s+/)
  const width = Number(widthText)
  const height = Number(heightText)
  const rgba = result.stdout.slice(separator + 1)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('Pillow image decode returned invalid dimensions')
  }
  if (rgba.length !== width * height * 4) {
    throw new Error('Pillow image decode returned invalid pixel data')
  }
  return { width, height, rgba }
}

function rgbaToBgra(source) {
  const target = Buffer.alloc(source.length)
  for (let index = 0; index < source.length; index += 4) {
    target[index] = source[index + 2]
    target[index + 1] = source[index + 1]
    target[index + 2] = source[index]
    target[index + 3] = source[index + 3]
  }
  return target
}

function bgraToRgba(source) {
  const target = Buffer.alloc(source.length)
  for (let index = 0; index < source.length; index += 4) {
    target[index] = source[index + 2]
    target[index + 1] = source[index + 1]
    target[index + 2] = source[index]
    target[index + 3] = source[index + 3]
  }
  return target
}

function createImageFromBgra(width, height, bgra) {
  return new ImageLoader(width, height, bgraToRgba(bgra))
}

function createImageFromCanvas(canvas, width, height) {
  const rgba = Buffer.from(canvas.getContext('2d').getImageData(0, 0, width, height).data)
  return new ImageLoader(width, height, rgba)
}

function createCanvasBackedImage(width, height, draw) {
  const { createCanvas } = require('@napi-rs/canvas')
  const canvas = createCanvas(width, height)
  draw(canvas)
  return createImageFromCanvas(canvas, width, height)
}

function createNativeImageFromBitmap(width, height, bitmap) {
  return createNativeImageWrapper(() => createImageFromBgra(width, height, bitmap))
}

function createNativeImageFromCanvas(width, height, draw) {
  return createNativeImageWrapper(() => createCanvasBackedImage(width, height, draw))
}

function createNativeImageWrapper(loader) {
  let cached = null
  const load = () => {
    if (cached) return cached
    try {
      cached = loader()
      return cached
    } catch {
      cached = null
      return null
    }
  }
  return {
    isEmpty: () => !load(),
    getSize: () => {
      const image = load()
      return image ? { width: image.width, height: image.height } : { width: 0, height: 0 }
    },
    toBitmap: () => {
      const image = load()
      return image ? image.toBitmap() : Buffer.alloc(0)
    },
    toJPEG: (quality = 80) => {
      const image = load()
      return image ? image.toJPEG(quality) : Buffer.alloc(0)
    },
    resize: (options = {}) => {
      const image = load()
      return image ? image.resize(options) : createNativeImageWrapper(() => null)
    },
    crop: (rect = {}) => {
      const image = load()
      return image ? image.crop(rect) : createNativeImageWrapper(() => null)
    },
  }
}
