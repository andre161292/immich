<script lang="ts">
  import SettingButtonsRow from '$lib/components/shared-components/settings/SystemConfigButtonRow.svelte';
  import SettingInputField from '$lib/components/shared-components/settings/SettingInputField.svelte';
  import SettingSwitch from '$lib/components/shared-components/settings/SettingSwitch.svelte';
  import { SettingInputFieldType } from '$lib/constants';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { systemConfigManager } from '$lib/managers/system-config-manager.svelte';
  import { resetDownloadVariantsConfig } from '$lib/utils/download-variants';
  import { t } from 'svelte-i18n';
  import { fade } from 'svelte/transition';

  const disabled = $derived(featureFlagsManager.value.configFile);
  const config = $derived(systemConfigManager.value);
  let configToEdit = $state(systemConfigManager.cloneValue());

  $effect(() => {
    // the public config is cached, pick up changes after saving
    void config.downloadVariants;
    resetDownloadVariantsConfig();
  });
</script>

<div>
  <div in:fade={{ duration: 500 }}>
    <form autocomplete="off" onsubmit={(event) => event.preventDefault()}>
      <div class="ms-4 mt-4 flex flex-col gap-4">
        <SettingSwitch
          title={$t('admin.download_variants_enabled')}
          subtitle={$t('admin.download_variants_enabled_description')}
          {disabled}
          bind:checked={configToEdit.downloadVariants.enabled}
        />

        <SettingSwitch
          title={$t('admin.download_variants_shared_links')}
          subtitle={$t('admin.download_variants_shared_links_description')}
          disabled={disabled || !configToEdit.downloadVariants.enabled}
          bind:checked={configToEdit.downloadVariants.sharedLinks}
        />

        <hr />

        <SettingInputField
          inputType={SettingInputFieldType.NUMBER}
          label={$t('admin.download_variants_image_quality')}
          description={$t('admin.download_variants_image_quality_description')}
          bind:value={configToEdit.downloadVariants.imageQuality}
          min={1}
          max={100}
          required={true}
          disabled={disabled || !configToEdit.downloadVariants.enabled}
          isEdited={configToEdit.downloadVariants.imageQuality !== config.downloadVariants.imageQuality}
        />

        <SettingInputField
          inputType={SettingInputFieldType.NUMBER}
          label={$t('admin.download_variants_max_assets')}
          description={$t('admin.download_variants_max_assets_description')}
          bind:value={configToEdit.downloadVariants.maxAssetsPerRequest}
          min={1}
          required={true}
          disabled={disabled || !configToEdit.downloadVariants.enabled}
          isEdited={configToEdit.downloadVariants.maxAssetsPerRequest !== config.downloadVariants.maxAssetsPerRequest}
        />

        <SettingInputField
          inputType={SettingInputFieldType.NUMBER}
          label={$t('admin.download_variants_max_videos')}
          description={$t('admin.download_variants_max_videos_description')}
          bind:value={configToEdit.downloadVariants.maxVideosPerRequest}
          min={0}
          required={true}
          disabled={disabled || !configToEdit.downloadVariants.enabled}
          isEdited={configToEdit.downloadVariants.maxVideosPerRequest !== config.downloadVariants.maxVideosPerRequest}
        />

        <SettingInputField
          inputType={SettingInputFieldType.NUMBER}
          label={$t('admin.download_variants_max_active')}
          description={$t('admin.download_variants_max_active_description')}
          bind:value={configToEdit.downloadVariants.maxActiveRequests}
          min={1}
          required={true}
          disabled={disabled || !configToEdit.downloadVariants.enabled}
          isEdited={configToEdit.downloadVariants.maxActiveRequests !== config.downloadVariants.maxActiveRequests}
        />

        <hr />

        <SettingInputField
          inputType={SettingInputFieldType.NUMBER}
          label={$t('admin.download_variants_cache_days')}
          description={$t('admin.download_variants_cache_days_description')}
          bind:value={configToEdit.downloadVariants.cacheDays}
          min={1}
          required={true}
          {disabled}
          isEdited={configToEdit.downloadVariants.cacheDays !== config.downloadVariants.cacheDays}
        />

        <SettingInputField
          inputType={SettingInputFieldType.NUMBER}
          label={$t('admin.download_variants_cache_size')}
          description={$t('admin.download_variants_cache_size_description')}
          bind:value={configToEdit.downloadVariants.cacheSizeGb}
          min={1}
          required={true}
          {disabled}
          isEdited={configToEdit.downloadVariants.cacheSizeGb !== config.downloadVariants.cacheSizeGb}
        />

        <SettingButtonsRow bind:configToEdit keys={['downloadVariants']} {disabled} />
      </div>
    </form>
  </div>
</div>
