import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Next,
  Param,
  Post,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { type NextFunction, type Response } from 'express';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  DownloadRequestArchiveDto,
  DownloadRequestCreateDto,
  DownloadRequestCreateResponseDto,
  DownloadRequestDto,
  DownloadRequestInfoDto,
  DownloadRequestTokenDto,
} from 'src/dtos/download-variant.dto.js';
import { DownloadResponseDto } from 'src/dtos/download.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated, FileResponse } from 'src/middleware/auth.guard.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DownloadVariantService } from 'src/services/download-variant.service.js';
import { asStreamableFile, sendFile } from 'src/utils/file.js';
import { UUIDAssetIDParamDto, UUIDParamDto } from 'src/validation.js';

const history = () => new HistoryBuilder().added('v3.3.0').alpha('v3.3.0');

@ApiTags(ApiTag.Download)
@Controller('download/requests')
export class DownloadVariantController {
  constructor(
    private logger: LoggingRepository,
    private service: DownloadVariantService,
  ) {}

  @Post()
  @Authenticated({ permission: Permission.AssetDownload, sharedLink: true })
  @Endpoint({
    summary: 'Create a download request',
    description:
      'Prepare a download of converted variants. When nothing needs to be converted, the response says so and the regular download endpoints should be used.',
    history: history(),
  })
  createDownloadRequest(
    @Auth() auth: AuthDto,
    @Body() dto: DownloadRequestCreateDto,
    @Query() { downloadToken }: DownloadRequestTokenDto,
  ): Promise<DownloadRequestCreateResponseDto> {
    return this.service.create(auth, dto, downloadToken);
  }

  @Get()
  @Authenticated({ permission: Permission.AssetDownload, sharedLink: true })
  @Endpoint({
    summary: 'List download requests',
    description: 'List the download requests of the current user or shared link visitor.',
    history: history(),
  })
  getDownloadRequests(
    @Auth() auth: AuthDto,
    @Query() { downloadToken }: DownloadRequestTokenDto,
  ): Promise<DownloadRequestDto[]> {
    return this.service.getAll(auth, downloadToken);
  }

  @Get(':id')
  @Authenticated({ permission: Permission.AssetDownload, sharedLink: true })
  @Endpoint({
    summary: 'Retrieve a download request',
    description: 'Retrieve the status of a download request.',
    history: history(),
  })
  getDownloadRequest(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Query() { downloadToken }: DownloadRequestTokenDto,
  ): Promise<DownloadRequestDto> {
    return this.service.get(auth, id, downloadToken);
  }

  @Delete(':id')
  @Authenticated({ permission: Permission.AssetDownload, sharedLink: true })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Delete a download request',
    description: 'Cancel a download request that is being prepared, or remove one that is ready.',
    history: history(),
  })
  deleteDownloadRequest(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Query() { downloadToken }: DownloadRequestTokenDto,
  ): Promise<void> {
    return this.service.remove(auth, id, downloadToken);
  }

  @Post(':id/info')
  @Authenticated({ permission: Permission.AssetDownload, sharedLink: true })
  @Endpoint({
    summary: 'Retrieve download request archive information',
    description: 'Split a prepared download request into archives of the given size.',
    history: history(),
  })
  getDownloadRequestInfo(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: DownloadRequestInfoDto,
    @Query() { downloadToken }: DownloadRequestTokenDto,
  ): Promise<DownloadResponseDto> {
    return this.service.getInfo(auth, id, dto, downloadToken);
  }

  @Post(':id/archive')
  @Authenticated({ permission: Permission.AssetDownload, sharedLink: true })
  @FileResponse()
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Download a download request archive',
    description: 'Download a ZIP archive of a prepared download request.',
    history: history(),
  })
  downloadRequestArchive(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: DownloadRequestArchiveDto,
    @Query() { downloadToken }: DownloadRequestTokenDto,
  ): Promise<StreamableFile> {
    return this.service.downloadArchive(auth, id, dto, downloadToken).then(asStreamableFile);
  }

  @Get(':id/assets/:assetId')
  @Authenticated({ permission: Permission.AssetDownload, sharedLink: true })
  @FileResponse()
  @Endpoint({
    summary: 'Download a file of a download request',
    description: 'Download the prepared file of a single asset of a download request.',
    history: history(),
  })
  async downloadRequestFile(
    @Auth() auth: AuthDto,
    @Param() { id, assetId }: UUIDAssetIDParamDto,
    @Query() { downloadToken }: DownloadRequestTokenDto,
    @Res() res: Response,
    @Next() next: NextFunction,
  ) {
    await sendFile(res, next, () => this.service.downloadFile(auth, id, assetId, downloadToken), this.logger);
  }
}
