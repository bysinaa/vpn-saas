import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UsePipes,
} from '@nestjs/common';
import { ServersService } from './servers.service';
import {
  CreateCountryInput,
  createCountrySchema,
  UpdateCountryInput,
  updateCountrySchema,
  CreateCityInput,
  createCitySchema,
  CreateServerInput,
  createServerSchema,
  UpdateServerInput,
  updateServerSchema,
  CreateInboundInput,
  createInboundSchema,
} from './servers.schemas';
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';

@Controller('servers')
export class ServersController {
  constructor(private readonly servers: ServersService) {}

  // ---- Public catalog (locations) ----
  @Get('countries')
  listCountries() {
    return this.servers.listCountries();
  }

  @Get('cities')
  listCities(@Query('countryId') countryId?: string) {
    return this.servers.listCities(countryId ? BigInt(countryId) : undefined);
  }

  @Get()
  list(@Query() query: Record<string, unknown>) {
    return this.servers.listServers(query);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.servers.getServer(BigInt(id));
  }

  // ---- Admin: Countries ----
  @Post('admin/countries')
  @RequirePermissions(['manage:servers'])
  @UsePipes(new ZodValidationPipe(createCountrySchema))
  createCountry(@Body() body: CreateCountryInput) {
    return this.servers.createCountry(body);
  }

  @Patch('admin/countries/:id')
  @RequirePermissions(['manage:servers'])
  @UsePipes(new ZodValidationPipe(updateCountrySchema))
  updateCountry(@Param('id') id: string, @Body() body: UpdateCountryInput) {
    return this.servers.updateCountry(BigInt(id), body);
  }

  @Delete('admin/countries/:id')
  @RequirePermissions(['manage:servers'])
  deleteCountry(@Param('id') id: string) {
    return this.servers.deleteCountry(BigInt(id));
  }

  // ---- Admin: Cities ----
  @Post('admin/cities')
  @RequirePermissions(['manage:servers'])
  @UsePipes(new ZodValidationPipe(createCitySchema))
  createCity(@Body() body: CreateCityInput) {
    return this.servers.createCity({ countryId: BigInt(body.countryId), name: body.name });
  }

  @Delete('admin/cities/:id')
  @RequirePermissions(['manage:servers'])
  deleteCity(@Param('id') id: string) {
    return this.servers.deleteCity(BigInt(id));
  }

  // ---- Admin: Servers ----
  @Post('admin')
  @RequirePermissions(['manage:servers'])
  @UsePipes(new ZodValidationPipe(createServerSchema))
  createServer(@Body() body: CreateServerInput) {
    return this.servers.createServer({
      cityId: BigInt(body.cityId),
      name: body.name,
      host: body.host,
      port: body.port,
      panelId: BigInt(body.panelId),
      status: body.status,
      maxLoad: body.maxLoad,
    });
  }

  @Patch('admin/:id')
  @RequirePermissions(['manage:servers'])
  @UsePipes(new ZodValidationPipe(updateServerSchema))
  updateServer(@Param('id') id: string, @Body() body: UpdateServerInput) {
    return this.servers.updateServer(BigInt(id), body as Record<string, unknown>);
  }

  @Delete('admin/:id')
  @RequirePermissions(['manage:servers'])
  deleteServer(@Param('id') id: string) {
    return this.servers.deleteServer(BigInt(id));
  }

  // ---- Admin: Health + Inbounds ----
  @Get(':id/health')
  listHealth(@Param('id') id: string, @Query() query: Record<string, unknown>) {
    return this.servers.listHealth(BigInt(id), query);
  }

  @Get(':id/inbounds')
  listInbounds(@Param('id') id: string) {
    return this.servers.listInbounds(BigInt(id));
  }

  @Post('admin/:id/inbounds')
  @RequirePermissions(['manage:servers'])
  @UsePipes(new ZodValidationPipe(createInboundSchema))
  createInbound(@Param('id') id: string, @Body() body: CreateInboundInput) {
    return this.servers.createInbound({
      serverId: BigInt(id),
      panelId: BigInt(body.panelId),
      inboundId: body.inboundId,
      protocol: body.protocol,
      port: body.port,
      settings: body.settings,
    });
  }
}
