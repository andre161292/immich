import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { isoDatetimeToDate } from 'src/validation.js';

export enum DownloadImageFormat {
  Original = 'original',
  Jpeg = 'jpeg',
  Webp = 'webp',
}

/** Long edge in pixels, or the original resolution */
export enum DownloadImageSize {
  Original = 'original',
  Size3840 = '3840',
  Size2560 = '2560',
  Size1920 = '1920',
}

export enum DownloadVideoCodec {
  Original = 'original',
  H264 = 'h264',
  Hevc = 'hevc',
}

/** Short edge in pixels, or the original resolution */
export enum DownloadVideoResolution {
  Original = 'original',
  P2160 = '2160',
  P1080 = '1080',
  P720 = '720',
}

export enum DownloadRequestStatus {
  Preparing = 'preparing',
  Ready = 'ready',
  Failed = 'failed',
}

const booleanFromForm = z.preprocess((val) => {
  if (val === 'true') {
    return true;
  }
  if (val === 'false') {
    return false;
  }
  return val;
}, z.boolean());

export const DownloadVariantSchema = z
  .object({
    imageFormat: z.enum(DownloadImageFormat).describe('Image format').meta({ id: 'DownloadImageFormat' }),
    imageSize: z.enum(DownloadImageSize).describe('Maximum long edge of images').meta({ id: 'DownloadImageSize' }),
    keepMetadata: booleanFromForm.describe('Copy EXIF metadata into converted files'),
    videoCodec: z.enum(DownloadVideoCodec).describe('Video codec').meta({ id: 'DownloadVideoCodec' }),
    videoResolution: z
      .enum(DownloadVideoResolution)
      .describe('Maximum short edge of videos')
      .meta({ id: 'DownloadVideoResolution' }),
  })
  .refine(
    ({ imageFormat, imageSize }) =>
      imageFormat !== DownloadImageFormat.Original || imageSize === DownloadImageSize.Original,
    { message: 'Resizing images requires a target format', path: ['imageSize'] },
  )
  .meta({ id: 'DownloadVariantDto' });

export type DownloadVariant = z.infer<typeof DownloadVariantSchema>;

const DownloadRequestCreateSchema = z
  .object({
    assetIds: z.array(z.uuidv4()).optional().describe('Asset IDs to download'),
    albumId: z.uuidv4().optional().describe('Album ID to download'),
    userId: z.uuidv4().optional().describe('User ID to download assets from'),
    name: z.string().max(200).optional().describe('Name of the download, used for the archive name'),
    single: z.boolean().optional().describe('Download the files individually instead of as an archive'),
    excludeLivePhotoVideos: z.boolean().optional().describe('Leave out the video part of live photos'),
    variant: DownloadVariantSchema,
  })
  .meta({ id: 'DownloadRequestCreateDto' });

const DownloadRequestTokenSchema = z
  .object({
    downloadToken: z
      .string()
      .min(16)
      .max(128)
      .optional()
      .describe('Client token identifying anonymous shared link visitors'),
  })
  .meta({ id: 'DownloadRequestTokenDto' });

const DownloadRequestSchema = z
  .object({
    id: z.uuidv4().describe('Download request ID'),
    name: z.string().describe('Name of the download'),
    single: z.boolean().describe('Download the files individually instead of as an archive'),
    variant: DownloadVariantSchema,
    status: z.enum(DownloadRequestStatus).describe('Status').meta({ id: 'DownloadRequestStatus' }),
    total: z.int().describe('Number of files'),
    ready: z.int().describe('Number of files ready to download'),
    failed: z.int().describe('Number of files that could not be converted'),
    size: z.int().describe('Total size of the files that are ready, in bytes'),
    createdAt: isoDatetimeToDate.describe('Creation date'),
    expiresAt: isoDatetimeToDate.describe('Expiration date'),
  })
  .meta({ id: 'DownloadRequestDto' });

const DownloadRequestCreateResponseSchema = z
  .object({
    immediate: z.boolean().describe('Nothing needs to be generated, use the regular download endpoints'),
    request: DownloadRequestSchema.optional(),
  })
  .meta({ id: 'DownloadRequestCreateResponseDto' });

const DownloadRequestInfoSchema = z
  .object({
    archiveSize: z.int().min(1).optional().describe('Archive size limit in bytes'),
  })
  .meta({ id: 'DownloadRequestInfoDto' });

const DownloadRequestArchiveSchema = z
  .object({
    // comma-separated string due to the POST form submission, see DownloadArchiveDto
    assetIds: z
      .preprocess((val) => (typeof val === 'string' ? val.split(',').filter(Boolean) : val), z.array(z.uuidv4()))
      .optional()
      .describe('Subset of asset IDs to include, defaults to all'),
    archiveName: z.string().optional().describe('The name of the archive to download, without extension'),
  })
  .meta({ id: 'DownloadRequestArchiveDto' });

export class DownloadRequestCreateDto extends createZodDto(DownloadRequestCreateSchema) {}
export class DownloadRequestTokenDto extends createZodDto(DownloadRequestTokenSchema) {}
export class DownloadRequestDto extends createZodDto(DownloadRequestSchema) {}
export class DownloadRequestCreateResponseDto extends createZodDto(DownloadRequestCreateResponseSchema) {}
export class DownloadRequestInfoDto extends createZodDto(DownloadRequestInfoSchema) {}
export class DownloadRequestArchiveDto extends createZodDto(DownloadRequestArchiveSchema) {}
