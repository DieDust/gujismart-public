// 图像处理工具

export interface QualityReport {
  width: number
  height: number
  resolution: number // 百万像素
  isBlurry: boolean
  blurScore: number
}

/**
 * 计算图像的拉普拉斯方差 (Laplacian Variance)，用于检测模糊程度
 * 方差越小，图像越模糊
 */
export async function checkImageQuality(base64Image: string): Promise<QualityReport> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'Anonymous'
    img.onload = () => {
      const width = img.width
      const height = img.height
      const resolution = (width * height) / 1000000

      // 使用 Canvas 获取灰度数据
      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        return reject(new Error('无法创建 Canvas Context'))
      }
      
      // 为了性能，可以将图像缩放到合适大小进行计算
      const processWidth = 500
      const processHeight = (height / width) * processWidth
      canvas.width = processWidth
      canvas.height = processHeight
      
      ctx.drawImage(img, 0, 0, processWidth, processHeight)
      
      const imageData = ctx.getImageData(0, 0, processWidth, processHeight)
      const data = imageData.data
      
      // 转换为灰度图
      const grayScale = new Float32Array(processWidth * processHeight)
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i]
        const g = data[i + 1]
        const b = data[i + 2]
        // 简单灰度计算
        grayScale[i / 4] = r * 0.299 + g * 0.587 + b * 0.114
      }

      // 拉普拉斯算子
      // [0,  1, 0]
      // [1, -4, 1]
      // [0,  1, 0]
      let sumLaplacian = 0
      let sumLaplacianSq = 0
      let count = 0

      for (let y = 1; y < processHeight - 1; y++) {
        for (let x = 1; x < processWidth - 1; x++) {
          const i = y * processWidth + x
          const laplacian = 
            grayScale[i - processWidth] + // top
            grayScale[i + processWidth] + // bottom
            grayScale[i - 1] +            // left
            grayScale[i + 1] -            // right
            4 * grayScale[i]              // center

          sumLaplacian += laplacian
          sumLaplacianSq += laplacian * laplacian
          count++
        }
      }

      const mean = sumLaplacian / count
      const variance = (sumLaplacianSq / count) - (mean * mean)

      // 阈值，可根据实际测试调整
      const threshold = 100 

      resolve({
        width,
        height,
        resolution,
        isBlurry: variance < threshold,
        blurScore: variance
      })
    }
    img.onerror = () => reject(new Error('加载图片失败'))
    img.src = base64Image
  })
}
