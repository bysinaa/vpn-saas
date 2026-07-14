import { Injectable } from '@nestjs/common';
import type { RequestInit } from 'node-fetch';
import { PrismaService } from '@/common/prisma/prisma.service';
import { BusinessException } from '@/common/exceptions/business.exception';
import { config } from '@/config';
import { XuiClient } from './xui.client';
import { XuiAuthService } from './xui.auth';
import type {
  XuiAuthResponse,
  XuiClientRecord,
  XuiClientRequest,
  XuiClientTraffic,
  XuiConnectionTestResult,
  XuiCreateClientInput,
  XuiInbound,
  XuiProvisionedClient,
  XuiStatusDto,
  XuiUpdateClientInput,
} from './xui.types';

@Injectable()
export class XuiService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly client: XuiClient,
    private readonly auth: XuiAuthService,
  ) {}

  async login() {
    const session = await this.auth.login(true);
    await this.upsertConnection('ONLINE', session.lastLoginAt ?? new Date(), session.cookie);
    return {
      connected: true,
      lastLogin: session.lastLoginAt,
    };
  }

  async logout() {
    await this.auth.logout();
    await this.upsertConnection('OFFLINE', null, null);
    return { connected: false };
  }

  async checkSession() {
    const connected = await this.auth.checkSession();
    return {
      connected,
      session: connected ? this.auth.getSession() : null,
    };
  }

  async getInbounds(): Promise<XuiInbound[]> {
    const payload = await this.requestWithReconnect<XuiAuthResponse<XuiInbound[]>>('/panel/api/inbounds/list', {
      method: 'GET',
    });

    return payload.obj ?? [];
  }

  async getInbound(id: number): Promise<XuiInbound | null> {
    const inbounds = await this.getInbounds();
    return inbounds.find((item) => item.id === id) ?? null;
  }

  async createClient(input: XuiCreateClientInput): Promise<XuiProvisionedClient> {
    const email = this.buildClientEmail(input.username, input.telegramId);
    const uuid = crypto.randomUUID();
    const expireTimestamp = this.toExpireTimestamp(input.expireDate);
    const trafficQuota = this.toQuotaNumber(input.trafficLimit);
    const inboundId = await this.resolveInboundId(input.inboundId, input.inboundIds);

    const requestBody: XuiClientRequest = {
      id: uuid,
      email,
      enable: true,
      totalGB: trafficQuota,
      expiryTime: expireTimestamp,
      tgId: input.telegramId ?? '',
      comment: input.planId ? `plan:${String(input.planId)}` : undefined,
      subId: crypto.randomUUID().replace(/-/g, '').slice(0, 16),
      limitIp: 1,
    };

    await this.requestWithReconnect<XuiAuthResponse<unknown>>('/panel/api/clients/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: inboundId,
        settings: JSON.stringify({ clients: [requestBody] }),
      }),
    });

    const client = await this.findClientByEmail(email);

    await this.persistVpnClient({
      email,
      telegramId: input.telegramId ?? null,
      uuid,
      inboundId,
      expireTimestamp,
      trafficLimit: trafficQuota,
      trafficUsed: 0,
      status: 'ACTIVE',
    });

    return {
      uuid,
      email,
      telegramId: input.telegramId ?? null,
      planId: input.planId !== null && input.planId !== undefined ? String(input.planId) : null,
      expireTimestamp,
      trafficQuota,
      inboundId,
      client,
    };
  }

  async updateClient(email: string, input: XuiUpdateClientInput): Promise<XuiClientRecord | null> {
    const existing = await this.findClientByEmail(email);
    if (!existing) throw BusinessException.notFound(`3X-UI client not found: ${email}`);

    const inboundId = input.inboundId ?? existing.inboundId;
    if (!inboundId) throw BusinessException.conflict('Inbound ID is required to update a 3X-UI client');

    const updated: XuiClientRequest = {
      ...existing,
      email: input.email ?? existing.email,
      enable: input.status === 'disabled' ? false : existing.enable ?? true,
      totalGB:
        input.trafficLimit !== undefined ? this.toQuotaNumber(input.trafficLimit) : (existing.totalGB ?? existing.total ?? 0),
      expiryTime:
        input.expireDate !== undefined
          ? this.toExpireTimestamp(input.expireDate)
          : (existing.expiryTime ?? 0),
      tgId: input.telegramId ?? existing.tgId ?? '',
      reset: input.resetTraffic ? 0 : existing.reset,
    };

    await this.requestWithReconnect<XuiAuthResponse<unknown>>(`/panel/api/inbounds/updateClient/${inboundId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: inboundId,
        settings: JSON.stringify({ clients: [updated] }),
      }),
    });

    const nextEmail = updated.email;
    if (nextEmail) {
      await this.persistVpnClient({
        email: nextEmail,
        previousEmail: email,
        telegramId: input.telegramId ?? null,
        uuid: existing.id ?? existing.uuid ?? email,
        inboundId,
        expireTimestamp: updated.expiryTime ?? 0,
        trafficLimit: updated.totalGB ?? 0,
        trafficUsed: existing.up ?? 0 + (existing.down ?? 0),
        status: updated.enable === false ? 'DISABLED' : 'ACTIVE',
      });
    }

    return this.findClientByEmail(nextEmail ?? email);
  }

  async deleteClient(email: string): Promise<void> {
    const existing = await this.findClientByEmail(email);
    if (!existing?.inboundId) {
      await this.markVpnClientStatus(email, 'DELETED');
      return;
    }

    await this.requestWithReconnect<XuiAuthResponse<unknown>>(`/panel/api/inbounds/delClient/${existing.inboundId}/${encodeURIComponent(email)}`, {
      method: 'POST',
    });

    await this.markVpnClientStatus(email, 'DELETED');
  }

  async getClientTraffic(email: string): Promise<XuiClientTraffic | null> {
    const inbounds = await this.getInbounds();

    for (const inbound of inbounds) {
      const client = (inbound.clientStats ?? []).find((item) => item.email === email);
      if (client) {
        await this.persistVpnClient({
          email,
          telegramId: null,
          uuid: String(client.id ?? client.uuid ?? email),
          inboundId: inbound.id,
          expireTimestamp: client.expiryTime ?? 0,
          trafficLimit: client.total ?? 0,
          trafficUsed: (client.up ?? 0) + (client.down ?? 0),
          status: client.enable ? 'ACTIVE' : 'DISABLED',
        });
        return { ...client, inboundId: inbound.id };
      }
    }

    return null;
  }

  async getStatus(): Promise<XuiStatusDto> {
    try {
      const inbounds = await this.getInbounds();
      return {
        connected: true,
        panel: 'online',
        lastSync: new Date().toISOString(),
        inbounds: inbounds.map((item) => ({
          id: item.id,
          protocol: item.protocol,
          port: item.port,
          remark: item.remark,
          enabled: item.enable,
        })),
      };
    } catch {
      return {
        connected: false,
        panel: 'offline',
        lastSync: null,
        inbounds: [],
      };
    }
  }

  async testConnection(): Promise<XuiConnectionTestResult> {
    const details: string[] = [];
    const rootResponse = await this.client.raw('/', { method: 'GET' });

    if (!rootResponse.ok) {
      throw BusinessException.conflict(`Panel root check failed with HTTP ${rootResponse.status}`);
    }
    details.push('✓ SSL connection OK');

    await this.login();
    details.push('✓ Login successful');

    const inbounds = await this.getInbounds();
    details.push('✓ API reachable');
    details.push(`✓ ${inbounds.length} inbounds detected`);

    return {
      ssl: true,
      login: true,
      api: true,
      inboundsDetected: inbounds.length,
      details,
    };
  }

  private async requestWithReconnect<T>(path: string, init: RequestInit): Promise<T> {
    await this.auth.ensureSession();

    const doRequest = async () => {
      const response = await this.client.raw(path, {
        ...init,
        headers: {
          ...this.normalizeHeaders(init.headers),
          ...this.auth.buildAuthHeaders(),
        },
      });

      this.auth.captureResponseCookies(response);

      if (response.status === 401 || response.status === 403) {
        return null;
      }

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw BusinessException.conflict(`3X-UI request failed (${response.status}): ${body.slice(0, 200)}`);
      }

      return (await response.json()) as T;
    };

    const first = await doRequest();
    if (first !== null) return first;

    await this.auth.login(true);
    const second = await doRequest();
    if (second === null) {
      throw BusinessException.unauthorized('3X-UI session expired and re-authentication failed');
    }

    return second;
  }

  private async findClientByEmail(email: string): Promise<XuiClientRecord | null> {
    const inbounds = await this.getInbounds();

    for (const inbound of inbounds) {
      const settings = this.parseSettings(inbound.settings);
      const clients = Array.isArray(settings.clients) ? (settings.clients as XuiClientRecord[]) : [];
      const client = clients.find((item) => item.email === email);
      if (client) {
        return { ...client, inboundId: inbound.id };
      }
    }

    return null;
  }

  private parseSettings(value: string): Record<string, unknown> {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private buildClientEmail(username: string, telegramId?: string | null): string {
    const base = username.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 24) || 'vpn';
    const suffix = telegramId ? telegramId.replace(/[^0-9]/g, '').slice(-8) : Date.now().toString(36);
    return `${base}_${suffix}`;
  }

  private toExpireTimestamp(value: Date | string | number | null | undefined): number {
    if (!value) return 0;
    if (value instanceof Date) return value.getTime();
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private toQuotaNumber(value: bigint | number | null | undefined): number {
    if (value === null || value === undefined) return 0;
    return Number(value);
  }

  private async resolveInboundId(preferred?: number, inboundIds?: number[]): Promise<number> {
    if (preferred) return preferred;
    if (inboundIds?.length) return inboundIds[0];

    const configured = config.xui.defaultInboundId;
    if (configured) return configured;

    const inbounds = await this.getInbounds();
    const enabled = inbounds.find((item) => item.enable);
    if (!enabled) {
      throw BusinessException.conflict('No enabled 3X-UI inbound found');
    }

    return enabled.id;
  }

  private normalizeHeaders(headers?: RequestInit['headers']): Record<string, string> {
    if (!headers) return {};
    if (Array.isArray(headers)) return Object.fromEntries(headers);
    if (typeof headers === 'object' && 'forEach' in headers && typeof headers.forEach === 'function') {
      const entries: Record<string, string> = {};
      headers.forEach((value: string, key: string) => {
        entries[key] = value;
      });
      return entries;
    }

    const record: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      record[key] = Array.isArray(value) ? value.join('; ') : String(value);
    }
    return record;
  }

  private async persistVpnClient(input: {
    email: string;
    previousEmail?: string;
    telegramId: string | null;
    uuid: string;
    inboundId: number;
    expireTimestamp: number;
    trafficLimit: number;
    trafficUsed: number;
    status: string;
  }): Promise<void> {
    await this.prisma.$executeRawUnsafe(
      `
        INSERT INTO vpn_clients
          ("userId", "telegramId", "uuid", "email", "xuiInboundId", "expireAt", "trafficLimit", "trafficUsed", "status", "createdAt", "updatedAt")
        VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
        ON CONFLICT ("email")
        DO UPDATE SET
          "telegramId" = EXCLUDED."telegramId",
          "uuid" = EXCLUDED."uuid",
          "email" = EXCLUDED."email",
          "xuiInboundId" = EXCLUDED."xuiInboundId",
          "expireAt" = EXCLUDED."expireAt",
          "trafficLimit" = EXCLUDED."trafficLimit",
          "trafficUsed" = EXCLUDED."trafficUsed",
          "status" = EXCLUDED."status",
          "updatedAt" = NOW()
      `,
      BigInt(0),
      input.telegramId,
      input.uuid,
      input.email,
      BigInt(input.inboundId),
      input.expireTimestamp ? new Date(input.expireTimestamp) : null,
      BigInt(input.trafficLimit),
      BigInt(input.trafficUsed),
      input.status,
    );

    if (input.previousEmail && input.previousEmail !== input.email) {
      await this.prisma.$executeRawUnsafe(
        `UPDATE vpn_clients SET "email" = $1, "updatedAt" = NOW() WHERE "email" = $2`,
        input.email,
        input.previousEmail,
      );
    }
  }

  private async markVpnClientStatus(email: string, status: string): Promise<void> {
    await this.prisma.$executeRawUnsafe(
      `UPDATE vpn_clients SET "status" = $1, "updatedAt" = NOW() WHERE "email" = $2`,
      status,
      email,
    );
  }

  private async upsertConnection(status: string, lastLogin: Date | null, cookie: string | null): Promise<void> {
    const encryptedPassword = Buffer.from(config.xui.password, 'utf8').toString('base64');

    await this.prisma.$executeRawUnsafe(
      `
        INSERT INTO xui_connections
          ("panelUrl", "username", "passwordEncrypted", "cookie", "lastLogin", "status", "createdAt", "updatedAt")
        VALUES
          ($1, $2, $3, $4, $5, $6, NOW(), NOW())
        ON CONFLICT ("panelUrl")
        DO UPDATE SET
          "username" = EXCLUDED."username",
          "passwordEncrypted" = EXCLUDED."passwordEncrypted",
          "cookie" = EXCLUDED."cookie",
          "lastLogin" = EXCLUDED."lastLogin",
          "status" = EXCLUDED."status",
          "updatedAt" = NOW()
      `,
      config.xui.panelUrl,
      config.xui.username,
      encryptedPassword,
      cookie,
      lastLogin,
      status,
    );
  }
}