import { Injectable } from '@nestjs/common';
import type { RequestInit, Response } from 'node-fetch';
import { BusinessException } from '@/common/exceptions/business.exception';
import { ProxyHttpService } from '@/common/proxy/proxy-http.service';
import { config } from '@/config';

@Injectable()
export class XuiClient {
  constructor(private readonly proxy: ProxyHttpService) {}

  async raw(path: string, init: RequestInit = {}, allowRedirect = true): Promise<Response> {
    const response = await this.proxy.proxyFetch(this.buildUrl(path), {
      ...init,
      redirect: allowRedirect ? 'follow' : 'manual',
    });

    return response;
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.raw(path, init);

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw BusinessException.conflict(`3X-UI request failed (${response.status}): ${body.slice(0, 200)}`);
    }

    return (await response.json()) as T;
  }

  buildUrl(path: string): string {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return `${config.xui.panelUrl.replace(/\/$/, '')}${normalizedPath}`;
  }
}