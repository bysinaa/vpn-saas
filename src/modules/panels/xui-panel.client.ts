import { Injectable, Logger } from '@nestjs/common';
import nodeFetch, { type Response } from 'node-fetch';
import { z } from 'zod';
import { config } from '@/config';
import { BusinessException } from '@/common/exceptions/business.exception';
import { ProxyHttpService } from '@/common/proxy/proxy-http.service';
import type {
  IPanelClient,
  PanelConnection,
  PanelUser,
  CreatePanelUserInput,
  UpdatePanelUserInput,
  PanelHealth,
} from './panel-client.interface';

/**
 * 3x-ui (Sanaei) response envelope.
 * Every /panel/api/* call returns { success, msg, obj }.
 */
interface ThreeXuiEnvelope<T = unknown> {
  success: boolean;
  msg: string;
  obj: T;
}

/** A single inbound as returned by GET /panel/api/inbounds/list. */
interface ThreeXuiInbound {
  id: number;
  tag: string;
  protocol: string;
  enable: boolean;
  port: number;
  settings: string; // JSON string
}

export interface XuiInbound {
  id: number;
  remark: string;
  tag: string | null;
  protocol: string;
  port: number;
  enabled: boolean;
  expiryTime: number | null;
  clientCompatible: boolean;
}

/** A client object as returned by GET /panel/api/clients/get/{email}. */
interface ThreeXuiClient {
  id: string | number; // uuid when sending, numeric DB id when returned by some 3x-ui builds
  uuid?: string; // canonical client UUID returned by /panel/api/clients/get/{email}
  email: string;
  enable: boolean;
  expiryTime: number; // ms since epoch; 0 = never
  limitIp: number;
  totalGB: number; // bytes (yes, despite the name)
  reset?: number; // bytes on some builds
  up?: number;
  down?: number;
  subId: string;
  tgId: string | number;
  flow: string;
  comment: string;
  inboundId?: number;
}

interface ThreeXuiClientGetObject {
  client?: ThreeXuiClient;
  inbound?: { id?: number };
}

interface PanelSession {
  /** Cookie header value, e.g. "3x-ui=abc". */
  cookie: string;
  /** Last known CSRF token. */
  csrfToken: string;
  /** Epoch ms when the session was established. */
  loggedInAt: number;
}

const xuiEnvelopeSchema = z.object({
  success: z.boolean(),
  msg: z.string().default(''),
  obj: z.unknown(),
});
const emailSchema = z.string().trim().min(1).max(255).regex(/^[A-Za-z0-9._@-]+$/);
const inboundIdsSchema = z.array(z.number().int().positive()).min(1);
const bytesSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const expiryMsSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const subIdSchema = z.string().trim().min(1).max(255);
const inboundResponseSchema = z
  .object({
    id: z.number().int().positive(),
    remark: z.string().default(''),
    tag: z.string().optional(),
    protocol: z.string().trim().min(1),
    port: z.number().int().min(0),
    enable: z.boolean(),
    expiryTime: z.number().int().nonnegative().optional(),
  })
  .passthrough();
const clientStateSchema = z
  .object({
    email: emailSchema,
    enable: z.boolean(),
    totalGB: bytesSchema.default(0),
    expiryTime: expiryMsSchema.default(0),
    limitIp: z.number().int().nonnegative().default(0),
    subId: z.string().optional(),
    uuid: z.string().optional(),
    tgId: z.union([z.string(), z.number()]).optional(),
    flow: z.string().optional(),
    comment: z.string().optional(),
  })
  .passthrough() as unknown as z.ZodType<XuiClientState>;
const clientGetSchema = z.union([
  clientStateSchema,
  z.object({ client: clientStateSchema }).transform(({ client }) => client),
]) as unknown as z.ZodType<XuiClientState>;

export interface XuiClientState {
  email: string;
  enable: boolean;
  totalGB: number;
  expiryTime: number;
  limitIp: number;
  subId?: string;
  uuid?: string;
  tgId?: string | number;
  flow?: string;
  comment?: string;
  [key: string]: unknown;
}

export interface XuiPagedClients {
  total: number;
  items: XuiClientState[];
}

export interface XuiBulkResult {
  created?: string[];
  skipped?: Array<{ email: string; reason: string }>;
  [key: string]: unknown;
}

export function isFirstClassXuiProtocol(protocol: string): boolean {
  return ['vmess', 'vless', 'trojan', 'shadowsocks'].includes(protocol.toLowerCase());
}

/**
 * XuiPanelClient — real implementation of IPanelClient for 3X-UI (Sanaei)
 * v3.4.x.
 *
 * 3X-UI uses session-cookie + CSRF-token authentication (NOT a Bearer token):
 *   1. GET /csrf-token              → { obj: "<csrf>", success: true }
 *   2. POST /login (form-encoded)   → sets session cookie
 *   3. Every subsequent /panel/api/* request carries:
 *        Cookie: <session cookie>
 *        X-CSRF-Token: <csrf token>
 *
 * Sessions are cached per panel (keyed by panel.id) and re-established
 * automatically when the panel replies 401/403.
 *
 * Client identity in 3X-UI is the client's **email**; the `username` field on
 * PanelConnection/PanelUser is therefore treated as the client email.
 */
@Injectable()
export class XuiPanelClient implements IPanelClient {
  readonly type = 'XUI';

  private readonly logger = new Logger(XuiPanelClient.name);
  /** In-memory session cache keyed by panel id. */
  private readonly sessions = new Map<bigint, PanelSession>();

  constructor(private readonly proxy: ProxyHttpService) {}

  /** Read-only, authenticated inventory from GET /panel/api/inbounds/list. */
  async listInbounds(panel: PanelConnection): Promise<XuiInbound[]> {
    const inbounds = await this.api(
      panel,
      '/panel/api/inbounds/list',
      'GET',
      undefined,
      z.array(inboundResponseSchema),
    );
    return inbounds.map((inbound) => ({
      id: inbound.id,
      remark: inbound.remark ?? '',
      tag: inbound.tag ?? null,
      protocol: inbound.protocol,
      port: inbound.port,
      enabled: inbound.enable,
      expiryTime: inbound.expiryTime ?? null,
      clientCompatible: isFirstClassXuiProtocol(inbound.protocol),
    }));
  }

  async listClients(panel: PanelConnection): Promise<XuiClientState[]> {
    return this.api(panel, '/panel/api/clients/list', 'GET', undefined, z.array(clientStateSchema));
  }

  async listClientsPaged(panel: PanelConnection, page: number, limit: number): Promise<XuiPagedClients> {
    const query = new URLSearchParams({
      page: z.number().int().positive().parse(page).toString(),
      limit: z.number().int().positive().max(100).parse(limit).toString(),
    });
    return this.api(
      panel,
      `/panel/api/clients/list/paged?${query}`,
      'GET',
      undefined,
      z.object({ total: z.number().int().nonnegative(), items: z.array(clientStateSchema) }),
    );
  }

  async getClient(panel: PanelConnection, email: string): Promise<XuiClientState | null> {
    const safeEmail = emailSchema.parse(email);
    return this.api(panel, `/panel/api/clients/get/${encodeURIComponent(safeEmail)}`, 'GET', undefined, clientGetSchema.nullable());
  }

  async addClient(panel: PanelConnection, client: XuiClientState, inboundIds?: number[]): Promise<void> {
    const state = clientStateSchema.parse(client);
    const body = inboundIds ? { client: state, inboundIds: inboundIdsSchema.parse(inboundIds) } : { client: state };
    await this.api(panel, '/panel/api/clients/add', 'POST', body, z.unknown());
  }

  async replaceClient(panel: PanelConnection, email: string, client: XuiClientState): Promise<void> {
    const safeEmail = emailSchema.parse(email);
    const state = clientStateSchema.parse(client);
    if (state.email !== safeEmail) throw BusinessException.conflict('Client email cannot change during replacement');
    await this.api(panel, `/panel/api/clients/update/${encodeURIComponent(safeEmail)}`, 'POST', state, z.unknown());
  }

  async deleteClient(panel: PanelConnection, email: string): Promise<void> {
    await this.api(panel, `/panel/api/clients/del/${encodeURIComponent(emailSchema.parse(email))}`, 'POST', undefined, z.unknown());
  }

  async attachClient(panel: PanelConnection, email: string, inboundIds: number[]): Promise<void> {
    await this.clientAction(panel, email, 'attach', { inboundIds: inboundIdsSchema.parse(inboundIds) });
  }

  async detachClient(panel: PanelConnection, email: string, inboundIds: number[]): Promise<void> {
    await this.clientAction(panel, email, 'detach', { inboundIds: inboundIdsSchema.parse(inboundIds) });
  }

  async externalLinks(panel: PanelConnection, email: string): Promise<Record<string, unknown>> {
    return this.clientAction(panel, email, 'externalLinks', {}, z.record(z.unknown()));
  }

  async updateTraffic(panel: PanelConnection, email: string, bytes: number): Promise<void> {
    await this.clientAction(panel, email, 'updateTraffic', { totalGB: bytesSchema.parse(bytes) });
  }

  async clientIps(panel: PanelConnection, email: string): Promise<Record<string, unknown>> {
    return this.clientAction(panel, email, 'ips', {}, z.record(z.unknown()));
  }

  async clearClientIps(panel: PanelConnection, email: string): Promise<void> {
    await this.clientAction(panel, email, 'clearIps', {});
  }

  async subscriptionLinks(panel: PanelConnection, subId: string): Promise<string[]> {
    return this.api(panel, `/panel/api/clients/subLinks/${encodeURIComponent(subIdSchema.parse(subId))}`, 'GET', undefined, this.linksSchema());
  }

  async clientLinks(panel: PanelConnection, email: string): Promise<string[]> {
    return this.api(panel, `/panel/api/clients/links/${encodeURIComponent(emailSchema.parse(email))}`, 'GET', undefined, this.linksSchema());
  }

  async bulkCreate(panel: PanelConnection, clients: XuiClientState[]): Promise<XuiBulkResult> {
    return this.bulk(panel, 'bulkCreate', { clients: z.array(clientStateSchema).min(1).parse(clients) });
  }

  async bulkAdjust(panel: PanelConnection, emails: string[], trafficBytes?: number, expiryMs?: number): Promise<XuiBulkResult> {
    return this.bulk(panel, 'bulkAdjust', { emails: this.emails(emails), ...(trafficBytes === undefined ? {} : { totalGB: bytesSchema.parse(trafficBytes) }), ...(expiryMs === undefined ? {} : { expiryTime: expiryMsSchema.parse(expiryMs) }) });
  }

  async bulkEnable(panel: PanelConnection, emails: string[]): Promise<XuiBulkResult> { return this.bulk(panel, 'bulkEnable', { emails: this.emails(emails) }); }
  async bulkDisable(panel: PanelConnection, emails: string[]): Promise<XuiBulkResult> { return this.bulk(panel, 'bulkDisable', { emails: this.emails(emails) }); }
  async bulkDelete(panel: PanelConnection, emails: string[]): Promise<XuiBulkResult> { return this.bulk(panel, 'bulkDel', { emails: this.emails(emails) }); }
  async bulkAttach(panel: PanelConnection, emails: string[], inboundIds: number[]): Promise<XuiBulkResult> { return this.bulk(panel, 'bulkAttach', { emails: this.emails(emails), inboundIds: inboundIdsSchema.parse(inboundIds) }); }
  async bulkDetach(panel: PanelConnection, emails: string[], inboundIds: number[]): Promise<XuiBulkResult> { return this.bulk(panel, 'bulkDetach', { emails: this.emails(emails), inboundIds: inboundIdsSchema.parse(inboundIds) }); }
  async bulkResetTraffic(panel: PanelConnection, emails: string[]): Promise<XuiBulkResult> { return this.bulk(panel, 'bulkResetTraffic', { emails: this.emails(emails) }); }

  async listGroups(panel: PanelConnection): Promise<string[]> { return this.api(panel, '/panel/api/groups/list', 'GET', undefined, z.array(z.string())); }
  async groupEmails(panel: PanelConnection, group: string): Promise<string[]> { return this.api(panel, `/panel/api/groups/emails/${encodeURIComponent(subIdSchema.parse(group))}`, 'GET', undefined, z.array(emailSchema)); }
  async createGroup(panel: PanelConnection, group: string): Promise<void> { await this.api(panel, '/panel/api/groups/create', 'POST', { name: subIdSchema.parse(group) }, z.unknown()); }
  async renameGroup(panel: PanelConnection, group: string, name: string): Promise<void> { await this.api(panel, '/panel/api/groups/rename', 'POST', { group: subIdSchema.parse(group), name: subIdSchema.parse(name) }, z.unknown()); }
  async deleteGroup(panel: PanelConnection, group: string): Promise<void> { await this.api(panel, '/panel/api/groups/del', 'POST', { group: subIdSchema.parse(group) }, z.unknown()); }
  async bulkAddGroup(panel: PanelConnection, group: string, emails: string[]): Promise<void> { await this.api(panel, '/panel/api/groups/bulkAdd', 'POST', { group: subIdSchema.parse(group), emails: this.emails(emails) }, z.unknown()); }
  async bulkRemoveGroup(panel: PanelConnection, group: string, emails: string[]): Promise<void> { await this.api(panel, '/panel/api/groups/bulkRemove', 'POST', { group: subIdSchema.parse(group), emails: this.emails(emails) }, z.unknown()); }

  async onlines(panel: PanelConnection): Promise<Record<string, unknown>> { return this.api(panel, '/panel/api/clients/onlines', 'GET', undefined, z.record(z.unknown())); }
  async onlinesByGuid(panel: PanelConnection): Promise<Record<string, unknown>> { return this.api(panel, '/panel/api/clients/onlinesByGuid', 'GET', undefined, z.record(z.unknown())); }
  async clientIpsByGuid(panel: PanelConnection): Promise<Record<string, unknown>> { return this.api(panel, '/panel/api/clients/clientIpsByGuid', 'GET', undefined, z.record(z.unknown())); }
  async activeInbounds(panel: PanelConnection): Promise<Record<string, unknown>> { return this.api(panel, '/panel/api/clients/activeInbounds', 'GET', undefined, z.record(z.unknown())); }
  async lastOnline(panel: PanelConnection): Promise<Record<string, unknown>> { return this.api(panel, '/panel/api/clients/lastOnline', 'GET', undefined, z.record(z.unknown())); }
  async exportClients(panel: PanelConnection): Promise<Record<string, unknown>> { return this.api(panel, '/panel/api/clients/export', 'GET', undefined, z.record(z.unknown())); }

  async resetAllTraffics(panel: PanelConnection): Promise<void> { await this.api(panel, '/panel/api/clients/resetAllTraffics', 'POST', undefined, z.unknown()); }
  async deleteDepleted(panel: PanelConnection): Promise<void> { await this.api(panel, '/panel/api/clients/delDepleted', 'POST', undefined, z.unknown()); }
  async deleteOrphans(panel: PanelConnection): Promise<void> { await this.api(panel, '/panel/api/clients/delOrphans', 'POST', undefined, z.unknown()); }
  async importClients(panel: PanelConnection, payload: Record<string, unknown>): Promise<void> { await this.api(panel, '/panel/api/clients/import', 'POST', payload, z.unknown()); }

  // ---------------------------------------------------------------- IPanelClient

  async createUser(panel: PanelConnection, input: CreatePanelUserInput): Promise<PanelUser> {
    return this.createUserFromClientApi(panel, input);
  }

  /**
   * Fetch traffic counters via the dedicated /panel/api/clients/traffic/{email} endpoint.
   * Returns more accurate real-time data than getUser().
   */
  async getClientTraffic(
    panel: PanelConnection,
    email: string,
  ): Promise<{
    usedBytes: string;
    totalBytes: string;
    up: number;
    down: number;
    expiryTime: number;
    subId: string;
    uuid: string;
    enable: boolean;
  } | null> {
    const emailEncoded = encodeURIComponent(email);
    const res = await this.request<
      ThreeXuiEnvelope<{
        down: number;
        email: string;
        enable: boolean;
        expiryTime: number;
        id: number;
        inboundId: number;
        lastOnline: number;
        reset: number;
        subId: string;
        total: number;
        up: number;
        uuid: string;
      }>
    >(panel, `/panel/api/clients/traffic/${emailEncoded}`, { method: 'GET' });

    if (!res.success || !res.obj) return null;

    const obj = res.obj;
    return {
      usedBytes: String(obj.up + obj.down), // used = uplink + downlink
      totalBytes: String(obj.total), // total is the traffic limit in bytes
      up: obj.up,
      down: obj.down,
      expiryTime: obj.expiryTime,
      subId: obj.subId,
      uuid: obj.uuid,
      enable: obj.enable,
    };
  }

  async getUser(panel: PanelConnection, username: string): Promise<PanelUser | null> {
    const email = encodeURIComponent(username);
    const res = await this.request<
      ThreeXuiEnvelope<ThreeXuiClient | ThreeXuiClientGetObject | null>
    >(panel, `/panel/api/clients/get/${email}`, { method: 'GET' });
    if (!res.success || !res.obj) return null;

    // 3x-ui v3.4.x returns { obj: { client, inbound } }, while some older
    // builds return the client object directly. Support both shapes.
    const obj = res.obj as ThreeXuiClientGetObject;
    const client = obj.client ?? (res.obj as ThreeXuiClient);
    if (!client?.email) return null;

    return this.mapUser(client, obj.inbound?.id ?? client.inboundId, panel);
  }

  async updateUser(
    panel: PanelConnection,
    username: string,
    input: UpdatePanelUserInput,
  ): Promise<PanelUser> {
    return this.updateUserFromClientApi(panel, username, input);
  }

  async deleteUser(panel: PanelConnection, username: string): Promise<void> {
    const email = encodeURIComponent(username);
    const res = await this.request<ThreeXuiEnvelope<null>>(
      panel,
      `/panel/api/clients/del/${email}`,
      {
        method: 'POST',
      },
    );
    if (!res.success) {
      throw BusinessException.conflict(`3x-ui delete client failed: ${res.msg}`);
    }
  }

  async resetTraffic(panel: PanelConnection, username: string): Promise<void> {
    const email = encodeURIComponent(username);
    const res = await this.request<ThreeXuiEnvelope<null>>(
      panel,
      `/panel/api/clients/resetTraffic/${email}`,
      {
        method: 'POST',
      },
    );
    if (!res.success) {
      throw BusinessException.conflict(`3x-ui reset traffic failed: ${res.msg}`);
    }
  }

  async health(panel: PanelConnection): Promise<PanelHealth> {
    const start = Date.now();
    try {
      // Attempt the full server-status endpoint first. Current 3x-ui exposes
      // this as GET and returns detailed metrics.
      const res = await this.request<ThreeXuiEnvelope<Record<string, unknown>>>(
        panel,
        '/panel/api/server/status',
        {
          method: 'GET',
        },
      );
      if (res.success) {
        const o = res.obj ?? {};
        return {
          reachable: true,
          latencyMs: Date.now() - start,
          version: String(o.version ?? ''),
          activeUsers: this.toNumber(o.activeCount ?? o.totalClient ?? o.totalUser),
          totalUsers: this.toNumber(o.totalClient ?? o.totalUser),
          cpuUsage: this.toNumber(o.cpu),
          memoryUsage: this.toNumber(o.mem ?? o.memory),
        };
      }
      // Envelope returned success:false — fall through to liveness probe.
    } catch (err) {
      this.logger.debug(
        `server/status probe failed for panel ${panel.id}: ${(err as Error).message}`,
      );
    }

    // Fallback liveness probe: an authenticated request that every 3x-ui build
    // serves. /csrf-token always returns 200 (it is the unauthenticated CSRF
    // bootstrap) and proves the panel HTTP server is reachable + responsive.
    try {
      const probe = await this.proxy.proxyFetch(this.joinUrl(panel.baseUrl, '/csrf-token'), {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      if (probe.ok) {
        return { reachable: true, latencyMs: Date.now() - start };
      }
    } catch (err) {
      this.logger.debug(
        `csrf-token liveness probe failed for panel ${panel.id}: ${(err as Error).message}`,
      );
    }

    return { reachable: false, latencyMs: Date.now() - start };
  }

  // ---------------------------------------------------------------- internals

  /**
   * Core request method. Handles session bootstrap, CSRF header injection,
   * cookie forwarding, envelope unwrapping, and one-shot re-login on 401/403.
   */
  private async request<T>(
    panel: PanelConnection,
    path: string,
    opts: { method: string; body?: unknown },
  ): Promise<T> {
    const url = this.joinUrl(panel.baseUrl, path);

    let attempt = 0;
    // Two passes: first attempt; if 401/403, force re-login and retry once.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      attempt++;
      const session = await this.ensureSession(panel);
      const headers: Record<string, string> = {
        Accept: 'application/json',
        'X-CSRF-Token': session.csrfToken,
        Cookie: session.cookie,
      };
      let body: string | undefined;
      if (opts.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(opts.body);
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.xui.timeoutMs);
      let res: Response;
      try {
        res = await this.proxy.proxyFetch(url, {
          method: opts.method,
          headers,
          body,
          signal: controller.signal as never,
        });
      } catch (err) {
        clearTimeout(timeout);
        throw BusinessException.conflict(`3x-ui request error: ${(err as Error).message}`);
      }
      clearTimeout(timeout);

      // Auth failure → invalidate session and retry once.
      if ((res.status === 401 || res.status === 403) && attempt === 1 && opts.method === 'GET') {
        this.sessions.delete(panel.id);
        this.logger.warn(`Panel ${panel.id} returned ${res.status}; re-authenticating`);
        continue;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw BusinessException.conflict(
          `3x-ui ${path} → HTTP ${res.status}: ${text.slice(0, 200)}`,
        );
      }

      const parsed = (await res
        .json()
        .catch(() => ({ success: false, msg: 'invalid json', obj: null }))) as T;
      // Persist any refreshed Set-Cookie the panel may have returned.
      this.captureCookies(panel.id, res, session);
      return parsed;
    }
  }

  /**
   * Ensures we hold a valid session for the panel, logging in if needed.
   */
  private async ensureSession(panel: PanelConnection): Promise<PanelSession> {
    const cached = this.sessions.get(panel.id);
    // Sessions are valid for ~24h in 3x-ui; refresh conservatively at 1h.
    if (cached && Date.now() - cached.loggedInAt < 60 * 60 * 1000) {
      return cached;
    }
    return this.login(panel);
  }

  /**
   * Performs the two-step 3x-ui login:
   *   1. GET /csrf-token  → obtain CSRF token
   *   2. POST /login        → obtain session cookie
   */
  private async login(panel: PanelConnection): Promise<PanelSession> {
    const base = panel.baseUrl;
    const separator = panel.apiKey.indexOf(':');
    const storedCredentials = separator > 0
      ? { username: panel.apiKey.slice(0, separator), password: panel.apiKey.slice(separator + 1) }
      : null;
    const username = storedCredentials?.username ?? (panel.extraConfig?.username as string | undefined) ?? config.xui.username;
    const password = storedCredentials?.password ?? (panel.extraConfig?.password as string | undefined) ?? config.xui.password;

    if (!username || !password) {
      throw BusinessException.unauthorized('3x-ui panel credentials not configured');
    }

    // 1) CSRF token
    const csrfUrl = this.joinUrl(base, '/csrf-token');
    const csrfRes = await this.proxy.proxyFetch(csrfUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (!csrfRes.ok) {
      throw BusinessException.conflict(`3x-ui /csrf-token → HTTP ${csrfRes.status}`);
    }
    const csrfBody = (await csrfRes.json()) as ThreeXuiEnvelope<string>;
    if (!csrfBody.success || !csrfBody.obj) {
      throw BusinessException.conflict('3x-ui /csrf-token returned no token');
    }
    const csrfToken = csrfBody.obj;
    // Capture any cookie the panel set with the csrf response (some builds do).
    let cookie = this.parseSetCookie(csrfRes);

    // 2) Login (form-encoded)
    const loginUrl = this.joinUrl(base, '/login');
    const form = new URLSearchParams();
    form.set('username', username);
    form.set('password', password);
    const loginRes = await this.proxy.proxyFetch(loginUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-CSRF-Token': csrfToken,
        Cookie: cookie,
        Accept: 'application/json',
      },
      body: form.toString(),
    });
    if (!loginRes.ok) {
      throw BusinessException.unauthorized(`3x-ui /login → HTTP ${loginRes.status}`);
    }
    const loginBody = (await loginRes.json()) as ThreeXuiEnvelope<null>;
    if (!loginBody.success) {
      throw BusinessException.unauthorized(`3x-ui login rejected: ${loginBody.msg}`);
    }

    // Use ONLY the cookie returned by /login. Re-sending the pre-login CSRF
    // cookie before the authenticated cookie makes Go's session reader pick the
    // unauthenticated value, which turns API routes into misleading 404s/HTML.
    const sessionCookie = this.parseSetCookie(loginRes);
    if (sessionCookie) cookie = sessionCookie;

    const session: PanelSession = { cookie, csrfToken, loggedInAt: Date.now() };
    this.sessions.set(panel.id, session);
    this.logger.log(`Authenticated to 3x-ui panel ${panel.id} (${panel.name})`);
    return session;
  }

  /** Replaces the cached session cookie when the panel refreshes it. */
  private captureCookies(panelId: bigint, res: nodeFetch.Response, session: PanelSession): void {
    const fresh = this.parseSetCookie(res);
    if (fresh) {
      session.cookie = fresh;
      this.sessions.set(panelId, session);
    }
  }

  /** Extracts a flattened "name=value; name2=value2" string from Set-Cookie. */
  private parseSetCookie(res: nodeFetch.Response): string {
    try {
      const raw = res.headers.raw()['set-cookie'] as string[] | undefined;
      if (!raw || raw.length === 0) return '';
      return raw
        .map((c) => c.split(';')[0])
        .filter(Boolean)
        .join('; ');
    } catch {
      return '';
    }
  }

  /**
   * Resolves the inbound id a new client should be attached to.
   * Priority: panel.extraConfig.inboundId → first matching protocol → first inbound.
   */
  private async resolveInboundId(panel: PanelConnection, protocols?: string[]): Promise<number> {
    const explicit = panel.extraConfig?.inboundId;
    if (typeof explicit === 'number' && explicit > 0) return explicit;

    const res = await this.request<ThreeXuiEnvelope<ThreeXuiInbound[]>>(
      panel,
      '/panel/api/inbounds/list',
      {
        method: 'GET',
      },
    );
    const inbounds = res.obj ?? [];
    if (inbounds.length === 0) {
      throw BusinessException.conflict(
        '3x-ui has no inbounds configured. Create an inbound in the panel web UI before adding VPN clients.',
      );
    }
    if (protocols && protocols.length > 0) {
      const match = inbounds.find((i) => protocols.includes(i.protocol));
      if (match) return match.id;
    }
    return inbounds[0].id;
  }

  /**
   * Returns ALL enabled inbound IDs from the panel.
   * Used to attach a new client to every available inbound.
   */
  private async resolveAllInboundIds(
    panel: PanelConnection,
    protocols?: string[],
  ): Promise<number[]> {
    const explicit = panel.extraConfig?.inboundId;
    if (typeof explicit === 'number' && explicit > 0) return [explicit];

    const res = await this.request<ThreeXuiEnvelope<ThreeXuiInbound[]>>(
      panel,
      '/panel/api/inbounds/list',
      {
        method: 'GET',
      },
    );
    const inbounds = (res.obj ?? []).filter((i) => i.enable);
    if (inbounds.length === 0) return [];

    if (protocols && protocols.length > 0) {
      const matched = inbounds.filter((i) => protocols.includes(i.protocol));
      if (matched.length > 0) return matched.map((i) => i.id);
    }

    // Return ALL enabled inbounds
    return inbounds.map((i) => i.id);
  }

  // ---------------------------------------------------------------- helpers

  private async createUserFromClientApi(
    panel: PanelConnection,
    input: CreatePanelUserInput,
  ): Promise<PanelUser> {
    const totalGB = input.dataLimitBytes === null ? 0 : this.toSafeBytes(input.dataLimitBytes);
    const client: XuiClientState = {
      email: emailSchema.parse(input.username),
      enable: true,
      totalGB,
      expiryTime: input.expireMs === null ? 0 : expiryMsSchema.parse(input.expireMs),
      limitIp: z.number().int().nonnegative().parse(input.deviceLimit),
      ...(input.subId ? { subId: subIdSchema.parse(input.subId) } : {}),
      ...(input.telegramId && /^\d+$/.test(input.telegramId) && Number.isSafeInteger(Number(input.telegramId))
        ? { tgId: Number(input.telegramId) }
        : {}),
    };
    await this.addClient(panel, client, input.inboundIds);
    const created = await this.getClient(panel, client.email);
    return created ? this.toPanelUser(created, panel) : {
      uuid: '',
      username: client.email,
      status: 'active',
      usedBytes: '0',
      dataLimitBytes: client.totalGB ? String(client.totalGB) : null,
      expiryMs: client.expiryTime || null,
      subLink: '',
    };
  }

  private async updateUserFromClientApi(
    panel: PanelConnection,
    username: string,
    input: UpdatePanelUserInput,
  ): Promise<PanelUser> {
    const existing = await this.getClient(panel, username);
    if (!existing) throw BusinessException.notFound(`XUI client not found: ${username}`);
    const replacement: XuiClientState = {
      ...existing,
      enable: input.status === 'disabled' ? false : input.status === 'active' ? true : existing.enable,
      totalGB:
        input.dataLimitBytes === undefined
          ? existing.totalGB
          : input.dataLimitBytes === null
            ? 0
            : this.toSafeBytes(input.dataLimitBytes),
      expiryTime:
        input.expireMs === undefined ? existing.expiryTime : input.expireMs === null ? 0 : expiryMsSchema.parse(input.expireMs),
    };
    await this.replaceClient(panel, username, replacement);
    if (input.resetUsage) await this.resetTraffic(panel, username);
    return this.toPanelUser(replacement, panel);
  }

  private async api<T>(
    panel: PanelConnection,
    path: string,
    method: 'GET' | 'POST',
    body: Record<string, unknown> | XuiClientState | undefined,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const raw = await this.request<unknown>(panel, path, { method, body });
    const envelope = xuiEnvelopeSchema.safeParse(raw);
    if (!envelope.success) throw BusinessException.conflict('XUI returned a malformed response envelope');
    if (!envelope.data.success) {
      const message = envelope.data.msg || 'XUI rejected the request';
      if (/duplicate|already exists/i.test(message)) throw BusinessException.conflict('XUI client already exists');
      throw BusinessException.conflict(message);
    }
    const parsed = schema.safeParse(envelope.data.obj);
    if (!parsed.success) throw BusinessException.conflict('XUI returned an invalid response payload');
    return parsed.data;
  }

  private async clientAction<T = void>(
    panel: PanelConnection,
    email: string,
    action: string,
    body: Record<string, unknown>,
    schema?: z.ZodType<T>,
  ): Promise<T> {
    const resultSchema = schema ?? (z.unknown().transform(() => undefined) as unknown as z.ZodType<T>);
    return this.api(
      panel,
      `/panel/api/clients/${encodeURIComponent(emailSchema.parse(email))}/${action}`,
      'POST',
      body,
      resultSchema,
    );
  }

  private async bulk(panel: PanelConnection, action: string, body: Record<string, unknown>): Promise<XuiBulkResult> {
    return this.api(
      panel,
      `/panel/api/clients/${action}`,
      'POST',
      body,
      z.object({ created: z.array(z.string()).optional(), skipped: z.array(z.object({ email: emailSchema, reason: z.string() })).optional() }).passthrough(),
    );
  }

  private emails(emails: string[]): string[] {
    return z.array(emailSchema).min(1).parse(emails);
  }

  private linksSchema(): z.ZodType<string[]> {
    return z.union([z.array(z.string()), z.object({ links: z.array(z.string()) })]).transform((value) => Array.isArray(value) ? value : value.links) as unknown as z.ZodType<string[]>;
  }

  private toSafeBytes(value: bigint): number {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw BusinessException.conflict('XUI traffic bytes must be a safe non-negative integer');
    }
    return Number(value);
  }

  private toPanelUser(client: XuiClientState, panel: PanelConnection): PanelUser {
    const baseUrl = panel.baseUrl.replace(/\/$/, '');
    const subLink = client.subId ? `${baseUrl}/sub/${client.subId}` : '';
    return {
      uuid: client.uuid ?? '',
      username: client.email,
      status: client.enable ? 'active' : 'disabled',
      usedBytes: '0',
      dataLimitBytes: client.totalGB ? String(client.totalGB) : null,
      expiryMs: client.expiryTime || null,
      subLink,
    };
  }

  private joinUrl(base: string, path: string): string {
    return `${base.replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
  }

  private toNumber(v: unknown): number | undefined {
    if (v === null || v === undefined || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }

  /** Maps a 3x-ui client object onto our PanelUser interface. */
  private mapUser(raw: ThreeXuiClient, inboundId?: number, panel?: PanelConnection): PanelUser {
    const usedBytes = (raw.reset ?? 0) || (raw.up ?? 0) + (raw.down ?? 0);
    let status: PanelUser['status'] = 'active';
    if (!raw.enable) status = 'disabled';
    else if (raw.expiryTime > 0 && raw.expiryTime < Date.now()) status = 'expired';

    // Build subscription URL using configured subPort and subPath
    // Format: http(s)://host:subPort/subPath/subId
    const baseUrl = panel?.baseUrl ?? config.xui.baseUrl;
    const subPort = panel?.subPort ?? config.xui.subPort ?? 20596;
    const subPath = panel?.subPath ?? 'sub';

    let subLink = '';
    if (raw.subId) {
      // Extract host from baseUrl (e.g., http://1.2.3.4:2053 -> 1.2.3.4)
      const urlMatch = baseUrl.match(/^https?:\/\/([^\/:]+)(?::(\d+))?/);
      const host = urlMatch ? urlMatch[1] : new URL(baseUrl).hostname;
      const protocol = baseUrl.startsWith('https') ? 'https' : 'http';
      subLink = `${protocol}://${host}:${subPort}/${subPath}/${raw.subId}`;
    }

    return {
      uuid: String(raw.uuid ?? raw.id ?? ''),
      username: raw.email,
      status,
      usedBytes: String(usedBytes),
      dataLimitBytes: raw.totalGB ? String(raw.totalGB) : null,
      expiryMs: raw.expiryTime ? raw.expiryTime : null,
      subLink,
      onlineProtocols: inboundId ? undefined : undefined,
    };
  }
}
