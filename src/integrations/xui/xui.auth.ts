import { Injectable, Logger } from '@nestjs/common';
import type { Response } from 'node-fetch';
import { BusinessException } from '@/common/exceptions/business.exception';
import { config } from '@/config';
import { XuiClient } from './xui.client';
import type { XuiAuthResponse, XuiSessionState } from './xui.types';

@Injectable()
export class XuiAuthService {
  private readonly logger = new Logger(XuiAuthService.name);

  private session: XuiSessionState = {
    cookie: null,
    csrfToken: null,
    expiresAt: null,
    lastLoginAt: null,
  };

  constructor(private readonly client: XuiClient) {}

  getSession(): XuiSessionState {
    return { ...this.session };
  }

  clearSession(): void {
    this.session = {
      cookie: null,
      csrfToken: null,
      expiresAt: null,
      lastLoginAt: null,
    };
  }

  async login(force = false): Promise<XuiSessionState> {
    if (!force && this.session.cookie && this.session.lastLoginAt) {
      return this.getSession();
    }

    const csrfResponse = await this.client.raw('/csrf-token', { method: 'GET' }, false);
    const csrfPayload = (await csrfResponse.json().catch(() => null)) as XuiAuthResponse<string> | null;
    const csrfToken = csrfPayload?.obj ?? null;
    const bootstrapCookie = this.extractCookie(csrfResponse) ?? '';

    const form = new URLSearchParams();
    form.set('username', config.xui.username);
    form.set('password', config.xui.password);

    const loginResponse = await this.client.raw(
      '/login',
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
          ...(bootstrapCookie ? { Cookie: bootstrapCookie } : {}),
        },
        body: form.toString(),
      },
      false,
    );

    if (!loginResponse.ok) {
      throw BusinessException.unauthorized(`3X-UI login failed with HTTP ${loginResponse.status}`);
    }

    const loginPayload = (await loginResponse.json().catch(() => null)) as XuiAuthResponse<null> | null;
    if (!loginPayload?.success) {
      throw BusinessException.unauthorized(loginPayload?.msg || '3X-UI login rejected');
    }

    const cookie = this.extractCookie(loginResponse);
    if (!cookie) {
      throw BusinessException.unauthorized('3X-UI login did not return a session cookie');
    }

    this.session = {
      cookie,
      csrfToken,
      expiresAt: Date.now() + config.xui.sessionTtlMs,
      lastLoginAt: new Date(),
    };

    this.logger.log(`Authenticated to 3X-UI panel ${this.maskUrl(config.xui.panelUrl)}`);
    return this.getSession();
  }

  async logout(): Promise<void> {
    if (!this.session.cookie) {
      this.clearSession();
      return;
    }

    try {
      await this.client.raw(
        '/logout',
        {
          method: 'POST',
          headers: this.buildAuthHeaders(),
        },
        false,
      );
    } catch {
      // best effort
    }

    this.clearSession();
  }

  async ensureSession(): Promise<XuiSessionState> {
    if (this.session.cookie && this.session.expiresAt && this.session.expiresAt > Date.now()) {
      return this.getSession();
    }

    return this.login(true);
  }

  async checkSession(): Promise<boolean> {
    if (!this.session.cookie) return false;

    try {
      const response = await this.client.raw(
        '/panel/api/inbounds/list',
        {
          method: 'GET',
          headers: this.buildAuthHeaders(),
        },
        false,
      );

      if (response.status === 401 || response.status === 403) {
        return false;
      }

      return response.ok;
    } catch {
      return false;
    }
  }

  buildAuthHeaders(): Record<string, string> {
    if (!this.session.cookie) {
      throw BusinessException.unauthorized('3X-UI session is not established');
    }

    return {
      Accept: 'application/json',
      Cookie: this.session.cookie,
      ...(this.session.csrfToken ? { 'X-CSRF-Token': this.session.csrfToken } : {}),
    };
  }

  captureResponseCookies(response: Response): void {
    const cookie = this.extractCookie(response);
    if (!cookie) return;

    this.session = {
      ...this.session,
      cookie,
      expiresAt: Date.now() + config.xui.sessionTtlMs,
    };
  }

  private extractCookie(response: Response): string | null {
    try {
      const raw = response.headers.raw()['set-cookie'] as string[] | undefined;
      if (!raw?.length) return null;
      return raw
        .map((value) => value.split(';')[0])
        .filter(Boolean)
        .join('; ');
    } catch {
      return null;
    }
  }

  private maskUrl(value: string): string {
    try {
      const url = new URL(value);
      return `${url.protocol}//${url.host}${url.pathname}`;
    } catch {
      return '***';
    }
  }
}