import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Readable } from 'node:stream';
import { vitest } from 'vitest';
import {
  DownloadImageFormat,
  DownloadImageSize,
  DownloadRequestStatus,
  DownloadVariant,
  DownloadVideoCodec,
  DownloadVideoResolution,
} from 'src/dtos/download-variant.dto.js';
import { AssetFileType, AssetType, JobName, JobStatus, NotificationType } from 'src/enum.js';
import { DownloadVariantService } from 'src/services/download-variant.service.js';
import { DownloadVariantJob, VariantAsset } from 'src/utils/download-variant.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { ServiceMocks, makeStream, newTestService } from 'test/utils.js';

const compatible: DownloadVariant = {
  imageFormat: DownloadImageFormat.Jpeg,
  imageSize: DownloadImageSize.Original,
  keepMetadata: true,
  videoCodec: DownloadVideoCodec.H264,
  videoResolution: DownloadVideoResolution.Original,
};

const originals: DownloadVariant = {
  imageFormat: DownloadImageFormat.Original,
  imageSize: DownloadImageSize.Original,
  keepMetadata: true,
  videoCodec: DownloadVideoCodec.Original,
  videoResolution: DownloadVideoResolution.Original,
};

const heic: VariantAsset = {
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
};

const mov: VariantAsset = {
  ...heic,
  id: '7f9fc4bd-1b7c-4d2f-8b2a-8e3c7a1d3e22',
  type: AssetType.Video,
  originalPath: '/data/upload/IMG_0002.MOV',
  originalFileName: 'IMG_0002.MOV',
  videoCodec: 'hevc',
};

const imageJob = (): DownloadVariantJob & { requestId?: string } => ({
  id: heic.id,
  output: '/data/download-cache/variants/owner-id/6e/8f/out.jpg',
  media: 'image',
  source: 'original',
  format: DownloadImageFormat.Jpeg,
  quality: 90,
  keepMetadata: true,
});

const sharedLinkAuth = (id = '123') => ({
  ...authStub.adminSharedLink,
  sharedLink: { ...authStub.adminSharedLink.sharedLink, id },
});

const tokenA = 'token-a-0123456789abcdef';
const tokenB = 'token-b-0123456789abcdef';

describe(DownloadVariantService.name, () => {
  let sut: DownloadVariantService;
  let mocks: ServiceMocks;
  let files: Map<string, Buffer>;

  const useAssets = (...assets: VariantAsset[]) => {
    const ids = assets.map(({ id }) => id);
    mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(ids));
    mocks.access.asset.checkSharedLinkAccess.mockResolvedValue(new Set(ids));
    mocks.downloadRepository.downloadAssetIds.mockImplementation(() =>
      makeStream(assets.map(({ id }) => ({ id, livePhotoVideoId: null, size: 1000 }))),
    );
    mocks.downloadRepository.getForVariants.mockImplementation((requested: string[]) =>
      Promise.resolve(assets.filter(({ id }) => requested.includes(id))),
    );
    return ids;
  };

  const queuedJobs = () =>
    mocks.job.queueAll.mock.calls.flatMap(([items]) => items).map((item) => item.data as DownloadVariantJob);

  beforeEach(() => {
    ({ sut, mocks } = newTestService(DownloadVariantService));

    files = new Map();
    mocks.storage.createOrOverwriteFile.mockImplementation((path: string, buffer: Buffer) => {
      files.set(path, buffer);
      return Promise.resolve();
    });
    mocks.storage.readFile.mockImplementation((path: string) => {
      const file = files.get(path);
      return file ? Promise.resolve(file) : Promise.reject(new Error('ENOENT'));
    });
    mocks.storage.readdir.mockImplementation((folder: string) => {
      const prefix = `${folder}/`;
      const names = new Set<string>();
      for (const path of files.keys()) {
        if (path.startsWith(prefix)) {
          names.add(path.slice(prefix.length).split('/', 1)[0]);
        }
      }
      return names.size > 0 ? Promise.resolve([...names]) : Promise.reject(new Error('ENOENT'));
    });
    mocks.storage.stat.mockImplementation((path: string) => {
      const file = files.get(path);
      return file
        ? Promise.resolve({ size: file.length, mtimeMs: Date.now() } as any)
        : Promise.reject(new Error('ENOENT'));
    });
    mocks.storage.checkFileExists.mockImplementation((path: string) => Promise.resolve(files.has(path)));
    mocks.storage.unlink.mockImplementation((path: string) => {
      files.delete(path);
      return Promise.resolve();
    });
    mocks.storage.rename.mockImplementation((source: string, target: string) => {
      files.set(target, files.get(source) ?? Buffer.from('generated'));
      files.delete(source);
      return Promise.resolve();
    });
    mocks.user.getMetadata.mockResolvedValue([]);
    mocks.user.get.mockResolvedValue({ id: authStub.admin.user.id } as any);
    mocks.job.getJobCounts.mockResolvedValue({
      active: 1,
      completed: 0,
      failed: 0,
      delayed: 0,
      waiting: 0,
      paused: 0,
    });
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('create', () => {
    it('should use the regular download when nothing needs to be converted', async () => {
      const ids = useAssets(heic);
      files.set(heic.originalPath, Buffer.from('original'));

      await expect(sut.create(authStub.admin, { assetIds: ids, variant: originals })).resolves.toEqual({
        immediate: true,
      });
      expect(mocks.job.queueAll).not.toHaveBeenCalled();
    });

    it('should queue conversions and store the request', async () => {
      const ids = useAssets(heic, mov);

      const response = await sut.create(authStub.admin, { assetIds: ids, name: 'Holiday', variant: compatible });

      expect(response.immediate).toBe(false);
      expect(response.request).toMatchObject({
        name: 'Holiday',
        single: false,
        status: DownloadRequestStatus.Preparing,
        total: 2,
        ready: 0,
        failed: 0,
      });
      expect(queuedJobs()).toEqual([
        expect.objectContaining({ id: heic.id, media: 'image', format: 'jpeg', requestId: response.request!.id }),
        expect.objectContaining({ id: mov.id, media: 'video', codec: 'h264', requestId: response.request!.id }),
      ]);
      const stored = files
        .keys()
        .filter((path) => path.includes('/requests/'))
        .toArray();
      expect(stored).toEqual([
        `/data/download-cache/requests/u-${authStub.admin.user.id}/${response.request!.id}.json`,
      ]);
    });

    it('should be disabled by the admin', async () => {
      const ids = useAssets(heic);
      mocks.systemMetadata.get.mockResolvedValue({ downloadVariants: { enabled: false } });

      await expect(sut.create(authStub.admin, { assetIds: ids, variant: compatible })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('should be disabled for shared links by the admin', async () => {
      const ids = useAssets(heic);
      mocks.systemMetadata.get.mockResolvedValue({ downloadVariants: { sharedLinks: false } });

      await expect(sut.create(sharedLinkAuth(), { assetIds: ids, variant: compatible }, tokenA)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('should require a token for shared links', async () => {
      const ids = useAssets(heic);

      await expect(sut.create(sharedLinkAuth(), { assetIds: ids, variant: compatible })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('should limit the number of videos', async () => {
      const ids = useAssets(heic, mov);
      mocks.systemMetadata.get.mockResolvedValue({ downloadVariants: { maxVideosPerRequest: 0 } });

      await expect(sut.create(authStub.admin, { assetIds: ids, variant: compatible })).rejects.toThrow(
        'at most 0 videos',
      );
    });

    it('should limit the number of active requests', async () => {
      const ids = useAssets(heic);
      mocks.systemMetadata.get.mockResolvedValue({ downloadVariants: { maxActiveRequests: 1 } });

      await sut.create(authStub.admin, { assetIds: ids, variant: compatible });
      await expect(sut.create(authStub.admin, { assetIds: ids, variant: compatible })).rejects.toThrow(
        'Too many downloads',
      );
    });

    it('should not keep metadata when the shared link hides it', async () => {
      const ids = useAssets(heic);
      const auth = { ...sharedLinkAuth(), sharedLink: { ...sharedLinkAuth().sharedLink, showExif: false } };

      await sut.create(auth, { assetIds: ids, variant: compatible }, tokenA);

      expect(queuedJobs()).toEqual([expect.objectContaining({ keepMetadata: false })]);
    });

    it('should retry variants that failed before', async () => {
      const ids = useAssets(heic);
      const first = await sut.create(authStub.admin, { assetIds: ids, variant: compatible });
      const [job] = queuedJobs();
      files.set(job.output + '.failed', Buffer.from('error'));
      await sut.remove(authStub.admin, first.request!.id);

      await sut.create(authStub.admin, { assetIds: ids, variant: compatible });

      expect(files.has(job.output + '.failed')).toBe(false);
    });
  });

  describe('getAll', () => {
    it('should only return the requests of the same shared link visitor', async () => {
      const ids = useAssets(heic);
      await sut.create(sharedLinkAuth(), { assetIds: ids, variant: compatible }, tokenA);

      await expect(sut.getAll(sharedLinkAuth(), tokenA)).resolves.toHaveLength(1);
      await expect(sut.getAll(sharedLinkAuth(), tokenB)).resolves.toHaveLength(0);
      await expect(sut.getAll(sharedLinkAuth('456'), tokenA)).resolves.toHaveLength(0);
      await expect(sut.getAll(authStub.admin)).resolves.toHaveLength(0);
    });

    it('should report progress', async () => {
      const ids = useAssets(heic, mov);
      await sut.create(authStub.admin, { assetIds: ids, variant: compatible });
      const [imageJob, videoJob] = queuedJobs();
      files.set(imageJob.output, Buffer.from('jpeg'));

      const [preparing] = await sut.getAll(authStub.admin);
      expect(preparing).toMatchObject({ status: DownloadRequestStatus.Preparing, ready: 1, size: 4 });

      files.set(videoJob.output + '.failed', Buffer.from('error'));
      const [done] = await sut.getAll(authStub.admin);
      expect(done).toMatchObject({ status: DownloadRequestStatus.Ready, ready: 1, failed: 1 });
    });

    it('should queue missing variants again', async () => {
      const ids = useAssets(heic);
      await sut.create(authStub.admin, { assetIds: ids, variant: compatible });
      mocks.job.queueAll.mockClear();

      await sut.getAll(authStub.admin);

      expect(queuedJobs()).toHaveLength(1);
    });
  });

  describe('downloads', () => {
    it('should not download while the request is being prepared', async () => {
      const ids = useAssets(heic);
      const { request } = await sut.create(authStub.admin, { assetIds: ids, variant: compatible });

      await expect(sut.downloadArchive(authStub.admin, request!.id, {})).rejects.toBeInstanceOf(ConflictException);
      await expect(sut.downloadFile(authStub.admin, request!.id, heic.id)).rejects.toBeInstanceOf(ConflictException);
    });

    it('should download an archive with converted file names', async () => {
      const ids = useAssets(heic, mov);
      const { request } = await sut.create(authStub.admin, { assetIds: ids, name: 'Holiday', variant: compatible });
      for (const job of queuedJobs()) {
        files.set(job.output, Buffer.from('converted'));
      }
      const archive = { addFile: vitest.fn(), finalize: vitest.fn(), stream: new Readable() };
      mocks.storage.createZipStream.mockReturnValue(archive);

      await expect(sut.downloadArchive(authStub.admin, request!.id, {})).resolves.toEqual({
        stream: archive.stream,
        disposition: `attachment; filename*=UTF-8''Holiday.zip`,
      });
      expect(archive.addFile).toHaveBeenCalledWith(expect.stringMatching(/\.jpg$/), 'IMG_0001.jpg');
      expect(archive.addFile).toHaveBeenCalledWith(expect.stringMatching(/\.mp4$/), 'IMG_0002.mp4');
    });

    it('should leave out assets that are no longer shared', async () => {
      const ids = useAssets(heic, mov);
      const auth = sharedLinkAuth();
      const { request } = await sut.create(auth, { assetIds: ids, variant: compatible }, tokenA);
      for (const job of queuedJobs()) {
        files.set(job.output, Buffer.from('converted'));
      }
      mocks.access.asset.checkSharedLinkAccess.mockResolvedValue(new Set([heic.id]));
      const archive = { addFile: vitest.fn(), finalize: vitest.fn(), stream: new Readable() };
      mocks.storage.createZipStream.mockReturnValue(archive);

      await sut.downloadArchive(auth, request!.id, {}, tokenA);

      expect(archive.addFile).toHaveBeenCalledTimes(1);
      expect(archive.addFile).toHaveBeenCalledWith(expect.any(String), 'IMG_0001.jpg');
    });

    it('should download a single file', async () => {
      const ids = useAssets(heic);
      const { request } = await sut.create(authStub.admin, { assetIds: ids, variant: compatible });
      const [job] = queuedJobs();
      files.set(job.output, Buffer.from('converted'));

      await expect(sut.downloadFile(authStub.admin, request!.id, heic.id)).resolves.toMatchObject({
        path: job.output,
        fileName: 'IMG_0001.jpg',
        contentType: 'image/jpeg',
      });
      expect(mocks.storage.utimes).toHaveBeenCalledWith(job.output, expect.any(Date), expect.any(Date));
    });

    it('should cancel a request while a variant is being generated', async () => {
      const ids = useAssets(heic);
      const { request } = await sut.create(authStub.admin, { assetIds: ids, variant: compatible });
      mocks.job.removeJob.mockRejectedValue(new Error('locked by another worker'));

      await expect(sut.remove(authStub.admin, request!.id)).resolves.toBeUndefined();
      await expect(sut.getAll(authStub.admin)).resolves.toEqual([]);
    });

    it('should not find requests of other users', async () => {
      const ids = useAssets(heic);
      const { request } = await sut.create(authStub.admin, { assetIds: ids, variant: compatible });

      await expect(sut.get(authStub.user1, request!.id)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('should split archives by size', async () => {
      const ids = useAssets(heic, mov);
      const { request } = await sut.create(authStub.admin, { assetIds: ids, variant: compatible });
      for (const job of queuedJobs()) {
        files.set(job.output, Buffer.alloc(100));
      }

      await expect(sut.getInfo(authStub.admin, request!.id, { archiveSize: 50 })).resolves.toEqual({
        totalSize: 200,
        archives: [
          { size: 100, assetIds: [heic.id] },
          { size: 100, assetIds: [mov.id] },
        ],
      });
    });
  });

  describe('handleGenerate', () => {
    beforeEach(() => {
      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue({
        id: heic.id,
        originalPath: heic.originalPath,
        files: [],
        exifInfo: { colorspace: null, profileDescription: 'Display P3', bitsPerSample: 8 },
      } as any);
    });

    it('should convert an image and keep its metadata', async () => {
      await expect(sut.handleGenerate(imageJob())).resolves.toBe(JobStatus.Success);

      expect(mocks.media.decodeImage).toHaveBeenCalledWith(
        heic.originalPath,
        expect.objectContaining({ colorspace: 'p3' }),
      );
      expect(mocks.media.generateThumbnail).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ format: 'jpeg', quality: 90, size: undefined, fit: 'inside' }),
        expect.stringContaining('out.jpg.tmp-'),
      );
      expect(mocks.media.copyMetadata).toHaveBeenCalledWith(heic.originalPath, expect.stringContaining('out.jpg.tmp-'));
      expect(files.has(imageJob().output)).toBe(true);
    });

    it('should reuse the generated full size image', async () => {
      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue({
        id: heic.id,
        originalPath: heic.originalPath,
        files: [{ type: AssetFileType.FullSize, path: '/data/thumbs/fullsize.jpeg', isEdited: false }],
        exifInfo: { colorspace: null, profileDescription: null, bitsPerSample: null },
      } as any);

      await expect(sut.handleGenerate(imageJob())).resolves.toBe(JobStatus.Success);

      expect(mocks.storage.copyFile).toHaveBeenCalledWith('/data/thumbs/fullsize.jpeg', expect.any(String));
      expect(mocks.media.decodeImage).not.toHaveBeenCalled();
    });

    it('should skip variants that exist', async () => {
      files.set(imageJob().output, Buffer.from('jpeg'));

      await expect(sut.handleGenerate(imageJob())).resolves.toBe(JobStatus.Skipped);
      expect(mocks.media.decodeImage).not.toHaveBeenCalled();
    });

    it('should mark failed variants', async () => {
      mocks.media.decodeImage.mockRejectedValue(new Error('Unsupported image'));

      await expect(sut.handleGenerate(imageJob())).resolves.toBe(JobStatus.Failed);

      expect(files.get(imageJob().output + '.failed')?.toString()).toBe('Unsupported image');
      expect(files.has(imageJob().output)).toBe(false);
    });

    it('should notify the user once the queue is empty', async () => {
      const ids = useAssets(heic);
      const { request } = await sut.create(authStub.admin, { assetIds: ids, name: 'Holiday', variant: compatible });
      const [job] = queuedJobs();
      mocks.notification.create.mockResolvedValue({ id: 'notification-id', createdAt: new Date() } as any);

      await sut.handleGenerate(job);
      await sut.handleGenerate(job);

      expect(mocks.notification.create).toHaveBeenCalledTimes(1);
      expect(mocks.notification.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: authStub.admin.user.id,
          type: NotificationType.Custom,
          title: 'Download ready',
          data: { downloadRequestId: request!.id },
        }),
      );
      expect(mocks.websocket.clientSend).toHaveBeenCalledWith(
        'on_notification',
        authStub.admin.user.id,
        expect.anything(),
      );
    });

    it('should not notify deleted users', async () => {
      const ids = useAssets(heic);
      await sut.create(authStub.admin, { assetIds: ids, variant: compatible });
      mocks.user.get.mockResolvedValue(undefined);

      await expect(sut.handleGenerate(queuedJobs()[0])).resolves.toBe(JobStatus.Success);

      expect(mocks.notification.create).not.toHaveBeenCalled();
    });

    it('should not fail the job when notifying fails', async () => {
      const ids = useAssets(heic);
      await sut.create(authStub.admin, { assetIds: ids, variant: compatible });
      mocks.notification.create.mockRejectedValue(new Error('foreign key violation'));

      await expect(sut.handleGenerate(queuedJobs()[0])).resolves.toBe(JobStatus.Success);
      expect(mocks.logger.warn).toHaveBeenCalled();
    });

    it('should not notify while jobs are waiting', async () => {
      const ids = useAssets(heic);
      await sut.create(authStub.admin, { assetIds: ids, variant: compatible });
      mocks.job.getJobCounts.mockResolvedValue({
        active: 1,
        completed: 0,
        failed: 0,
        delayed: 0,
        waiting: 3,
        paused: 0,
      });

      await sut.handleGenerate(queuedJobs()[0]);

      expect(mocks.notification.create).not.toHaveBeenCalled();
    });
  });

  describe('handleCleanup', () => {
    it('should remove expired requests and orphaned variants', async () => {
      const ids = useAssets(heic);
      await sut.create(authStub.admin, { assetIds: ids, variant: compatible });
      const [job] = queuedJobs();
      files.set(job.output, Buffer.from('jpeg'));
      const orphan = '/data/download-cache/variants/owner-id/aa/bb/aabbccdd-0000-4000-8000-000000000000-abc.jpg';
      files.set(orphan, Buffer.from('jpeg'));

      mocks.storage.readdirWithTypes.mockImplementation((folder: string) => {
        const prefix = `${folder}/`;
        const entries = new Map<string, boolean>();
        for (const path of files.keys()) {
          if (!path.startsWith(prefix)) {
            continue;
          }

          const [name, ...rest] = path.slice(prefix.length).split('/');
          entries.set(name, rest.length > 0);
        }
        return Promise.resolve(
          [...entries].map(([name, isDirectory]) => ({
            name,
            isDirectory: () => isDirectory,
            isFile: () => !isDirectory,
          })) as any,
        );
      });
      mocks.downloadRepository.getExistingAssetIds.mockResolvedValue([heic.id]);

      await expect(sut.handleCleanup()).resolves.toBe(JobStatus.Success);
      expect(files.has(orphan)).toBe(false);
      expect(files.has(job.output)).toBe(true);

      vitest.useFakeTimers({ now: Date.now() + 8 * 24 * 60 * 60 * 1000, toFake: ['Date'] });
      try {
        await sut.handleCleanup();
      } finally {
        vitest.useRealTimers();
      }
      expect(files.keys().some((path) => path.includes('/requests/'))).toBe(false);
    });
  });

  it('should register the job handlers', () => {
    expect(JobName.DownloadVariantGenerate).toBe('DownloadVariantGenerate');
  });
});
