<script lang="ts">
  import SettingInputField from '$lib/components/shared-components/settings/SettingInputField.svelte';
  import SettingSwitch from '$lib/components/shared-components/settings/SettingSwitch.svelte';
  import { SettingInputFieldType } from '$lib/constants';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { ByteUnit, convertFromBytes, convertToBytes } from '$lib/utils/byte-units';
  import { downloadVariantPreferences, isDownloadVariantsEnabled } from '$lib/utils/download-variants';
  import { handleError } from '$lib/utils/handle-error';
  import { updateMyPreferences } from '@immich/sdk';
  import { Button, toastManager } from '@immich/ui';
  import { t } from 'svelte-i18n';
  import { fade } from 'svelte/transition';

  let archiveSize = $state(convertFromBytes(authManager.preferences.download.archiveSize || 4, ByteUnit.GiB));
  let includeEmbeddedVideos = $state(authManager.preferences.download.includeEmbeddedVideos);
  let askForVariant = $state(downloadVariantPreferences.current.ask);

  const handleSave = async () => {
    try {
      const response = await updateMyPreferences({
        userPreferencesUpdateDto: {
          download: {
            archiveSize: Math.floor(convertToBytes(archiveSize, ByteUnit.GiB)),
            includeEmbeddedVideos,
          },
        },
      });

      authManager.setPreferences(response);
      downloadVariantPreferences.current = { ...downloadVariantPreferences.current, ask: askForVariant };

      toastManager.primary($t('saved_settings'));
    } catch (error) {
      handleError(error, $t('errors.unable_to_update_settings'));
    }
  };

  const onsubmit = (event: Event) => {
    event.preventDefault();
  };
</script>

<section class="my-4">
  <div in:fade={{ duration: 500 }}>
    <form autocomplete="off" {onsubmit}>
      <div class="flex flex-col gap-4 sm:ms-8">
        <SettingInputField
          inputType={SettingInputFieldType.NUMBER}
          label={$t('archive_size')}
          description={$t('archive_size_description')}
          bind:value={archiveSize}
        />
        <SettingSwitch
          title={$t('download_include_embedded_motion_videos')}
          subtitle={$t('download_include_embedded_motion_videos_description')}
          bind:checked={includeEmbeddedVideos}
        ></SettingSwitch>
        {#await isDownloadVariantsEnabled() then enabled}
          {#if enabled}
            <SettingSwitch
              title={$t('download_ask_options')}
              subtitle={$t('download_ask_options_description')}
              bind:checked={askForVariant}
            ></SettingSwitch>
          {/if}
        {/await}
        <div class="flex justify-end">
          <Button shape="round" type="submit" size="small" onclick={() => handleSave()}>{$t('save')}</Button>
        </div>
      </div>
    </form>
  </div>
</section>
