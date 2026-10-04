import { createHash } from 'node:crypto';
import { extname, join, parse } from 'node:path';
import sanitize from 'sanitize-filename';
import { StorageCore } from 'src/cores/storage.core';
import {
  DownloadImageFormat,
  DownloadImageSize,
  DownloadVariant,
  DownloadVideoCodec,
  DownloadVideoResolution,
} from 'src/dtos/download-variant.dto';
import { AssetFileType, AssetType, VideoCodec } from 'src/enum';

export const DOWNLOAD_CACHE_FOLDER = 'download-cache';
export const DOWNLOAD_FAILED_SUFFIX = '.failed';

/** Bump to invalidate every cached variant, e.g. after changing how variants are encoded */
const VARIANT_VERSION = 1;

export type VariantAsset = {
  id: string;
  ownerId: string;
  type: AssetType;
  originalPath: string;
  originalFileName: string;
  checksum: Buffer;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  files: { type: AssetFileType; path: string; isEdited: boolean; updateId: string }[];
};

export type VariantOptions = {
  /** use the edited version of an image if there is one */
  edited: boolean;
  keepMetadata: boolean;
  imageQuality: number;
};

export type DownloadVariantJob =
  | {
      id: string;
      output: string;
      media: 'image';
      source: 'original' | 'edited';
      format: DownloadImageFormat.Jpeg | DownloadImageFormat.Webp;
      /** long edge, undefined for the original resolution */
      size?: number;
      quality: number;
      keepMetadata: boolean;
    }
  | {
      id: string;
      output: string;
      media: 'video';
      codec: VideoCodec.H264 | VideoCodec.Hevc;
      /** short edge, undefined for the original resolution */
      resolution?: number;
      keepMetadata: boolean;
    };

export type ResolvedVariant =
  | { kind: 'passthrough'; assetId: string; path: string; fileName: string }
  | { kind: 'generate'; assetId: string; path: string; fileName: string; job: DownloadVariantJob };

export const getDownloadCacheFolder = () => join(StorageCore.getMediaLocation(), DOWNLOAD_CACHE_FOLDER);
export const getDownloadVariantFolder = () => join(getDownloadCacheFolder(), 'variants');
export const getDownloadRequestFolder = () => join(getDownloadCacheFolder(), 'requests');

const getVariantPath = (asset: VariantAsset, key: string, extension: string) =>
  join(
    getDownloadVariantFolder(),
    asset.ownerId,
    asset.id.slice(0, 2),
    asset.id.slice(2, 4),
    `${asset.id}-${key}.${extension}`,
  );

/** Parses the asset id out of a cached variant file name */
export const getAssetIdFromVariantPath = (path: string) => {
  const match = parse(path).base.match(/^([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})-/);
  return match?.[1];
};

const hash = (value: unknown) =>
  createHash('sha1')
    .update(JSON.stringify({ version: VARIANT_VERSION, value }))
    .digest('hex')
    .slice(0, 16);

const getFileName = (asset: VariantAsset, path: string) => {
  const base = parse(sanitize(asset.originalFileName) || 'unnamed').name;
  return `${base}${extname(path).toLowerCase()}`;
};

const getImageFormat = (path: string) => {
  switch (extname(path).toLowerCase()) {
    case '.jpg':
    case '.jpeg': {
      return DownloadImageFormat.Jpeg;
    }
    case '.webp': {
      return DownloadImageFormat.Webp;
    }
    default: {
      return null;
    }
  }
};

const passthrough = (asset: VariantAsset, path: string, fileName?: string): ResolvedVariant => ({
  kind: 'passthrough',
  assetId: asset.id,
  path,
  fileName: fileName ?? (sanitize(asset.originalFileName) || 'unnamed'),
});

const resolveImage = (asset: VariantAsset, variant: DownloadVariant, options: VariantOptions): ResolvedVariant => {
  const editedFile = options.edited
    ? asset.files.find((file) => file.type === AssetFileType.FullSize && file.isEdited)
    : undefined;
  const sourcePath = editedFile?.path ?? asset.originalPath;
  const sourceFileName = editedFile ? getFileName(asset, editedFile.path) : undefined;

  // animated images would lose their animation
  if (variant.imageFormat === DownloadImageFormat.Original || extname(asset.originalPath).toLowerCase() === '.gif') {
    return passthrough(asset, sourcePath, sourceFileName);
  }

  const format = variant.imageFormat;
  const size = variant.imageSize === DownloadImageSize.Original ? undefined : Number(variant.imageSize);
  const longEdge = editedFile ? null : Math.max(asset.width ?? 0, asset.height ?? 0) || null;
  const fitsSize = size === undefined || (longEdge !== null && longEdge <= size);
  if (getImageFormat(sourcePath) === format && fitsSize) {
    return passthrough(asset, sourcePath, sourceFileName);
  }

  const source = editedFile ? 'edited' : 'original';
  const fingerprint = editedFile ? `${editedFile.path}:${editedFile.updateId}` : asset.checksum.toString('hex');
  const key = hash({
    fingerprint,
    format,
    size: fitsSize ? undefined : size,
    quality: options.imageQuality,
    keepMetadata: options.keepMetadata,
  });
  const path = getVariantPath(asset, key, format === DownloadImageFormat.Jpeg ? 'jpg' : 'webp');

  return {
    kind: 'generate',
    assetId: asset.id,
    path,
    fileName: getFileName(asset, path),
    job: {
      id: asset.id,
      output: path,
      media: 'image',
      source,
      format,
      size: fitsSize ? undefined : size,
      quality: options.imageQuality,
      keepMetadata: options.keepMetadata,
    },
  };
};

const resolveVideo = (asset: VariantAsset, variant: DownloadVariant, options: VariantOptions): ResolvedVariant => {
  const sourceCodec = asset.videoCodec?.toLowerCase() ?? null;
  const shortEdge = Math.min(asset.width ?? 0, asset.height ?? 0) || null;
  const resolution =
    variant.videoResolution === DownloadVideoResolution.Original ? undefined : Number(variant.videoResolution);
  const fitsResolution = resolution === undefined || (shortEdge !== null && shortEdge <= resolution);

  let codec: VideoCodec.H264 | VideoCodec.Hevc;
  if (variant.videoCodec === DownloadVideoCodec.Original) {
    if (fitsResolution) {
      return passthrough(asset, asset.originalPath);
    }
    // keep the codec when only downscaling, if we can encode it
    codec = sourceCodec === VideoCodec.Hevc ? VideoCodec.Hevc : VideoCodec.H264;
  } else {
    codec = variant.videoCodec === DownloadVideoCodec.Hevc ? VideoCodec.Hevc : VideoCodec.H264;
    if (sourceCodec === codec && fitsResolution) {
      return passthrough(asset, asset.originalPath);
    }
  }

  const key = hash({
    fingerprint: asset.checksum.toString('hex'),
    codec,
    resolution: fitsResolution ? undefined : resolution,
    keepMetadata: options.keepMetadata,
  });
  const path = getVariantPath(asset, key, 'mp4');

  return {
    kind: 'generate',
    assetId: asset.id,
    path,
    fileName: getFileName(asset, path),
    job: {
      id: asset.id,
      output: path,
      media: 'video',
      codec,
      resolution: fitsResolution ? undefined : resolution,
      keepMetadata: options.keepMetadata,
    },
  };
};

/** Decides whether an asset can be served as is, or which variant has to be generated for it */
export const resolveVariant = (
  asset: VariantAsset,
  variant: DownloadVariant,
  options: VariantOptions,
): ResolvedVariant => {
  switch (asset.type) {
    case AssetType.Image: {
      return resolveImage(asset, variant, options);
    }
    case AssetType.Video: {
      return resolveVideo(asset, variant, options);
    }
    default: {
      return passthrough(asset, asset.originalPath);
    }
  }
};

/** Makes file names inside an archive unique, the same way the regular archive download does */
export const uniqueFileNames = () => {
  const counts: Record<string, number> = {};
  return (fileName: string) => {
    const count = counts[fileName] || 0;
    counts[fileName] = count + 1;
    if (count === 0) {
      return fileName;
    }
    const { name, ext } = parse(fileName);
    return `${name}+${count}${ext}`;
  };
};

/** BullMQ job ids may not contain colons, the file name is unique per asset and variant */
export const getDownloadVariantJobId = (output: string) => `download-variant-${parse(output).name}`;
