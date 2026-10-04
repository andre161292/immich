import { Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { jsonArrayFrom } from 'kysely/helpers/postgres';
import { InjectKysely } from 'nestjs-kysely';
import { DummyValue, GenerateSql } from 'src/decorators';
import { AssetVisibility } from 'src/enum';
import { DB } from 'src/schema';
import { anyUuid } from 'src/utils/database';
import { VariantAsset } from 'src/utils/download-variant';

const builder = (db: Kysely<DB>) =>
  db
    .selectFrom('asset')
    .innerJoin('asset_exif', 'assetId', 'id')
    .select(['asset.id', 'asset.livePhotoVideoId', 'asset_exif.fileSizeInByte as size'])
    .where('asset.deletedAt', 'is', null);

@Injectable()
export class DownloadRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  downloadAssetIds(ids: string[]) {
    return builder(this.db).where('asset.id', '=', anyUuid(ids)).stream();
  }

  downloadMotionAssetIds(ids: string[]) {
    return builder(this.db).select(['asset.originalPath']).where('asset.id', '=', anyUuid(ids)).stream();
  }

  downloadAlbumId(albumId: string) {
    return builder(this.db)
      .innerJoin('album_asset', 'asset.id', 'album_asset.assetId')
      .where('album_asset.albumId', '=', albumId)
      .stream();
  }

  downloadUserId(userId: string) {
    return builder(this.db)
      .where('asset.ownerId', '=', userId)
      .where('asset.visibility', '!=', AssetVisibility.Hidden)
      .stream();
  }

  @GenerateSql({ params: [[DummyValue.UUID]] })
  getForVariants(ids: string[]): Promise<VariantAsset[]> {
    return this.db
      .selectFrom('asset')
      .leftJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .leftJoin('asset_video', 'asset_video.assetId', 'asset.id')
      .select([
        'asset.id',
        'asset.ownerId',
        'asset.type',
        'asset.originalPath',
        'asset.originalFileName',
        'asset.checksum',
        'asset_exif.exifImageWidth as width',
        'asset_exif.exifImageHeight as height',
        'asset_video.codecName as videoCodec',
      ])
      .select((eb) =>
        jsonArrayFrom(
          eb
            .selectFrom('asset_file')
            .select(['asset_file.type', 'asset_file.path', 'asset_file.isEdited', 'asset_file.updateId'])
            .whereRef('asset_file.assetId', '=', 'asset.id'),
        ).as('files'),
      )
      .where('asset.id', '=', anyUuid(ids))
      .where('asset.deletedAt', 'is', null)
      .execute();
  }

  @GenerateSql({ params: [[DummyValue.UUID]] })
  async getExistingAssetIds(ids: string[]): Promise<string[]> {
    const rows = await this.db.selectFrom('asset').select('asset.id').where('asset.id', '=', anyUuid(ids)).execute();
    return rows.map(({ id }) => id);
  }
}
