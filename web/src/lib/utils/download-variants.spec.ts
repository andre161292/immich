import { DownloadImageFormat, DownloadRequestStatus, DownloadVideoCodec, type DownloadRequestDto } from '@immich/sdk';
import { modalManager } from '@immich/ui';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { downloadRequestManager } from '$lib/managers/download-request-manager.svelte';
import {
  COMPATIBLE_VARIANT,
  DownloadPreset,
  downloadVariantPreferences,
  getPreset,
  handleDownloadVariant,
  isOriginalVariant,
  ORIGINAL_VARIANT,
  resetDownloadVariantsConfig,
} from '$lib/utils/download-variants';
import { getFormatter } from '$lib/utils/i18n';

vi.mock('@immich/ui', async (originalImport) => {
  const module = await originalImport<typeof import('@immich/ui')>();
  return {
    ...module,
    modalManager: { show: vi.fn() },
    toastManager: { primary: vi.fn() },
  };
});

vi.mock('$lib/utils/i18n', () => ({
  getFormatter: vi.fn(),
  getPreferredLocale: vi.fn(),
}));

const request: DownloadRequestDto = {
  id: 'request-1',
  name: 'Holiday',
  single: false,
  variant: COMPATIBLE_VARIANT,
  status: DownloadRequestStatus.Preparing,
  total: 2,
  ready: 0,
  failed: 0,
  size: 0,
  createdAt: '2026-10-04T00:00:00.000Z',
  expiresAt: '2026-10-11T00:00:00.000Z',
};

describe('download variants', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getFormatter).mockResolvedValue(((key: string) => key) as never);
    resetDownloadVariantsConfig();
    downloadVariantPreferences.current = { ask: true, variant: { ...ORIGINAL_VARIANT }, excludeLivePhotoVideos: true };
    downloadRequestManager.requests = [];
    sdkMock.getPublicConfig.mockResolvedValue({ downloadVariants: { enabled: true, sharedLinks: true } } as never);
  });

  describe('getPreset', () => {
    it('should detect the presets', () => {
      expect(getPreset(ORIGINAL_VARIANT)).toBe(DownloadPreset.Original);
      expect(getPreset(COMPATIBLE_VARIANT)).toBe(DownloadPreset.Compatible);
      expect(getPreset({ ...COMPATIBLE_VARIANT, videoCodec: DownloadVideoCodec.Hevc })).toBe(DownloadPreset.Custom);
    });

    it('should treat originals without metadata as originals', () => {
      expect(isOriginalVariant({ ...ORIGINAL_VARIANT, keepMetadata: false })).toBe(true);
      expect(isOriginalVariant({ ...ORIGINAL_VARIANT, imageFormat: DownloadImageFormat.Jpeg })).toBe(false);
    });
  });

  describe('handleDownloadVariant', () => {
    it('should continue with the regular download when the feature is disabled', async () => {
      sdkMock.getPublicConfig.mockResolvedValue({ downloadVariants: { enabled: false, sharedLinks: false } } as never);

      await expect(handleDownloadVariant({ assetIds: ['asset-1'], name: 'test' })).resolves.toEqual({
        handled: false,
        excludeLivePhotoVideos: false,
      });
      expect(modalManager.show).not.toHaveBeenCalled();
    });

    it('should continue with the regular download when the config cannot be loaded', async () => {
      sdkMock.getPublicConfig.mockRejectedValue(new Error('offline'));

      await expect(handleDownloadVariant({ assetIds: ['asset-1'], name: 'test' })).resolves.toMatchObject({
        handled: false,
      });
    });

    it('should stop when the modal is cancelled', async () => {
      vi.mocked(modalManager.show).mockResolvedValue(undefined as never);

      await expect(handleDownloadVariant({ assetIds: ['asset-1'], name: 'test' })).resolves.toMatchObject({
        handled: true,
      });
      expect(sdkMock.createDownloadRequest).not.toHaveBeenCalled();
    });

    it('should continue with the regular download for original files', async () => {
      vi.mocked(modalManager.show).mockResolvedValue({
        variant: ORIGINAL_VARIANT,
        excludeLivePhotoVideos: true,
        remember: false,
      } as never);

      // the regular download leaves out live photo videos as well
      await expect(handleDownloadVariant({ assetIds: ['asset-1'], name: 'test' })).resolves.toEqual({
        handled: false,
        excludeLivePhotoVideos: true,
      });
      expect(sdkMock.createDownloadRequest).not.toHaveBeenCalled();
    });

    it('should continue with the regular download when nothing needs to be converted', async () => {
      vi.mocked(modalManager.show).mockResolvedValue({
        variant: COMPATIBLE_VARIANT,
        excludeLivePhotoVideos: false,
        remember: false,
      } as never);
      sdkMock.createDownloadRequest.mockResolvedValue({ immediate: true });

      await expect(handleDownloadVariant({ assetIds: ['asset-1'], name: 'test', single: true })).resolves.toEqual({
        handled: false,
        excludeLivePhotoVideos: false,
      });
      expect(sdkMock.createDownloadRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          downloadRequestCreateDto: {
            assetIds: ['asset-1'],
            name: 'test',
            single: true,
            excludeLivePhotoVideos: false,
            variant: COMPATIBLE_VARIANT,
          },
        }),
      );
    });

    it('should track the request when files are being converted', async () => {
      vi.mocked(modalManager.show).mockResolvedValue({
        variant: COMPATIBLE_VARIANT,
        excludeLivePhotoVideos: false,
        remember: false,
      } as never);
      sdkMock.createDownloadRequest.mockResolvedValue({ immediate: false, request });

      await expect(handleDownloadVariant({ albumId: 'album-1', name: 'Holiday' })).resolves.toMatchObject({
        handled: true,
      });
      expect(downloadRequestManager.requests).toEqual([request]);
    });

    it('should not ask again when the choice was remembered', async () => {
      vi.mocked(modalManager.show).mockResolvedValue({
        variant: COMPATIBLE_VARIANT,
        excludeLivePhotoVideos: true,
        remember: true,
      } as never);
      sdkMock.createDownloadRequest.mockResolvedValue({ immediate: true });

      await handleDownloadVariant({ assetIds: ['asset-1'], name: 'test' });
      await handleDownloadVariant({ assetIds: ['asset-2'], name: 'test' });

      expect(modalManager.show).toHaveBeenCalledTimes(1);
      expect(sdkMock.createDownloadRequest).toHaveBeenCalledTimes(2);
      expect(downloadVariantPreferences.current).toEqual({
        ask: false,
        variant: COMPATIBLE_VARIANT,
        excludeLivePhotoVideos: true,
      });
      expect(sdkMock.createDownloadRequest).toHaveBeenLastCalledWith(
        expect.objectContaining({
          downloadRequestCreateDto: expect.objectContaining({ excludeLivePhotoVideos: true }),
        }),
      );
    });
  });
});
