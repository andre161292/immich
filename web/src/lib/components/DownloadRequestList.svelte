<script lang="ts">
  import { downloadRequestManager } from '$lib/managers/download-request-manager.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import { DownloadRequestStatus } from '@immich/sdk';
  import { IconButton, ProgressBar, Text } from '@immich/ui';
  import { mdiClose, mdiDownload } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import { slide } from 'svelte/transition';
</script>

{#each downloadRequestManager.requests as request (request.id)}
  <div class="mb-2 flex place-items-center gap-2" transition:slide>
    <div class="min-w-0 grow">
      <div class="flex place-items-center justify-between gap-2 text-xs font-medium">
        <p class="truncate">{request.name}</p>
        {#if request.status === DownloadRequestStatus.Ready}
          <p class="whitespace-nowrap">{getByteUnitString(request.size, $locale)}</p>
        {:else}
          <p class="whitespace-nowrap">{request.ready + request.failed}/{request.total}</p>
        {/if}
      </div>
      {#if request.status === DownloadRequestStatus.Preparing}
        <ProgressBar
          containerClass="mt-1"
          size="tiny"
          border
          stop={false}
          progress={request.total > 0 ? (request.ready + request.failed) / request.total : 0}
        />
        <Text size="tiny" color="muted">{$t('download_preparing_status')}</Text>
      {:else if request.status === DownloadRequestStatus.Failed}
        <Text size="tiny" color="danger">{$t('download_failed_status')}</Text>
      {:else if request.failed > 0}
        <Text size="tiny" color="warning">
          {$t('download_partially_failed_status', { values: { count: request.failed } })}
        </Text>
      {/if}
    </div>
    <div class="flex gap-1">
      {#if request.status === DownloadRequestStatus.Ready}
        <IconButton
          color="secondary"
          variant="outline"
          shape="round"
          size="tiny"
          icon={mdiDownload}
          aria-label={$t('download')}
          onclick={() => downloadRequestManager.download(request)}
        />
      {/if}
      <IconButton
        color="secondary"
        variant="ghost"
        shape="round"
        size="tiny"
        icon={mdiClose}
        aria-label={$t(request.status === DownloadRequestStatus.Preparing ? 'cancel' : 'remove')}
        onclick={() => downloadRequestManager.remove(request.id)}
      />
    </div>
  </div>
{/each}
