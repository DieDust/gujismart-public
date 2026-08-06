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
