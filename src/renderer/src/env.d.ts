// 全局类型声明
// 声明 window.api 的类型，使渲染进程能获得完整的类型提示

import type { ApiType } from '../../preload/index'
import type { OpenDocumentTarget } from '@shared/types'

declare global {
  interface Window {
    api: ApiType
    __smokeOpenDocument?: (target: OpenDocumentTarget | string) => void
  }
}

export {}
