import { AssetMediaResponseDto, LoginResponseDto, SharedLinkResponseDto, SharedLinkType } from '@immich/sdk';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, tempDir, testAssetDir, utils } from 'src/utils';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

const compatible = {
  imageFormat: 'jpeg',
  imageSize: 'original',
  keepMetadata: true,
  videoCodec: 'h264',
  videoResolution: 'original',
};

const originals = {
  imageFormat: 'original',
  imageSize: 'original',
  keepMetadata: true,
  videoCodec: 'original',
  videoResolution: 'original',
};

const isJpeg = (bytes: Buffer) => bytes[0] === 0xff && bytes[1] === 0xd8;
const hasExif = (bytes: Buffer) => bytes.includes(Buffer.from('Exif\0\0'));

describe('/download/requests', () => {
  let admin: LoginResponseDto;
  let heic: AssetMediaResponseDto;
  let png: AssetMediaResponseDto;
  let sharedLink: SharedLinkResponseDto;
  let hiddenExifLink: SharedLinkResponseDto;
  let noDownloadLink: SharedLinkResponseDto;

  const tokenA = 'visitor-a-0123456789abcdef';
  const tokenB = 'visitor-b-0123456789abcdef';

  const waitUntilReady = async (id: string, query: Record<string, string>, auth?: string) => {
    await utils.waitForQueueFinish(admin.accessToken, 'downloadVariant', 60_000);
    const builder = request(app).get(`/download/requests/${id}`).query(query);
    const { status, body } = await (auth ? builder.set('Authorization', `Bearer ${auth}`) : builder);
    expect(status).toBe(200);
    return body;
  };

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup();

    heic = await utils.createAsset(admin.accessToken, {
      assetData: {
        filename: 'IMG_2682.heic',
        bytes: await readFile(join(testAssetDir, 'formats/heic/IMG_2682.heic')),
      },
    });
    png = await utils.createAsset(admin.accessToken);
    await utils.waitForQueueFinish(admin.accessToken, 'metadataExtraction');

    [sharedLink, hiddenExifLink, noDownloadLink] = await Promise.all([
      utils.createSharedLink(admin.accessToken, {
        type: SharedLinkType.Individual,
        assetIds: [heic.id, png.id],
        allowDownload: true,
        showMetadata: true,
      }),
      utils.createSharedLink(admin.accessToken, {
        type: SharedLinkType.Individual,
        assetIds: [heic.id],
        allowDownload: true,
        showMetadata: false,
      }),
      utils.createSharedLink(admin.accessToken, {
        type: SharedLinkType.Individual,
        assetIds: [heic.id],
        allowDownload: false,
      }),
    ]);

    // hiding metadata disables downloads on creation, but they can be enabled again
    const { status } = await request(app)
      .patch(`/shared-links/${hiddenExifLink.id}`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ allowDownload: true });
    expect(status).toBe(200);
  });

  it('should use the regular download for original files', async () => {
    const { status, body } = await request(app)
      .post('/download/requests')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ assetIds: [heic.id], variant: originals });

    expect(status).toBe(201);
    expect(body).toEqual({ immediate: true });
  });

  it('should convert HEIC to JPEG for a shared link visitor', async () => {
    const query = { key: sharedLink.key, downloadToken: tokenA };
    const { status, body } = await request(app)
      .post('/download/requests')
      .query(query)
      .send({ assetIds: [heic.id, png.id], name: 'Holiday', variant: compatible });

    expect(status).toBe(201);
    expect(body).toEqual({
      immediate: false,
      request: expect.objectContaining({ name: 'Holiday', status: 'preparing', total: 2, single: false }),
    });

    const ready = await waitUntilReady(body.request.id, query);
    expect(ready).toEqual(expect.objectContaining({ status: 'ready', ready: 2, failed: 0 }));

    const archive = await request(app)
      .post(`/download/requests/${body.request.id}/archive`)
      .query(query)
      .type('form')
      .send({});
    expect(archive.status).toBe(200);
    await writeFile(`${tempDir}/converted.zip`, archive.body);
    await utils.unzip(`${tempDir}/converted.zip`, `${tempDir}/converted`);

    const jpeg = await readFile(`${tempDir}/converted/IMG_2682.jpg`);
    expect(isJpeg(jpeg)).toBe(true);
    expect(hasExif(jpeg)).toBe(true);
    // png is converted to jpeg as well
    expect(isJpeg(await readFile(`${tempDir}/converted/example.jpg`))).toBe(true);
  });

  it('should download a single converted file', async () => {
    const query = { key: sharedLink.key, downloadToken: tokenA };
    const { body } = await request(app)
      .post('/download/requests')
      .query(query)
      .send({ assetIds: [heic.id], single: true, variant: { ...compatible, imageSize: '1920' } });

    await waitUntilReady(body.request.id, query);
    const file = await request(app).get(`/download/requests/${body.request.id}/assets/${heic.id}`).query(query);

    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('image/jpeg');
    expect(file.headers['content-disposition']).toContain('IMG_2682.jpg');
  });

  it('should not keep metadata when the shared link hides it', async () => {
    const query = { key: hiddenExifLink.key, downloadToken: tokenA };
    const { body } = await request(app)
      .post('/download/requests')
      .query(query)
      .send({ assetIds: [heic.id], single: true, variant: compatible });

    await waitUntilReady(body.request.id, query);
    const file = await request(app)
      .get(`/download/requests/${body.request.id}/assets/${heic.id}`)
      .query(query)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    expect(isJpeg(file.body)).toBe(true);
    expect(hasExif(file.body)).toBe(false);
  });

  it('should keep requests of shared link visitors apart', async () => {
    const { body: visitorA } = await request(app)
      .get('/download/requests')
      .query({ key: sharedLink.key, downloadToken: tokenA });
    const { body: visitorB } = await request(app)
      .get('/download/requests')
      .query({ key: sharedLink.key, downloadToken: tokenB });

    expect(visitorA.length).toBeGreaterThan(0);
    expect(visitorB).toEqual([]);

    const { status } = await request(app)
      .get(`/download/requests/${visitorA[0].id}`)
      .query({ key: sharedLink.key, downloadToken: tokenB });
    expect(status).toBe(404);
  });

  it('should require a token for shared links', async () => {
    const { status } = await request(app)
      .post('/download/requests')
      .query({ key: sharedLink.key })
      .send({ assetIds: [heic.id], variant: compatible });

    expect(status).toBe(400);
  });

  it('should not allow downloads from links without download permission', async () => {
    const { status } = await request(app)
      .post('/download/requests')
      .query({ key: noDownloadLink.key, downloadToken: tokenA })
      .send({ assetIds: [heic.id], variant: compatible });

    expect(status).toBe(400);
  });

  it('should list the requests of a user', async () => {
    const { body: created } = await request(app)
      .post('/download/requests')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ assetIds: [heic.id], variant: { ...compatible, imageFormat: 'webp' } });

    const { status, body } = await request(app)
      .get('/download/requests')
      .set('Authorization', `Bearer ${admin.accessToken}`);

    expect(status).toBe(200);
    expect(body).toEqual([expect.objectContaining({ id: created.request.id })]);

    const removed = await request(app)
      .delete(`/download/requests/${created.request.id}`)
      .set('Authorization', `Bearer ${admin.accessToken}`);
    expect(removed.status).toBe(204);
  });
});
