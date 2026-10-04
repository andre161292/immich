import { DownloadImageFormat, DownloadVideoCodec } from '@immich/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { getAnimateMock } from '$lib/__mocks__/animate.mock';
import { getIntersectionObserverMock } from '$lib/__mocks__/intersection-observer.mock';
import { getVisualViewportMock } from '$lib/__mocks__/visual-viewport.mock';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { COMPATIBLE_VARIANT, ORIGINAL_VARIANT } from '$lib/utils/download-variants';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import DownloadOptionsModal from './DownloadOptionsModal.svelte';

describe('DownloadOptionsModal', () => {
  const onClose = vi.fn();
  const custom = { ...COMPATIBLE_VARIANT, imageFormat: DownloadImageFormat.Webp, videoCodec: DownloadVideoCodec.Hevc };

  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', getIntersectionObserverMock());
    vi.stubGlobal('visualViewport', getVisualViewportMock());
    vi.resetAllMocks();
    Element.prototype.animate = getAnimateMock();
    authManager.setUser(userAdminFactory.build());
    authManager.setPreferences(preferencesFactory.build());
  });

  afterAll(async () => {
    await waitFor(() => {
      // check that bits-ui body scroll-lock class is gone
      expect(document.body.style.pointerEvents).not.toBe('none');
    });
  });

  it('should return the preset that was selected before', async () => {
    render(DownloadOptionsModal, { variant: COMPATIBLE_VARIANT, onClose });

    expect(screen.getByText('download_preset_compatible_description')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'download' }));

    expect(onClose).toHaveBeenCalledWith({ variant: COMPATIBLE_VARIANT, remember: false });
  });

  it('should show the custom options', async () => {
    render(DownloadOptionsModal, { variant: custom, onClose });

    expect(screen.getByText('photos')).toBeInTheDocument();
    expect(screen.getByText('videos')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'download' }));

    expect(onClose).toHaveBeenCalledWith({ variant: custom, remember: false });
  });

  it('should only show the options for the selected media', () => {
    render(DownloadOptionsModal, { variant: custom, hasVideos: false, onClose });

    expect(screen.getByText('photos')).toBeInTheDocument();
    expect(screen.queryByText('videos')).not.toBeInTheDocument();
  });

  it('should offer to remember the choice', async () => {
    render(DownloadOptionsModal, { variant: ORIGINAL_VARIANT, onClose });

    await fireEvent.click(screen.getByRole('switch'));
    await fireEvent.click(screen.getByRole('button', { name: 'download' }));

    expect(onClose).toHaveBeenCalledWith({ variant: ORIGINAL_VARIANT, remember: true });
  });
});
