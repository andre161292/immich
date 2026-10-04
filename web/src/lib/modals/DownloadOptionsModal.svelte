<script lang="ts">
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import {
    COMPATIBLE_VARIANT,
    DownloadPreset,
    getPreset,
    ORIGINAL_VARIANT,
    type DownloadOptionsResult,
  } from '$lib/utils/download-variants';
  import {
    DownloadImageFormat,
    DownloadImageSize,
    DownloadVideoCodec,
    DownloadVideoResolution,
    type DownloadVariantDto,
  } from '@immich/sdk';
  import { Field, FormModal, HelperText, Select, Stack, Switch, Text } from '@immich/ui';
  import { t } from 'svelte-i18n';

  type Props = {
    hasImages?: boolean;
    hasVideos?: boolean;
    hasLivePhotos?: boolean;
    variant: DownloadVariantDto;
    excludeLivePhotoVideos?: boolean;
    onClose: (result?: DownloadOptionsResult) => void;
  };

  let {
    hasImages = true,
    hasVideos = true,
    hasLivePhotos = true,
    variant: initial,
    excludeLivePhotoVideos: initialExcludeLivePhotoVideos = true,
    onClose,
  }: Props = $props();

  let preset = $state(getPreset(initial));
  let custom = $state({ ...initial });
  let excludeLivePhotoVideos = $state(initialExcludeLivePhotoVideos);
  let remember = $state(false);

  const variant = $derived.by(() => {
    switch (preset) {
      case DownloadPreset.Original: {
        return ORIGINAL_VARIANT;
      }
      case DownloadPreset.Compatible: {
        return COMPATIBLE_VARIANT;
      }
      default: {
        return custom;
      }
    }
  });

  const presetOptions = [
    { value: DownloadPreset.Original, label: $t('download_preset_original') },
    { value: DownloadPreset.Compatible, label: $t('download_preset_compatible') },
    { value: DownloadPreset.Custom, label: $t('download_preset_custom') },
  ];

  const imageFormatOptions = [
    { value: DownloadImageFormat.Original, label: $t('download_format_original') },
    { value: DownloadImageFormat.Jpeg, label: 'JPEG' },
    { value: DownloadImageFormat.Webp, label: 'WebP' },
  ];

  const imageSizeOptions = [
    { value: DownloadImageSize.Original, label: $t('download_resolution_original') },
    { value: DownloadImageSize.$3840, label: '3840 px' },
    { value: DownloadImageSize.$2560, label: '2560 px' },
    { value: DownloadImageSize.$1920, label: '1920 px' },
  ];

  const videoCodecOptions = [
    { value: DownloadVideoCodec.Original, label: $t('download_format_original') },
    { value: DownloadVideoCodec.H264, label: 'H.264' },
    { value: DownloadVideoCodec.Hevc, label: 'HEVC (H.265)' },
  ];

  const videoResolutionOptions = [
    { value: DownloadVideoResolution.Original, label: $t('download_resolution_original') },
    { value: DownloadVideoResolution.$2160, label: '2160p' },
    { value: DownloadVideoResolution.$1080, label: '1080p' },
    { value: DownloadVideoResolution.$720, label: '720p' },
  ];

  // resizing needs a format to encode to
  $effect(() => {
    if (custom.imageFormat === DownloadImageFormat.Original && custom.imageSize !== DownloadImageSize.Original) {
      custom.imageFormat = DownloadImageFormat.Jpeg;
    }
  });

  const onSubmit = () => {
    onClose({ variant: { ...variant }, excludeLivePhotoVideos, remember });
  };
</script>

<FormModal title={$t('download_options')} {onClose} {onSubmit} size="small" submitText={$t('download')}>
  <Stack gap={4}>
    <Field label={$t('download_preset')}>
      <Select bind:value={preset} options={presetOptions} />
      {#if preset === DownloadPreset.Compatible}
        <HelperText>{$t('download_preset_compatible_description')}</HelperText>
      {:else if preset === DownloadPreset.Original}
        <HelperText>{$t('download_preset_original_description')}</HelperText>
      {/if}
    </Field>

    {#if preset === DownloadPreset.Custom}
      {#if hasImages}
        <Text fontWeight="semi-bold">{$t('photos')}</Text>
        <Field label={$t('download_format')}>
          <Select bind:value={custom.imageFormat} options={imageFormatOptions} />
        </Field>
        <Field label={$t('download_image_size')}>
          <Select bind:value={custom.imageSize} options={imageSizeOptions} />
        </Field>
      {/if}

      {#if hasVideos}
        <Text fontWeight="semi-bold">{$t('videos')}</Text>
        <Field label={$t('download_video_codec')}>
          <Select bind:value={custom.videoCodec} options={videoCodecOptions} />
        </Field>
        <Field label={$t('download_video_resolution')}>
          <Select bind:value={custom.videoResolution} options={videoResolutionOptions} />
        </Field>
      {/if}

      <Field label={$t('download_keep_metadata')}>
        <Switch bind:checked={custom.keepMetadata} />
      </Field>
    {/if}

    {#if hasImages && hasLivePhotos}
      <Field label={$t('download_exclude_live_photo_videos')}>
        <Switch bind:checked={excludeLivePhotoVideos} />
        <HelperText>{$t('download_exclude_live_photo_videos_description')}</HelperText>
      </Field>
    {/if}

    {#if authManager.authenticated && !authManager.isSharedLink}
      <Field label={$t('download_remember_choice')}>
        <Switch bind:checked={remember} />
        <HelperText>{$t('download_remember_choice_description')}</HelperText>
      </Field>
    {/if}
  </Stack>
</FormModal>
