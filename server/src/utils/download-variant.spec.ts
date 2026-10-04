import { StorageCore } from 'src/cores/storage.core';
import {
  DownloadImageFormat,
  DownloadImageSize,
  DownloadVariant,
  DownloadVideoCodec,
  DownloadVideoResolution,
} from 'src/dtos/download-variant.dto';
import { AssetFileType, AssetType } from 'src/enum';
import {
  VariantAsset,
  getAssetIdFromVariantPath,
  getDownloadVariantJobId,
  resolveVariant,
  uniqueFileNames,
} from 'src/utils/download-variant';

StorageCore.setMediaLocation('/data');

const originals: DownloadVariant = {
  imageFormat: DownloadImageFormat.Original,
  imageSize: DownloadImageSize.Original,
  keepMetadata: true,
  videoCodec: DownloadVideoCodec.Original,
  videoResolution: DownloadVideoResolution.Original,
};

const compatible: DownloadVariant = {
  ...originals,
  imageFormat: DownloadImageFormat.Jpeg,
  videoCodec: DownloadVideoCodec.H264,
};

const options = { edited: true, keepMetadata: true, imageQuality: 90 };

const image = (overrides: Partial<VariantAsset> = {}): VariantAsset => ({
  id: '6e8fb3ac-0a6b-4c1e-9a1f-7d2b6f0c2d11',
  ownerId: 'owner-id',
  type: AssetType.Image,
  originalPath: '/data/upload/IMG_0001.HEIC',
  originalFileName: 'IMG_0001.HEIC',
  checksum: Buffer.from('checksum'),
  width: 4032,
  height: 3024,
  videoCodec: null,
  files: [],
  ...overrides,
});

const video = (overrides: Partial<VariantAsset> = {}): VariantAsset =>
  image({
    type: AssetType.Video,
    originalPath: '/data/upload/IMG_0002.MOV',
    originalFileName: 'IMG_0002.MOV',
    width: 3840,
    height: 2160,
    videoCodec: 'hevc',
    ...overrides,
  });

describe('resolveVariant', () => {
  describe('images', () => {
    it('should pass through originals', () => {
      expect(resolveVariant(image(), originals, options)).toEqual({
        kind: 'passthrough',
        assetId: image().id,
        path: '/data/upload/IMG_0001.HEIC',
        fileName: 'IMG_0001.HEIC',
      });
    });

    it('should convert HEIC to JPEG', () => {
      const result = resolveVariant(image(), compatible, options);
      expect(result).toMatchObject({
        kind: 'generate',
        fileName: 'IMG_0001.jpg',
        job: { media: 'image', format: 'jpeg', size: undefined, source: 'original', quality: 90, keepMetadata: true },
      });
      expect(result.path).toMatch(/download-cache\/variants\/owner-id\/6e\/8f\/6e8fb3ac-.*\.jpg$/);
    });

    it('should pass through a JPEG that is requested as JPEG', () => {
      const asset = image({ originalPath: '/data/upload/IMG_0003.JPG', originalFileName: 'IMG_0003.JPG' });
      expect(resolveVariant(asset, compatible, options)).toMatchObject({
        kind: 'passthrough',
        fileName: 'IMG_0003.JPG',
      });
    });

    it('should resize a JPEG that is larger than requested', () => {
      const asset = image({ originalPath: '/data/upload/IMG_0003.JPG', originalFileName: 'IMG_0003.JPG' });
      const variant = { ...compatible, imageSize: DownloadImageSize.Size1920 };
      expect(resolveVariant(asset, variant, options)).toMatchObject({
        kind: 'generate',
        job: { format: 'jpeg', size: 1920 },
      });
    });

    it('should not resize an image that is already small enough', () => {
      const asset = image({ width: 1600, height: 1200 });
      const variant = { ...compatible, imageSize: DownloadImageSize.Size1920 };
      expect(resolveVariant(asset, variant, options)).toMatchObject({ kind: 'generate', job: { size: undefined } });
    });

    it('should pass through animated GIFs', () => {
      const asset = image({ originalPath: '/data/upload/funny.gif', originalFileName: 'funny.gif' });
      expect(resolveVariant(asset, compatible, options)).toMatchObject({ kind: 'passthrough' });
    });

    it('should use the edited version', () => {
      const asset = image({
        files: [
          { type: AssetFileType.FullSize, path: '/data/thumbs/edited.jpeg', isEdited: true, updateId: 'update-1' },
        ],
      });
      expect(resolveVariant(asset, originals, options)).toMatchObject({
        kind: 'passthrough',
        path: '/data/thumbs/edited.jpeg',
        fileName: 'IMG_0001.jpeg',
      });
      expect(resolveVariant(asset, { ...compatible, imageFormat: DownloadImageFormat.Webp }, options)).toMatchObject({
        kind: 'generate',
        job: { source: 'edited', format: 'webp' },
      });
    });

    it('should ignore the edited version when not requested', () => {
      const asset = image({
        files: [
          { type: AssetFileType.FullSize, path: '/data/thumbs/edited.jpeg', isEdited: true, updateId: 'update-1' },
        ],
      });
      expect(resolveVariant(asset, originals, { ...options, edited: false })).toMatchObject({
        path: '/data/upload/IMG_0001.HEIC',
      });
    });

    it('should use a different cache key per variant', () => {
      const jpeg = resolveVariant(image(), compatible, options);
      const small = resolveVariant(image(), { ...compatible, imageSize: DownloadImageSize.Size1920 }, options);
      const noMetadata = resolveVariant(image(), compatible, { ...options, keepMetadata: false });
      const otherQuality = resolveVariant(image(), compatible, { ...options, imageQuality: 80 });
      const changed = resolveVariant(image({ checksum: Buffer.from('changed') }), compatible, options);
      const paths = new Set([jpeg.path, small.path, noMetadata.path, otherQuality.path, changed.path]);
      expect(paths.size).toBe(5);
    });

    it('should be deterministic', () => {
      expect(resolveVariant(image(), compatible, options).path).toBe(resolveVariant(image(), compatible, options).path);
    });
  });

  describe('videos', () => {
    it('should pass through originals', () => {
      expect(resolveVariant(video(), originals, options)).toMatchObject({
        kind: 'passthrough',
        fileName: 'IMG_0002.MOV',
      });
    });

    it('should transcode HEVC to H.264', () => {
      expect(resolveVariant(video(), compatible, options)).toMatchObject({
        kind: 'generate',
        fileName: 'IMG_0002.mp4',
        job: { media: 'video', codec: 'h264', resolution: undefined },
      });
    });

    it('should pass through when the codec matches and no downscaling is needed', () => {
      const variant = { ...originals, videoCodec: DownloadVideoCodec.Hevc };
      expect(resolveVariant(video(), variant, options)).toMatchObject({ kind: 'passthrough' });
    });

    it('should downscale and keep the codec', () => {
      const variant = { ...originals, videoResolution: DownloadVideoResolution.P1080 };
      expect(resolveVariant(video(), variant, options)).toMatchObject({
        kind: 'generate',
        job: { codec: 'hevc', resolution: 1080 },
      });
    });

    it('should encode to H.264 when downscaling a codec that cannot be encoded', () => {
      const variant = { ...originals, videoResolution: DownloadVideoResolution.P720 };
      expect(resolveVariant(video({ videoCodec: 'prores' }), variant, options)).toMatchObject({
        kind: 'generate',
        job: { codec: 'h264', resolution: 720 },
      });
    });

    it('should not downscale a video that is already small enough', () => {
      const variant = {
        ...originals,
        videoCodec: DownloadVideoCodec.Hevc,
        videoResolution: DownloadVideoResolution.P1080,
      };
      expect(resolveVariant(video({ width: 1920, height: 1080 }), variant, options)).toMatchObject({
        kind: 'passthrough',
      });
    });

    it('should use 1080p HEVC as requested', () => {
      const variant = {
        ...originals,
        videoCodec: DownloadVideoCodec.Hevc,
        videoResolution: DownloadVideoResolution.P1080,
      };
      expect(resolveVariant(video({ videoCodec: 'h264' }), variant, options)).toMatchObject({
        kind: 'generate',
        job: { codec: 'hevc', resolution: 1080 },
      });
    });
  });

  it('should pass through other asset types', () => {
    const asset = image({ type: AssetType.Other, originalPath: '/data/upload/file.pdf', originalFileName: 'file.pdf' });
    expect(resolveVariant(asset, compatible, options)).toMatchObject({ kind: 'passthrough' });
  });
});

describe('getAssetIdFromVariantPath', () => {
  it('should parse the asset id', () => {
    const { path } = resolveVariant(image(), compatible, options);
    expect(getAssetIdFromVariantPath(path)).toBe(image().id);
    expect(getAssetIdFromVariantPath(path + '.failed')).toBe(image().id);
  });

  it('should ignore other files', () => {
    expect(getAssetIdFromVariantPath('/data/download-cache/variants/random.txt')).toBeUndefined();
  });
});

describe('getDownloadVariantJobId', () => {
  it('should not contain colons', () => {
    const { path } = resolveVariant(image(), compatible, options);
    expect(getDownloadVariantJobId(path)).not.toContain(':');
  });
});

describe('uniqueFileNames', () => {
  it('should number duplicates', () => {
    const getFileName = uniqueFileNames();
    expect(getFileName('a.jpg')).toBe('a.jpg');
    expect(getFileName('a.jpg')).toBe('a+1.jpg');
    expect(getFileName('a.jpg')).toBe('a+2.jpg');
    expect(getFileName('b.jpg')).toBe('b.jpg');
  });
});
