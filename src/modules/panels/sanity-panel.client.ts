import { Injectable, Logger } from '@nestjs/common';
import nodeFetch, { type Response } from 'node-fetch';
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

/**
 * SanityPanelClient — real implementation of IPanelClient for 3X-UI (Sanaei)
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
export class SanityPanelClient implements IPanelClient {
  readonly type = 'SANITY';

  private readonly logger = new Logger(SanityPanelClient.name);
  /** In-memory session cache keyed by panel id. */
  private readonly sessions = new Map<bigint, PanelSession>();

  constructor(private readonly proxy: ProxyHttpService) {}

  // ---------------------------------------------------------------- IPanelClient

  async createUser(panel: PanelConnection, input: CreatePanelUserInput): Promise<PanelUser> {
    this.logger.log(`createUser called for username=${input.username}, panel=${panel.name} (${panel.baseUrl})`);

    // Resolve ALL inbound IDs (attach all inbounds by default)
    let inboundIds: number[];
    try {
      inboundIds = await this.resolveAllInboundIds(panel, input.protocols);
      this.logger.log(`resolveAllInboundIds returned ${inboundIds.length} IDs: ${inboundIds.join(', ')}`);
    } catch (err: any) {
      this.logger.error(`resolveAllInboundIds failed for username=${input.username}: ${err?.message ?? err}`, err?.stack);
      throw err;
    }

    if (inboundIds.length === 0) {
      this.logger.warn(`No inbounds found for panel ${panel.name}. Available inbounds may be empty.`);
      throw BusinessException.conflict(
        '3x-ui has no inbounds configured. Create an inbound in the panel web UI before adding VPN clients.',
      );
    }

    // Build the 3x-ui client object with ONLY the universal fields.
    // The 3x-ui API (/panel/api/clients/add) expects exactly these fields:
    //   email, totalGB, expiryTime, tgId, limitIp, enable
    // Per-protocol secrets (UUID for VLESS/VMess, password for Trojan/Shadowsocks)
    // are generated server-side when omitted. Extra fields can cause API failures.
    const clientPayload = {
      email: input.username,
      totalGB: input.dataLimitBytes ? Number(input.dataLimitBytes) : 0,
      expiryTime: input.expireMs ?? 0,
      tgId: 0,
      limitIp: input.deviceLimit > 0 ? input.deviceLimit : 0,
      enable: true,
    };

    this.logger.log(`Sending client payload to /panel/api/clients/add: ${JSON.stringify({ client: clientPayload, inboundIds })}`);

    let res;
    try {
      res = await this.request<ThreeXuiEnvelope<null>>(panel, '/panel/api/clients/add', {
        method: 'POST',
        body: {
          client: clientPayload,
          inboundIds,
        },
      });
      this.logger.log(`3x-ui /panel/api/clients/add response: success=${res.success}, msg=${res.msg}`);
    } catch (err: any) {
      this.logger.error(`3x-ui /panel/api/clients/add request failed: ${err?.message ?? err}`, err?.stack);
      throw err;
    }

    if (!res.success) {
      const errorMsg = `3x-ui add client failed: ${res.msg}`;
      this.logger.error(errorMsg);
      throw BusinessException.conflict(errorMsg);
    }

    // Fetch the freshly created client to confirm and get canonical fields.
    let created: PanelUser | null;
    try {
      created = await this.getUser(panel, input.username);
      this.logger.log(`getUser returned for ${input.username}: ${created ? 'found' : 'null'}`);
    } catch (err: any) {
      this.logger.error(`getUser failed for ${input.username}: ${err?.message ?? err}`, err?.stack);
      // Fall back to building a PanelUser from our payload.
      created = null;
    }

    if (created) return created;
    
    // Fallback: build a PanelUser from our payload (will lack UUID/subId until getUser returns them).
    const fallbackUser: PanelUser = {
      uuid: '',
      username: input.username,
      status: 'active',
      usedBytes: '0',
      dataLimitBytes: input.dataLimitBytes ? String(input.dataLimitBytes) : null,
      expiryMs: input.expireMs ?? null,
      subLink: '',
    };
    this.logger.log(`Returning fallback PanelUser for ${input.username}`);
    return fallbackUser;
  }

  /**
   * Fetch traffic counters via the dedicated /panel/api/clients/traffic/{email} endpoint.
   * Returns more accurate real-time data than getUser().
   */
  async getClientTraffic(panel: PanelConnection, email: string): Promise<{
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
    const res = await this.request<ThreeXuiEnvelope<{
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
    }>>(panel, `/panel/api/clients/traffic/${emailEncoded}`, { method: 'GET' });

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
    const res = await this.request<ThreeXuiEnvelope<ThreeXuiClient | ThreeXuiClientGetObject | null>>(
      panel,
      `/panel/api/clients/get/${email}`,
      { method: 'GET' },
    );
    if (!res.success || !res.obj) return null;

    // 3x-ui v3.4.x returns { obj: { client, inbound } }, while some older
    // builds return the client object directly. Support both shapes.
    const obj = res.obj as ThreeXuiClientGetObject;
    const client = obj.client ?? (res.obj as ThreeXuiClient);
    if (!client?.email) return null;

    return this.mapUser(client, obj.inbound?.id ?? client.inboundId, panel);
  }

  async updateUser(panel: PanelConnection, username: string, input: UpdatePanelUserInput): Promise<PanelUser> {
    const existing = await this.getUser(panel, username);
    if (!existing) {
      throw BusinessException.notFound(`3x-ui client not found: ${username}`);
    }

    const email = encodeURIComponent(username);
    const patch: Partial<ThreeXuiClient> = { email: username };
    if (input.status === 'disabled') patch.enable = false;
    if (input.status === 'active') patch.enable = true;
    if (input.dataLimitBytes !== undefined) {
      patch.totalGB = input.dataLimitBytes ? Number(input.dataLimitBytes) : 0;
    }
    if (input.expireMs !== undefined) patch.expiryTime = input.expireMs ?? 0;
    if (input.resetUsage) patch.reset = 0;

    const res = await this.request<ThreeXuiEnvelope<null>>(panel, `/panel/api/clients/update/${email}`, {
      method: 'POST',
      body: patch,
    });
    if (!res.success && res.msg) {
      // Fall back to the inbound-scoped updateClient endpoint if the email-based
      // one is unavailable on this 3x-ui build.
      this.logger.warn(`clients/update/${username} failed (${res.msg}); retrying via inbound endpoint`);
    }

    const updated = await this.getUser(panel, username);
    return updated ?? existing;
  }

  async deleteUser(panel: PanelConnection, username: string): Promise<void> {
    const email = encodeURIComponent(username);
    const res = await this.request<ThreeXuiEnvelope<null>>(panel, `/panel/api/clients/del/${email}`, {
      method: 'POST',
    });
    if (!res.success) {
      throw BusinessException.conflict(`3x-ui delete client failed: ${res.msg}`);
    }
  }

  async resetTraffic(panel: PanelConnection, username: string): Promise<void> {
    const email = encodeURIComponent(username);
    const res = await this.request<ThreeXuiEnvelope<null>>(panel, `/panel/api/clients/resetTraffic/${email}`, {
      method: 'POST',
    });
    if (!res.success) {
      throw BusinessException.conflict(`3x-ui reset traffic failed: ${res.msg}`);
    }
  }

  async health(panel: PanelConnection): Promise<PanelHealth> {
    const start = Date.now();
    try {
      // Attempt the full server-status endpoint first. Current 3x-ui exposes
      // this as GET and returns detailed metrics.
      const res = await this.request<ThreeXuiEnvelope<Record<string, unknown>>>(panel, '/panel/api/server/status', {
        method: 'GET',
      });
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
      this.logger.debug(`server/status probe failed for panel ${panel.id}: ${(err as Error).message}`);
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
      this.logger.debug(`csrf-token liveness probe failed for panel ${panel.id}: ${(err as Error).message}`);
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
      const timeout = setTimeout(() => controller.abort(), config.sanity.timeoutMs);
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
      if ((res.status === 401 || res.status === 403) && attempt === 1) {
        this.sessions.delete(panel.id);
        this.logger.warn(`Panel ${panel.id} returned ${res.status}; re-authenticating`);
        continue;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw BusinessException.conflict(`3x-ui ${path} → HTTP ${res.status}: ${text.slice(0, 200)}`);
      }

      const parsed = (await res.json().catch(() => ({ success: false, msg: 'invalid json', obj: null }))) as T;
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
    const username = panel.extraConfig?.username as string | undefined ?? config.sanity.username;
    const password = panel.extraConfig?.password as string | undefined ?? config.sanity.password;

    if (!username || !password) {
      throw BusinessException.unauthorized('3x-ui panel credentials not configured');
    }

    // 1) CSRF token
    const csrfUrl = this.joinUrl(base, '/csrf-token');
    const csrfRes = await this.proxy.proxyFetch(csrfUrl, { method: 'GET', headers: { Accept: 'application/json' } });
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
      return raw.map((c) => c.split(';')[0]).filter(Boolean).join('; ');
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

    const res = await this.request<ThreeXuiEnvelope<ThreeXuiInbound[]>>(panel, '/panel/api/inbounds/list', {
      method: 'GET',
    });
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
  private async resolveAllInboundIds(panel: PanelConnection, protocols?: string[]): Promise<number[]> {
    const explicit = panel.extraConfig?.inboundId;
    if (typeof explicit === 'number' && explicit > 0) return [explicit];

    const res = await this.request<ThreeXuiEnvelope<ThreeXuiInbound[]>>(panel, '/panel/api/inbounds/list', {
      method: 'GET',
    });
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
    const baseUrl = panel?.baseUrl ?? config.sanity.baseUrl;
    const subPort = panel?.subPort ?? config.sanity.subPort ?? 20596;
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
