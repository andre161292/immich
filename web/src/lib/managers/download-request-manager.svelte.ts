import {
  deleteDownloadRequest,
  DownloadRequestStatus,
  getDownloadRequest,
  getDownloadRequestInfo,
  getDownloadRequests,
  type DownloadRequestDto,
} from '@immich/sdk';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { downloadManager } from '$lib/managers/download-manager.svelte';
import { downloadUrl, downloadUrlPost, sleep, withError } from '$lib/utils';
import {
  getDownloadRequestParams,
  getDownloadRequestUrl,
  isDownloadVariantsEnabled,
} from '$lib/utils/download-variants';
import { handleError } from '$lib/utils/handle-error';
import { getFormatter } from '$lib/utils/i18n';

const POLL_INTERVAL_MS = 3000;

class DownloadRequestManager {
  requests = $state<DownloadRequestDto[]>([]);
  dismissed = $state(false);
  isVisible = $derived(this.requests.length > 0 && !this.dismissed);

  #timer?: ReturnType<typeof setTimeout>;
  #loadedFor?: string;

  /** Loads the downloads of the current user or shared link visitor, e.g. after the browser was closed */
  async load() {
    const context = authManager.isSharedLink
      ? JSON.stringify(authManager.params)
      : authManager.authenticated
        ? authManager.user.id
        : undefined;
    if (context === this.#loadedFor) {
      return;
    }
    this.#loadedFor = context;
    this.requests = [];

    if (!context || !(await isDownloadVariantsEnabled())) {
      return;
    }

    const [error, requests] = await withError(() => getDownloadRequests(getDownloadRequestParams()));
    if (error || !requests) {
      return;
    }

    this.requests = requests;
    this.dismissed = false;
    this.#schedule();
  }

  add(request: DownloadRequestDto) {
    this.requests = [request, ...this.requests.filter(({ id }) => id !== request.id)];
    this.dismissed = false;
    this.#schedule();
  }

  dismiss() {
    this.dismissed = true;
  }

  async remove(id: string) {
    const [error] = await withError(() => deleteDownloadRequest({ ...getDownloadRequestParams(), id }));
    if (error) {
      const translate = await getFormatter();
      handleError(error, translate('errors.unable_to_remove_download'));
      return;
    }
    this.requests = this.requests.filter((request) => request.id !== id);
  }

  async download(request: DownloadRequestDto) {
    const translate = await getFormatter();
    const archiveSize = authManager.authenticated ? authManager.preferences.download.archiveSize : undefined;
    const [error, info] = await withError(() =>
      getDownloadRequestInfo({
        ...getDownloadRequestParams(),
        id: request.id,
        downloadRequestInfoDto: { archiveSize },
      }),
    );
    if (error || !info) {
      handleError(error, translate('errors.unable_to_download_files'));
      return;
    }

    if (request.single) {
      const assetIds = info.archives.flatMap(({ assetIds }) => assetIds);
      for (const [index, assetId] of assetIds.entries()) {
        if (index !== 0) {
          // play nice with Safari
          await sleep(500);
        }
        downloadUrl(getDownloadRequestUrl(`/${request.id}/assets/${assetId}`), '');
      }
      return;
    }

    const url = getDownloadRequestUrl(`/${request.id}/archive`);
    if (info.archives.length === 1) {
      downloadUrlPost(url, info.archives[0].assetIds, request.name);
      return;
    }

    for (const [index, archive] of info.archives.entries()) {
      const archiveName = `${request.name}+${index + 1}`;
      downloadManager.add(
        `${archiveName} (${index + 1}/${info.archives.length})`,
        url,
        archive.assetIds,
        archiveName,
        archive.size,
      );
    }
  }

  #schedule() {
    if (this.#timer || this.requests.every(({ status }) => status !== DownloadRequestStatus.Preparing)) {
      return;
    }
    this.#timer = setTimeout(() => void this.#poll(), POLL_INTERVAL_MS);
  }

  async #poll() {
    this.#timer = undefined;
    const params = getDownloadRequestParams();
    this.requests = await Promise.all(
      this.requests.map(async (request) => {
        if (request.status !== DownloadRequestStatus.Preparing) {
          return request;
        }
        const [error, updated] = await withError(() => getDownloadRequest({ ...params, id: request.id }));
        return error || !updated ? request : updated;
      }),
    );
    this.#schedule();
  }
}

export const downloadRequestManager = new DownloadRequestManager();
