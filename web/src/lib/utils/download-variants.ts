import {
  createDownloadRequest,
  DownloadImageFormat,
  DownloadImageSize,
  DownloadVideoCodec,
  DownloadVideoResolution,
  getBaseUrl,
  getPublicConfig,
  type DownloadInfoDto,
  type DownloadVariantDto,
} from '@immich/sdk';
import { modalManager, toastManager } from '@immich/ui';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { downloadRequestManager } from '$lib/managers/download-request-manager.svelte';
import DownloadOptionsModal from '$lib/modals/DownloadOptionsModal.svelte';
import { withError } from '$lib/utils';
import { handleError } from '$lib/utils/handle-error';
import { getFormatter } from '$lib/utils/i18n';
import { PersistedLocalStorage } from '$lib/utils/persisted';

export enum DownloadPreset {
  Original = 'original',
  Compatible = 'compatible',
  Custom = 'custom',
}

export const ORIGINAL_VARIANT: DownloadVariantDto = Object.freeze({
  imageFormat: DownloadImageFormat.Original,
  imageSize: DownloadImageSize.Original,
  keepMetadata: true,
  videoCodec: DownloadVideoCodec.Original,
  videoResolution: DownloadVideoResolution.Original,
});

export const COMPATIBLE_VARIANT: DownloadVariantDto = Object.freeze({
  imageFormat: DownloadImageFormat.Jpeg,
  imageSize: DownloadImageSize.Original,
  keepMetadata: true,
  videoCodec: DownloadVideoCodec.H264,
  videoResolution: DownloadVideoResolution.Original,
});

export const isSameVariant = (a: DownloadVariantDto, b: DownloadVariantDto) =>
  a.imageFormat === b.imageFormat &&
  a.imageSize === b.imageSize &&
  a.keepMetadata === b.keepMetadata &&
  a.videoCodec === b.videoCodec &&
  a.videoResolution === b.videoResolution;

export const isOriginalVariant = (variant: DownloadVariantDto) =>
  variant.imageFormat === DownloadImageFormat.Original &&
  variant.imageSize === DownloadImageSize.Original &&
  variant.videoCodec === DownloadVideoCodec.Original &&
  variant.videoResolution === DownloadVideoResolution.Original;

export const getPreset = (variant: DownloadVariantDto) => {
  if (isOriginalVariant(variant)) {
    return DownloadPreset.Original;
  }
  if (isSameVariant(variant, COMPATIBLE_VARIANT)) {
    return DownloadPreset.Compatible;
  }
  return DownloadPreset.Custom;
};

export type DownloadOptionsResult = { variant: DownloadVariantDto; remember: boolean };

export type DownloadVariantPreferences = {
  /** show the download options before every download */
  ask: boolean;
  variant: DownloadVariantDto;
};

export const downloadVariantPreferences = new PersistedLocalStorage<DownloadVariantPreferences>(
  'download-variant',
  { ask: true, variant: { ...ORIGINAL_VARIANT } },
  { upgrade: 'merge' },
);

/** Shared link visitors often can't open HEIC or HEVC, so suggest compatible files to them */
const sharedLinkVariantPreferences = new PersistedLocalStorage<DownloadVariantPreferences>(
  'download-variant-shared-link',
  { ask: true, variant: { ...COMPATIBLE_VARIANT } },
  { upgrade: 'merge' },
);

const getPreferences = () => (authManager.isSharedLink ? sharedLinkVariantPreferences : downloadVariantPreferences);

const randomToken = () => {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

const fallbackTokens = new Map<string, string>();

/** Identifies an anonymous shared link visitor, so they can find their downloads again in this browser */
export const getDownloadToken = () => {
  if (!authManager.isSharedLink) {
    return;
  }

  const { key, slug } = authManager.params as { key?: string; slug?: string };
  const storageKey = `download-token:${key ?? slug}`;
  try {
    let token = localStorage.getItem(storageKey);
    if (!token) {
      token = randomToken();
      localStorage.setItem(storageKey, token);
    }
    return token;
  } catch {
    let token = fallbackTokens.get(storageKey);
    if (!token) {
      token = randomToken();
      fallbackTokens.set(storageKey, token);
    }
    return token;
  }
};

export const getDownloadRequestParams = () => ({ ...authManager.params, downloadToken: getDownloadToken() });

export const getDownloadRequestUrl = (path: string) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(getDownloadRequestParams())) {
    if (value) {
      search.set(key, value);
    }
  }
  const query = search.toString();
  return `${getBaseUrl()}/download/requests${path}${query ? `?${query}` : ''}`;
};

let configPromise: Promise<{ enabled: boolean; sharedLinks: boolean }> | undefined;

export const resetDownloadVariantsConfig = () => {
  configPromise = undefined;
};

export const isDownloadVariantsEnabled = async () => {
  configPromise ??= (async () => {
    try {
      const { downloadVariants } = await getPublicConfig();
      return { enabled: !!downloadVariants?.enabled, sharedLinks: !!downloadVariants?.sharedLinks };
    } catch {
      return { enabled: false, sharedLinks: false };
    }
  })();

  const { enabled, sharedLinks } = await configPromise;
  return enabled && (!authManager.isSharedLink || sharedLinks);
};

type ChooseOptions = { hasImages?: boolean; hasVideos?: boolean };

/**
 * Asks which variant to download.
 * Returns `null` for the original files, or `undefined` when the user cancelled.
 */
export const chooseDownloadVariant = async ({ hasImages = true, hasVideos = true }: ChooseOptions = {}) => {
  if (!(await isDownloadVariantsEnabled())) {
    return null;
  }

  const preferences = getPreferences().current;
  if (!preferences.ask) {
    return isOriginalVariant(preferences.variant) ? null : preferences.variant;
  }

  const result = (await modalManager.show(DownloadOptionsModal, {
    hasImages,
    hasVideos,
    variant: preferences.variant,
  })) as DownloadOptionsResult | undefined;
  if (!result) {
    return;
  }

  getPreferences().current = { ask: !result.remember, variant: result.variant };
  return isOriginalVariant(result.variant) ? null : result.variant;
};

type DownloadTarget = Omit<DownloadInfoDto, 'archiveSize'> & {
  name: string;
  single?: boolean;
} & ChooseOptions;

/**
 * Asks for the download variant and prepares it on the server if needed.
 * Returns `true` when the download was taken care of (or cancelled) and the regular download should not continue.
 */
export const handleDownloadVariant = async ({ hasImages, hasVideos, ...target }: DownloadTarget) => {
  const variant = await chooseDownloadVariant({ hasImages, hasVideos });
  if (variant === undefined) {
    return true;
  }
  if (variant === null) {
    return false;
  }

  const $t = await getFormatter();
  const [error, response] = await withError(() =>
    createDownloadRequest({
      ...getDownloadRequestParams(),
      downloadRequestCreateDto: { ...target, variant },
    }),
  );
  if (error || !response) {
    handleError(error, $t('errors.unable_to_download_files'));
    return true;
  }

  if (response.immediate || !response.request) {
    return false;
  }

  downloadRequestManager.add(response.request);
  toastManager.primary($t('download_preparing', { values: { name: response.request.name } }), { timeout: 10_000 });
  return true;
};
