import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/common/prisma/prisma.service';
import { BusinessException } from '@/common/exceptions/business.exception';
import {
  PaginatedDto,
  buildMeta,
  parsePagination,
  skipTake,
} from '@/common/pagination/pagination.dto';

export interface CountryDto {
  id: string;
  code: string;
  name: string;
  flagEmoji: string | null;
  cityCount: number;
}

export interface CityDto {
  id: string;
  countryId: string;
  name: string;
}

export interface ServerDto {
  id: string;
  publicId: string;
  name: string;
  host: string;
  port: number;
  status: string;
  currentLoad: number;
  maxLoad: number;
  panelId: string;
  panelName: string | null;
  cityId: string;
  cityName: string | null;
  countryName: string | null;
}

/**
 * ServersService - manages the geographic + physical server topology.
 * Servers belong to Cities which belong to Countries; each Server maps to
 * exactly one VpnPanel (Sanity instance) for provisioning.
 */
@Injectable()
export class ServersService {
  constructor(private readonly prisma: PrismaService) {}

  // ---- Countries ----
  async listCountries(): Promise<CountryDto[]> {
    const countries = await this.prisma.country.findMany({
      include: { _count: { select: { cities: true } } },
      orderBy: { name: 'asc' },
    });
    return countries.map((c) => ({
      id: c.id.toString(),
      code: c.code,
      name: c.name,
      flagEmoji: c.flag,
      cityCount: c._count.cities,
    }));
  }

  async createCountry(input: { code: string; name: string; flagEmoji?: string }): Promise<CountryDto> {
    const country = await this.prisma.country.create({
      data: { code: input.code.toUpperCase(), name: input.name, flag: input.flagEmoji ?? null },
      include: { _count: { select: { cities: true } } },
    });
    return {
      id: country.id.toString(),
      code: country.code,
      name: country.name,
      flagEmoji: country.flag,
      cityCount: country._count.cities,
    };
  }

  async updateCountry(id: bigint, input: Partial<{ code: string; name: string; flagEmoji: string }>): Promise<CountryDto> {
    const country = await this.prisma.country.update({
      where: { id },
      data: {
        ...(input.code ? { code: input.code.toUpperCase() } : {}),
        ...(input.name ? { name: input.name } : {}),
        ...(input.flagEmoji !== undefined ? { flag: input.flagEmoji } : {}),
      },
      include: { _count: { select: { cities: true } } },
    });
    return {
      id: country.id.toString(),
      code: country.code,
      name: country.name,
      flagEmoji: country.flag,
      cityCount: country._count.cities,
    };
  }

  async deleteCountry(id: bigint): Promise<void> {
    const cities = await this.prisma.city.count({ where: { countryId: id } });
    if (cities > 0) throw BusinessException.conflict('Country has cities; remove them first');
    await this.prisma.country.delete({ where: { id } });
  }

  // ---- Cities ----
  async listCities(countryId?: bigint): Promise<CityDto[]> {
    const cities = await this.prisma.city.findMany({
      where: countryId ? { countryId } : undefined,
      orderBy: { name: 'asc' },
    });
    return cities.map((c) => ({
      id: c.id.toString(),
      countryId: c.countryId.toString(),
      name: c.name,
    }));
  }

  async createCity(input: { countryId: bigint; name: string }): Promise<CityDto> {
    const city = await this.prisma.city.create({
      data: { countryId: input.countryId, name: input.name },
    });
    return { id: city.id.toString(), countryId: city.countryId.toString(), name: city.name };
  }

  async deleteCity(id: bigint): Promise<void> {
    const servers = await this.prisma.server.count({ where: { cityId: id } });
    if (servers > 0) throw BusinessException.conflict('City has servers; move them first');
    await this.prisma.city.delete({ where: { id } });
  }

  // ---- Servers ----
  async listServers(query: Record<string, unknown>): Promise<PaginatedDto<ServerDto>> {
    const params = parsePagination(query);
    const where: Record<string, unknown> = {};
    if (query.status) where.status = query.status;
    if (query.cityId) where.cityId = BigInt(query.cityId as string);
    if (query.countryId) where.city = { countryId: BigInt(query.countryId as string) };

    const [total, items] = await Promise.all([
      this.prisma.server.count({ where }),
      this.prisma.server.findMany({
        where,
        ...skipTake(params),
        orderBy: { createdAt: 'desc' },
        include: { panel: true, city: { include: { country: true } } },
      }),
    ]);
    return { data: items.map((s) => this.toDto(s)), meta: buildMeta(total, params) };
  }

  async getServer(id: bigint): Promise<ServerDto> {
    const server = await this.prisma.server.findUnique({
      where: { id },
      include: { panel: true, city: { include: { country: true } } },
    });
    if (!server) throw BusinessException.notFound('Server not found');
    return this.toDto(server);
  }

  async createServer(input: {
    cityId: bigint;
    name: string;
    host: string;
    port: number;
    panelId: bigint;
    status?: string;
    maxLoad?: number;
  }): Promise<ServerDto> {
    // Server schema uses `hostname` + `ip` (no `host`/`port`), `capacity`
    // (not `maxLoad`), and `publicId` is auto-generated.
    const server = await this.prisma.server.create({
      data: {
        cityId: input.cityId,
        panelId: input.panelId,
        name: input.name,
        hostname: input.host,
        ip: input.host,
        status: (input.status as any) ?? 'ONLINE',
        currentLoad: 0,
        capacity: input.maxLoad ?? 1000,
        // Stash the original port in metadata since the schema has no port.
        metadata: { port: input.port } as any,
      },
      include: { panel: true, city: { include: { country: true } } },
    });
    return this.toDto(server);
  }

  async updateServer(id: bigint, input: Record<string, unknown>): Promise<ServerDto> {
    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.host !== undefined) {
      data.hostname = input.host;
      data.ip = input.host;
    }
    if (input.status !== undefined) data.status = input.status;
    if (input.maxLoad !== undefined) data.capacity = input.maxLoad;
    if (input.port !== undefined) {
      data.metadata = { port: input.port } as any;
    }
    if (input.cityId) data.cityId = BigInt(input.cityId as string);
    if (input.panelId) data.panelId = BigInt(input.panelId as string);
    const server = await this.prisma.server.update({
      where: { id },
      data,
      include: { panel: true, city: { include: { country: true } } },
    });
    return this.toDto(server);
  }

  async deleteServer(id: bigint): Promise<void> {
    await this.prisma.server.delete({ where: { id } });
  }

  /** Record a health probe result. */
  async recordHealth(serverId: bigint, probe: {
    cpuUsage?: number;
    memoryUsage?: number;
    networkIn?: string;
    networkOut?: string;
    activeUsers?: number;
    isReachable: boolean;
    latencyMs?: number;
  }): Promise<void> {
    // ServerHealthLog: status is required; cpuPercent/memPercent replace
    // cpuUsage/memoryUsage; no network bytes / isReachable fields.
    await this.prisma.serverHealthLog.create({
      data: {
        serverId,
        status: probe.isReachable ? 'ONLINE' : 'OFFLINE',
        latencyMs: probe.latencyMs ?? null,
        cpuPercent: probe.cpuUsage ?? null,
        memPercent: probe.memoryUsage ?? null,
        activeUsers: probe.activeUsers ?? null,
      },
    });
    await this.prisma.server.update({
      where: { id: serverId },
      data: { healthCheckedAt: new Date() },
    });
  }

  async listHealth(serverId: bigint, query: Record<string, unknown>): Promise<any> {
    const params = parsePagination(query);
    const [total, items] = await Promise.all([
      this.prisma.serverHealthLog.count({ where: { serverId } }),
      this.prisma.serverHealthLog.findMany({
        where: { serverId },
        ...skipTake(params),
        orderBy: { checkedAt: 'desc' },
      }),
    ]);
    return {
      data: items.map((h) => ({
        id: h.id.toString(),
        cpuUsage: h.cpuPercent,
        memoryUsage: h.memPercent,
        activeUsers: h.activeUsers,
        isReachable: h.status === 'ONLINE',
        latencyMs: h.latencyMs,
        createdAt: h.checkedAt,
      })),
      meta: buildMeta(total, params),
    };
  }

  // ---- Inbounds ----
  async listInbounds(serverId: bigint): Promise<any[]> {
    const inbounds = await this.prisma.inboundConfig.findMany({
      where: { serverId },
      orderBy: { createdAt: 'desc' },
    });
    return inbounds.map((i) => ({
      id: i.id.toString(),
      protocol: i.protocol,
      port: i.port,
      settings: i.metadata,
      isActive: i.isActive,
    }));
  }

  async createInbound(input: {
    serverId: bigint;
    panelId: bigint;
    inboundId: string;
    protocol: string;
    port: number;
    settings?: any;
  }): Promise<any> {
    const inbound = await this.prisma.inboundConfig.create({
      data: {
        serverId: input.serverId,
        panelId: input.panelId,
        inboundId: input.inboundId,
        protocol: input.protocol as any,
        port: input.port,
        metadata: input.settings ?? {},
        isActive: true,
      },
    });
    return {
      id: inbound.id.toString(),
      protocol: inbound.protocol,
      port: inbound.port,
      settings: inbound.metadata,
      isActive: inbound.isActive,
    };
  }

  private toDto(s: any): ServerDto {
    return {
      id: s.id.toString(),
      publicId: s.publicId,
      name: s.name,
      host: s.hostname ?? s.ip,
      port: s.metadata?.port ?? 0,
      status: s.status,
      currentLoad: s.currentLoad,
      maxLoad: s.capacity,
      panelId: s.panelId.toString(),
      panelName: s.panel?.name ?? null,
      cityId: s.cityId.toString(),
      cityName: s.city?.name ?? null,
      countryName: s.city?.country?.name ?? null,
    };
  }
}
