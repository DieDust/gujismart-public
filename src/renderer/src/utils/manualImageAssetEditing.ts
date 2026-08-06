import type {
  ManualPageImageAsset,
  ManualPageImageCrop,
} from '@shared/types'

export type ManualImageAssetMetadata = Record<string, unknown> & {
  image_asset_path?: string
  asset_path?: string
  image_path?: string
  image_asset_width?: number
  image_asset_height?: number
  image_crop?: unknown
}

export interface ManualImageCoordinateSize {
  width?: number | null
  height?: number | null
}

function positiveDimension(value: unknown): number {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0
}

export function scaleManualImageCropToNaturalPixels(
  crop: ManualPageImageCrop,
  coordinateSize: ManualImageCoordinateSize | null | undefined,
  naturalSize: ManualImageCoordinateSize | null | undefined,
): ManualPageImageCrop {
  const coordinateWidth = positiveDimension(coordinateSize?.width)
  const coordinateHeight = positiveDimension(coordinateSize?.height)
  const naturalWidth = positiveDimension(naturalSize?.width)
  const naturalHeight = positiveDimension(naturalSize?.height)
  if (!coordinateWidth || !coordinateHeight || !naturalWidth || !naturalHeight) {
    throw new Error('底图尺寸尚未就绪，请稍后重试。')
  }
  const values = [crop.left, crop.top, crop.width, crop.height].map(Number)
  if (!values.every(Number.isFinite) || crop.left < 0 || crop.top < 0 || crop.width <= 0 || crop.height <= 0) {
    throw new Error('当前图片区块没有有效坐标，请先在底图上调整选区。')
  }
  const epsilon = 0.001
  if (crop.left + crop.width > coordinateWidth + epsilon
    || crop.top + crop.height > coordinateHeight + epsilon) {
    throw new Error('当前图片区块超出底图坐标范围，请先调整选区。')
  }
  const scaleX = naturalWidth / coordinateWidth
  const scaleY = naturalHeight / coordinateHeight
  return {
    left: crop.left * scaleX,
    top: crop.top * scaleY,
    width: crop.width * scaleX,
    height: crop.height * scaleY,
  }
}

export type ManualImageAssetUpdateInput =
  | { status: 'cancelled' | 'failed'; previous: ManualImageAssetMetadata }
  | {
      status: 'success'
      previous: ManualImageAssetMetadata
      pageId: string
      blockId: string
      asset: ManualPageImageAsset
      crop?: ManualPageImageCrop
    }

export function createManualImageAssetUpdate(
  input: ManualImageAssetUpdateInput,
): Record<string, unknown> | null {
  if (input.status !== 'success') return null
  return {
    manual_block_id: input.blockId,
    segmentation_source: 'manual',
    image_asset_path: input.asset.assetPath,
    asset_path: input.asset.assetPath,
    image_path: input.asset.assetPath,
    image_asset_width: input.asset.width,
    image_asset_height: input.asset.height,
    image_crop: input.crop
      ? { source_page_id: input.pageId, ...input.crop }
      : undefined,
  }
}
