import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, extname, join } from 'node:path';
import type { JobOf, VideoInterfaces } from 'src/types.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import {
  DownloadRequestArchiveDto,
  DownloadRequestCreateDto,
  DownloadRequestCreateResponseDto,
  DownloadRequestDto,
  DownloadRequestInfoDto,
  DownloadRequestStatus,
  DownloadVariant,
} from 'src/dtos/download-variant.dto.js';
import { DownloadResponseDto } from 'src/dtos/download.dto.js';
import { mapNotification } from 'src/dtos/notification.dto.js';
import {
  AssetFileType,
  CacheControl,
  Colorspace,
  ImageFormat,
  ImmichWorker,
  JobName,
  JobStatus,
  NotificationLevel,
  NotificationType,
  Permission,
  QueueName,
  TranscodeHardwareAcceleration,
  TranscodeTarget,
} from 'src/enum.js';
import { ImmichReadStream } from 'src/repositories/storage.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { getAssetFile } from 'src/utils/asset.util.js';
import { HumanReadableSize } from 'src/utils/bytes.js';
import {
  DOWNLOAD_FAILED_SUFFIX,
  DownloadVariantJob,
  ResolvedVariant,
  VariantAsset,
  getAssetIdFromVariantPath,
  getDownloadRequestFolder,
  getDownloadVariantFolder,
  getDownloadVariantJobId,
  resolveVariant,
  uniqueFileNames,
} from 'src/utils/download-variant.js';
import { ImmichFileResponse } from 'src/utils/file.js';
import { BaseConfig } from 'src/utils/media.js';
import { mimeTypes } from 'src/utils/mime-types.js';
import { getPreferences } from 'src/utils/preferences.js';

/** A download request as it is stored on disk */
type StoredRequest = {
  id: string;
  ownerKey: string;
  /** the user the request was made as, for shared links this is the owner of the link */
  userId: string;
  sharedLinkId?: string;
  name: string;
  single?: boolean;
  variant: DownloadVariant;
  keepMetadata: boolean;
  assetIds: string[];
  createdAt: string;
  expiresAt: string;
  notifiedAt?: string;
};

type ItemState = { resolved: ResolvedVariant; state: 'ready' | 'pending' | 'failed'; size: number };

const TEMP_INFIX = '.tmp-';
const STALE_TEMP_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class DownloadVariantService extends BaseService {
  private videoInterfaces: VideoInterfaces = { dri: [], mali: false };

  @OnEvent({ name: 'AppBootstrap', workers: [ImmichWorker.Microservices] })
  async onBootstrap() {
    this.videoInterfaces = await this.storageCore.getVideoInterfaces();
  }

  async create(
    auth: AuthDto,
    dto: DownloadRequestCreateDto,
    token?: string,
  ): Promise<DownloadRequestCreateResponseDto> {
    const { downloadVariants: config } = await this.getConfig({ withCache: true });
    if (!config.enabled || (auth.sharedLink && !config.sharedLinks)) {
      throw new BadRequestException('Converted downloads are disabled');
    }

    const ownerKey = this.getOwnerKey(auth, token);
    const assetIds = await this.getAssetIds(auth, dto);
    if (assetIds.length === 0) {
      throw new BadRequestException('Nothing to download');
    }
    if (assetIds.length > config.maxAssetsPerRequest) {
      throw new BadRequestException(`A download may contain at most ${config.maxAssetsPerRequest} files`);
    }

    const keepMetadata = dto.variant.keepMetadata && (!auth.sharedLink || auth.sharedLink.showExif);
    const items = await this.resolve(assetIds, dto.variant, keepMetadata);
    const generate = items.filter((item) => item.kind === 'generate');
    if (generate.length === 0) {
      return { immediate: true };
    }

    const videos = generate.filter((item) => item.job.media === 'video').length;
    if (videos > config.maxVideosPerRequest) {
      throw new BadRequestException(`A download may convert at most ${config.maxVideosPerRequest} videos`);
    }

    const active = await this.readRequests(ownerKey);
    if (active.length >= config.maxActiveRequests) {
      throw new BadRequestException('Too many downloads are being prepared, remove one first');
    }

    const now = new Date();
    const request: StoredRequest = {
      id: randomUUID(),
      ownerKey,
      userId: auth.user.id,
      sharedLinkId: auth.sharedLink?.id,
      name: dto.name || 'immich',
      single: dto.single,
      variant: dto.variant,
      keepMetadata,
      assetIds,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + config.cacheDays * 24 * 60 * 60 * 1000).toISOString(),
    };
    await this.writeRequest(request);

    // creating a request retries variants that failed before
    for (const item of generate) {
      const failedMarker = item.path + DOWNLOAD_FAILED_SUFFIX;
      if (await this.storageRepository.checkFileExists(failedMarker)) {
        await this.storageRepository.unlink(failedMarker);
      }
    }
    await this.queueMissing(request, generate);

    return { immediate: false, request: await this.toResponse(request) };
  }

  async getAll(auth: AuthDto, token?: string): Promise<DownloadRequestDto[]> {
    const requests = await this.readRequests(this.getOwnerKey(auth, token));
    const results: DownloadRequestDto[] = [];
    for (const request of requests) {
      const items = await this.getItemStates(request);
      // repair requests whose jobs were lost, e.g. after the queue was cleared
      await this.queueMissing(
        request,
        items.filter((item) => item.state === 'pending').map((item) => item.resolved),
      );
      results.push(this.toResponseFromItems(request, items));
    }
    return results;
  }

  async get(auth: AuthDto, id: string, token?: string): Promise<DownloadRequestDto> {
    const request = await this.findRequest(auth, id, token);
    return this.toResponse(request);
  }

  async remove(auth: AuthDto, id: string, token?: string): Promise<void> {
    const request = await this.findRequest(auth, id, token);
    const items = await this.getItemStates(request);
    for (const { resolved, state } of items) {
      if (resolved.kind === 'generate' && state === 'pending') {
        try {
          await this.jobRepository.removeJob(JobName.DownloadVariantGenerate, getDownloadVariantJobId(resolved.path));
        } catch (error: any) {
          // jobs that are already running can't be removed, they just finish
          this.logger.debug(`Unable to remove job for ${resolved.path}: ${error?.message ?? error}`);
        }
      }
    }
    await this.storageRepository.unlink(this.getRequestPath(request.ownerKey, request.id));
  }

  async getInfo(auth: AuthDto, id: string, dto: DownloadRequestInfoDto, token?: string): Promise<DownloadResponseDto> {
    const request = await this.findRequest(auth, id, token);
    const items = await this.getReadyItems(auth, request);
    const targetSize = dto.archiveSize || HumanReadableSize.GiB * 4;

    const archives: DownloadResponseDto['archives'] = [];
    let archive: DownloadResponseDto['archives'][number] = { size: 0, assetIds: [] };
    for (const item of items) {
      archive.assetIds.push(item.resolved.assetId);
      archive.size += item.size;
      if (!(archive.size > targetSize)) {
        continue;
      }

      archives.push(archive);
      archive = { size: 0, assetIds: [] };
    }
    if (archive.assetIds.length > 0) {
      archives.push(archive);
    }

    return { totalSize: archives.reduce((total, { size }) => total + size, 0), archives };
  }

  async downloadArchive(
    auth: AuthDto,
    id: string,
    dto: DownloadRequestArchiveDto,
    token?: string,
  ): Promise<ImmichReadStream> {
    const request = await this.findRequest(auth, id, token);
    let items = await this.getReadyItems(auth, request);
    if (dto.assetIds) {
      const subset = new Set(dto.assetIds);
      items = items.filter((item) => subset.has(item.resolved.assetId));
    }

    const zip = this.storageRepository.createZipStream();
    const getFileName = uniqueFileNames();
    for (const { resolved } of items) {
      let path = resolved.path;
      try {
        path = await this.storageRepository.realpath(path);
      } catch {
        this.logger.warn(`Unable to resolve realpath for ${path}`);
      }
      zip.addFile(path, getFileName(resolved.fileName));
      await this.touch(resolved);
    }
    void zip.finalize();

    const archiveName = dto.archiveName || request.name;
    return {
      stream: zip.stream,
      disposition: `attachment; filename*=UTF-8''${encodeURIComponent(archiveName)}.zip`,
    };
  }

  async downloadFile(auth: AuthDto, id: string, assetId: string, token?: string): Promise<ImmichFileResponse> {
    const request = await this.findRequest(auth, id, token);
    if (!request.assetIds.includes(assetId)) {
      throw new NotFoundException('Asset is not part of this download');
    }

    const [item] = await this.getReadyItems(auth, { ...request, assetIds: [assetId] });
    if (!item) {
      throw new NotFoundException('Asset not found');
    }
    await this.touch(item.resolved);

    return new ImmichFileResponse({
      path: item.resolved.path,
      fileName: item.resolved.fileName,
      contentType: mimeTypes.lookup(item.resolved.path),
      cacheControl: CacheControl.PrivateWithCache,
    });
  }

  @OnJob({ name: JobName.DownloadVariantGenerate, queue: QueueName.DownloadVariant })
  async handleGenerate(job: JobOf<JobName.DownloadVariantGenerate>): Promise<JobStatus> {
    const { output } = job;
    if (await this.storageRepository.checkFileExists(output)) {
      await this.notifyFinishedRequests();
      return JobStatus.Skipped;
    }

    this.storageRepository.mkdirSync(dirname(output));
    const temporary = `${output}${TEMP_INFIX}${randomUUID()}${extname(output)}`;
    let status = JobStatus.Success;
    try {
      await (job.media === 'image' ? this.generateImage(job, temporary) : this.generateVideo(job, temporary));
      await this.storageRepository.rename(temporary, output);
      this.logger.log(`Generated download variant ${output}`);
    } catch (error: any) {
      status = JobStatus.Failed;
      const message = error?.message ?? String(error);
      this.logger.error(`Unable to generate download variant for asset ${job.id}: ${message}`);
      await this.storageRepository.unlink(temporary).catch(() => {});
      await this.storageRepository.createOrOverwriteFile(output + DOWNLOAD_FAILED_SUFFIX, Buffer.from(message));
    }

    await this.notifyFinishedRequests();
    return status;
  }

  @OnJob({ name: JobName.DownloadCacheCleanup, queue: QueueName.BackgroundTask })
  async handleCleanup(): Promise<JobStatus> {
    const { downloadVariants: config } = await this.getConfig({ withCache: false });
    const now = Date.now();

    // requests
    const protectedPaths = new Set<string>();
    for (const request of await this.readAllRequests()) {
      const isExpired = new Date(request.expiresAt).getTime() < now;
      const isOrphaned = request.sharedLinkId
        ? !(await this.isSharedLinkValid(request))
        : !(await this.userRepository.get(request.userId, {}));
      if (isExpired || isOrphaned) {
        await this.storageRepository.unlink(this.getRequestPath(request.ownerKey, request.id));
        continue;
      }
      const items = await this.resolve(request.assetIds, request.variant, request.keepMetadata);
      for (const item of items) {
        if (item.kind === 'generate') {
          protectedPaths.add(item.path);
        }
      }
    }

    // variants
    const files = await this.listFiles(getDownloadVariantFolder());
    const assetIds = [...new Set(files.map(({ path }) => getAssetIdFromVariantPath(path)).filter(Boolean))] as string[];
    const existing = new Set<string>();
    for (let index = 0; index < assetIds.length; index += 1000) {
      for (const id of await this.downloadRepository.getExistingAssetIds(assetIds.slice(index, index + 1000))) {
        existing.add(id);
      }
    }

    const maxAge = config.cacheDays * 24 * 60 * 60 * 1000;
    const remaining: typeof files = [];
    let deleted = 0;
    for (const file of files) {
      const assetId = getAssetIdFromVariantPath(file.path);
      const isTemporary = file.path.includes(TEMP_INFIX) && now - file.mtime > STALE_TEMP_MS;
      const isFailedMarker = file.path.endsWith(DOWNLOAD_FAILED_SUFFIX) && now - file.mtime > STALE_TEMP_MS;
      const isOrphaned = !assetId || !existing.has(assetId);
      const isExpired = now - file.mtime > maxAge && !protectedPaths.has(file.path);
      if (isTemporary || isFailedMarker || isOrphaned || isExpired) {
        await this.storageRepository.unlink(file.path);
        deleted++;
      } else {
        remaining.push(file);
      }
    }

    // enforce the size limit, least recently used first
    const maxSize = config.cacheSizeGb * HumanReadableSize.GiB;
    let totalSize = remaining.reduce((total, { size }) => total + size, 0);
    for (const file of remaining.toSorted((a, b) => a.mtime - b.mtime)) {
      if (totalSize <= maxSize) {
        break;
      }
      if (protectedPaths.has(file.path)) {
        continue;
      }
      await this.storageRepository.unlink(file.path);
      totalSize -= file.size;
      deleted++;
    }

    await this.storageRepository.removeEmptyDirs(getDownloadVariantFolder());
    this.logger.log(`Download cache cleanup removed ${deleted} files`);
    return JobStatus.Success;
  }

  private getOwnerKey(auth: AuthDto, token?: string) {
    if (!auth.sharedLink) {
      return `u-${auth.user.id}`;
    }
    if (!token) {
      throw new BadRequestException('A download token is required for shared links');
    }
    const tokenHash = createHash('sha256').update(token).digest('hex').slice(0, 32);
    return `l-${auth.sharedLink.id}-${tokenHash}`;
  }

  private async getAssetIds(auth: AuthDto, dto: DownloadRequestCreateDto) {
    let assets;
    if (dto.assetIds) {
      await this.requireAccess({ auth, permission: Permission.AssetDownload, ids: dto.assetIds });
      assets = this.downloadRepository.downloadAssetIds(dto.assetIds);
    } else if (dto.albumId) {
      await this.requireAccess({ auth, permission: Permission.AlbumDownload, ids: [dto.albumId] });
      assets = this.downloadRepository.downloadAlbumId(dto.albumId);
    } else if (dto.userId) {
      await this.requireAccess({ auth, permission: Permission.TimelineDownload, ids: [dto.userId] });
      assets = this.downloadRepository.downloadUserId(dto.userId);
    } else {
      throw new BadRequestException('assetIds, albumId, or userId is required');
    }

    const ids: string[] = [];
    const motionIds: string[] = [];
    for await (const asset of assets) {
      ids.push(asset.id);
      if (asset.livePhotoVideoId && !dto.excludeLivePhotoVideos) {
        motionIds.push(asset.livePhotoVideoId);
      }
    }

    if (motionIds.length > 0) {
      const preferences = getPreferences(await this.userRepository.getMetadata(auth.user.id));
      for await (const motion of this.downloadRepository.downloadMotionAssetIds(motionIds)) {
        if (StorageCore.isAndroidMotionPath(motion.originalPath) && !preferences.download.includeEmbeddedVideos) {
          continue;
        }
        ids.push(motion.id);
      }
    }

    return [...new Set(ids)];
  }

  private async resolve(assetIds: string[], variant: DownloadVariant, keepMetadata: boolean) {
    const { downloadVariants: config } = await this.getConfig({ withCache: true });
    const assets: VariantAsset[] = [];
    for (let index = 0; index < assetIds.length; index += 1000) {
      assets.push(...(await this.downloadRepository.getForVariants(assetIds.slice(index, index + 1000))));
    }

    const assetMap = new Map(assets.map((asset) => [asset.id, asset]));
    const results: ResolvedVariant[] = [];
    for (const id of assetIds) {
      const asset = assetMap.get(id);
      if (asset) {
        results.push(resolveVariant(asset, variant, { edited: true, keepMetadata, imageQuality: config.imageQuality }));
      }
    }
    return results;
  }

  private async getItemStates(request: StoredRequest): Promise<ItemState[]> {
    const items = await this.resolve(request.assetIds, request.variant, request.keepMetadata);
    return Promise.all(
      items.map(async (resolved): Promise<ItemState> => {
        try {
          const { size } = await this.storageRepository.stat(resolved.path);
          return { resolved, state: 'ready', size };
        } catch {
          if (resolved.kind === 'passthrough') {
            return { resolved, state: 'failed', size: 0 };
          }
          const failed = await this.storageRepository.checkFileExists(resolved.path + DOWNLOAD_FAILED_SUFFIX);
          return { resolved, state: failed ? 'failed' : 'pending', size: 0 };
        }
      }),
    );
  }

  /** Returns the files that are ready, after checking access again, or throws when the request is not ready */
  private async getReadyItems(auth: AuthDto, request: StoredRequest) {
    const allowed = await this.checkAccess({
      auth,
      permission: Permission.AssetDownload,
      ids: request.assetIds,
    });
    const items = await this.getItemStates({ ...request, assetIds: request.assetIds.filter((id) => allowed.has(id)) });
    if (items.some((item) => item.state === 'pending')) {
      throw new ConflictException('The download is still being prepared');
    }
    return items.filter((item) => item.state === 'ready');
  }

  private async queueMissing(request: StoredRequest, items: ResolvedVariant[]) {
    const jobs = items
      .filter((item): item is Extract<ResolvedVariant, { kind: 'generate' }> => item.kind === 'generate')
      .map((item) => ({
        name: JobName.DownloadVariantGenerate as const,
        data: { ...item.job, requestId: request.id },
      }));
    await this.jobRepository.queueAll(jobs);
  }

  private async toResponse(request: StoredRequest): Promise<DownloadRequestDto> {
    return this.toResponseFromItems(request, await this.getItemStates(request));
  }

  private toResponseFromItems(request: StoredRequest, items: ItemState[]): DownloadRequestDto {
    const ready = items.filter((item) => item.state === 'ready');
    const failed = items.filter((item) => item.state === 'failed').length;
    const isPreparing = items.some((item) => item.state === 'pending');
    let status = DownloadRequestStatus.Ready;
    if (isPreparing) {
      status = DownloadRequestStatus.Preparing;
    } else if (ready.length === 0) {
      status = DownloadRequestStatus.Failed;
    }

    return {
      id: request.id,
      name: request.name,
      single: request.single ?? false,
      variant: request.variant,
      status,
      total: items.length,
      ready: ready.length,
      failed,
      size: ready.reduce((total, item) => total + item.size, 0),
      createdAt: new Date(request.createdAt),
      expiresAt: new Date(request.expiresAt),
    };
  }

  private async notifyFinishedRequests() {
    try {
      await this.onVariantDone();
    } catch (error: any) {
      this.logger.warn(`Unable to notify about finished downloads: ${error?.message ?? error}`);
    }
  }

  /** Notifies users about their requests once the queue has run dry */
  private async onVariantDone() {
    const counts = await this.jobRepository.getJobCounts(QueueName.DownloadVariant);
    if (counts.waiting + counts.delayed > 0) {
      return;
    }

    for (const request of await this.readAllRequests()) {
      if (request.notifiedAt || request.sharedLinkId) {
        continue;
      }
      const response = await this.toResponse(request);
      if (response.status === DownloadRequestStatus.Preparing) {
        continue;
      }

      request.notifiedAt = new Date().toISOString();
      await this.writeRequest(request);

      if (!(await this.userRepository.get(request.userId, {}))) {
        continue;
      }

      const isReady = response.status === DownloadRequestStatus.Ready;
      const notification = await this.notificationRepository.create({
        userId: request.userId,
        type: NotificationType.Custom,
        level: isReady ? NotificationLevel.Success : NotificationLevel.Error,
        title: isReady ? 'Download ready' : 'Download failed',
        description: isReady
          ? `"${request.name}" is ready to download${response.failed > 0 ? `, ${response.failed} files could not be converted` : ''}`
          : `"${request.name}" could not be converted`,
        data: { downloadRequestId: request.id },
      });
      this.websocketRepository.clientSend('on_notification', request.userId, mapNotification(notification));
    }
  }

  private async generateImage(job: Extract<DownloadVariantJob, { media: 'image' }>, output: string) {
    const asset = await this.assetJobRepository.getForGenerateThumbnailJob(job.id);
    if (!asset) {
      throw new Error('Asset not found');
    }

    let source = asset.originalPath;
    if (job.source === 'edited') {
      const editedFile = getAssetFile(asset.files, AssetFileType.FullSize, { isEdited: true });
      if (!editedFile) {
        throw new Error('Edited image not found');
      }
      source = editedFile.path;
    }

    // the generated full size image is already what we want, unless it would need resizing
    const fullsize = getAssetFile(asset.files, AssetFileType.FullSize, { isEdited: false });
    const fullsizeFormat = fullsize ? extname(fullsize.path).slice(1).replace('jpg', 'jpeg') : undefined;
    if (job.source === 'original' && job.size === undefined && fullsize && fullsizeFormat === job.format) {
      await this.storageRepository.copyFile(fullsize.path, output);
    } else {
      const { image } = await this.getConfig({ withCache: true });
      const colorspace = this.isSRGB(asset.exifInfo) ? Colorspace.Srgb : image.colorspace;
      const bitmap = await this.mediaRepository.decodeImage(source, {
        colorspace,
        processInvalidImages: process.env.IMMICH_PROCESS_INVALID_IMAGES === 'true',
      });
      await this.mediaRepository.generateThumbnail(
        bitmap,
        {
          format: job.format as unknown as ImageFormat,
          quality: job.quality,
          progressive: false,
          colorspace,
          processInvalidImages: process.env.IMMICH_PROCESS_INVALID_IMAGES === 'true',
          size: job.size,
          fit: 'inside',
        },
        output,
      );
    }

    if (job.keepMetadata) {
      await this.mediaRepository.copyMetadata(asset.originalPath, output);
    }
  }

  private async generateVideo(job: Extract<DownloadVariantJob, { media: 'video' }>, output: string) {
    const asset = await this.assetJobRepository.getForVideoConversion(job.id);
    if (!asset) {
      throw new Error('Asset not found');
    }

    const { videoStream, format } = asset;
    const audioStream = asset.audioStream ?? undefined;
    if (!videoStream?.height || !videoStream.width || !format) {
      throw new Error('Missing video metadata, re-run metadata extraction first');
    }

    const sourceShortEdge = Math.min(videoStream.width, videoStream.height);
    const targetShortEdge = Math.min(job.resolution ?? sourceShortEdge, sourceShortEdge);

    // reuse the transcoded playback video if it matches, it has no metadata though
    const encoded = getAssetFile(asset.files, AssetFileType.EncodedVideo, { isEdited: false });
    if (encoded && !job.keepMetadata) {
      try {
        const probed = await this.mediaRepository.probe(encoded.path);
        const [stream] = probed.videoStreams;
        const shortEdge = stream ? Math.min(stream.width, stream.height) : 0;
        if (stream?.codecName === job.codec && Math.abs(shortEdge - targetShortEdge) <= 1) {
          await this.storageRepository.copyFile(encoded.path, output);
          return;
        }
      } catch (error: any) {
        this.logger.warn(`Unable to probe encoded video ${encoded.path}: ${error?.message ?? error}`);
      }
    }

    const { ffmpeg: baseConfig } = await this.getConfig({ withCache: true });
    let ffmpeg = {
      ...baseConfig,
      targetVideoCodec: job.codec,
      acceptedVideoCodecs: [job.codec],
      targetResolution: job.resolution ? String(job.resolution) : 'original',
      twoPass: false,
    };

    const transcode = () => {
      const command = BaseConfig.create(ffmpeg, this.videoInterfaces).getCommand(
        TranscodeTarget.All,
        videoStream,
        audioStream,
      );
      if (job.keepMetadata) {
        const index = command.outputOptions.indexOf('-map_metadata');
        if (index !== -1) {
          command.outputOptions[index + 1] = '0';
        }
        const flags = command.outputOptions.indexOf('faststart');
        if (flags !== -1) {
          command.outputOptions[flags] = 'faststart+use_metadata_tags';
        }
      }
      return this.mediaRepository.transcode(asset.originalPath, output, command);
    };

    try {
      await transcode();
    } catch (error: any) {
      if (ffmpeg.accel === TranscodeHardwareAcceleration.Disabled) {
        throw error;
      }
      this.logger.error(`Error while transcoding, retrying without hardware acceleration: ${error?.message}`);
      ffmpeg = { ...ffmpeg, accel: TranscodeHardwareAcceleration.Disabled };
      await transcode();
    }
  }

  private isSRGB({
    colorspace,
    profileDescription,
    bitsPerSample,
  }: {
    colorspace: string | null;
    profileDescription: string | null;
    bitsPerSample: number | null;
  }) {
    if (colorspace || profileDescription) {
      return [colorspace, profileDescription].some((value) => value?.toLowerCase().includes('srgb'));
    }
    return bitsPerSample ? bitsPerSample === 8 : true;
  }

  private async touch(resolved: ResolvedVariant) {
    if (resolved.kind !== 'generate') {
      return;
    }

    const now = new Date();
    try {
      await this.storageRepository.utimes(resolved.path, now, now);
    } catch (error: any) {
      this.logger.debug(`Unable to update access time of ${resolved.path}: ${error?.message ?? error}`);
    }
  }

  private async isSharedLinkValid(request: StoredRequest) {
    const sharedLink = await this.sharedLinkRepository.get(request.userId, request.sharedLinkId!);
    return !!sharedLink && (!sharedLink.expiresAt || sharedLink.expiresAt.getTime() > Date.now());
  }

  private getRequestPath(ownerKey: string, id: string) {
    return join(getDownloadRequestFolder(), ownerKey, `${id}.json`);
  }

  private async findRequest(auth: AuthDto, id: string, token?: string) {
    const ownerKey = this.getOwnerKey(auth, token);
    const request = await this.readRequest(this.getRequestPath(ownerKey, id));
    if (!request || request.ownerKey !== ownerKey) {
      throw new NotFoundException('Download not found');
    }
    if (new Date(request.expiresAt).getTime() < Date.now()) {
      throw new NotFoundException('Download expired');
    }
    return request;
  }

  private async writeRequest(request: StoredRequest) {
    const path = this.getRequestPath(request.ownerKey, request.id);
    this.storageRepository.mkdirSync(dirname(path));
    // write atomically, the API reads requests while the worker updates them
    const temporary = `${path}${TEMP_INFIX}${randomUUID()}`;
    await this.storageRepository.createOrOverwriteFile(temporary, Buffer.from(JSON.stringify(request)));
    await this.storageRepository.rename(temporary, path);
  }

  private async readRequest(path: string): Promise<StoredRequest | null> {
    try {
      const buffer = await this.storageRepository.readFile(path);
      return JSON.parse(buffer.toString()) as StoredRequest;
    } catch {
      return null;
    }
  }

  private async readRequests(ownerKey: string) {
    const folder = join(getDownloadRequestFolder(), ownerKey);
    const requests: StoredRequest[] = [];
    for (const name of await this.storageRepository.readdir(folder).catch(() => [] as string[])) {
      if (!name.endsWith('.json')) {
        continue;
      }
      const request = await this.readRequest(join(folder, name));
      if (request && new Date(request.expiresAt).getTime() >= Date.now()) {
        requests.push(request);
      }
    }
    return requests.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private async readAllRequests() {
    const folder = getDownloadRequestFolder();
    const requests: StoredRequest[] = [];
    for (const ownerKey of await this.storageRepository.readdir(folder).catch(() => [] as string[])) {
      for (const name of await this.storageRepository.readdir(join(folder, ownerKey)).catch(() => [] as string[])) {
        if (!name.endsWith('.json')) {
          continue;
        }
        const request = await this.readRequest(join(folder, ownerKey, name));
        if (request) {
          requests.push(request);
        }
      }
    }
    return requests;
  }

  private async listFiles(folder: string) {
    const results: { path: string; size: number; mtime: number }[] = [];
    const walk = async (current: string) => {
      const entries = await this.storageRepository.readdirWithTypes(current).catch(() => []);
      for (const entry of entries) {
        const path = join(current, entry.name);
        if (entry.isDirectory()) {
          await walk(path);
        } else if (entry.isFile()) {
          const stats = await this.storageRepository.stat(path);
          results.push({ path, size: stats.size, mtime: stats.mtimeMs });
        }
      }
    };
    await walk(folder);
    return results;
  }
}
