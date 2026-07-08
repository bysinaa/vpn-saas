import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Agent as HttpsAgent } from 'https';
import nodeFetch, { RequestInit, Response } from 'node-fetch';
import { config } from '@/config';

// socks-proxy-agent v10 ships as a pure ESM module ("type": "module").
// A CommonJS NestJS build cannot statically `require()` an ESM package, so the
// constructor is loaded via a runtime dynamic import() inside onModuleInit().
// SocksProxyAgent extends https.Agent, so the agents are typed as HttpsAgent
// (no type import from socks-proxy-agent is needed — that avoids the
// "resolution-mode" error under moduleResolution: Node16).
type SocksProxyAgentCtor = new (proxy: string) => HttpsAgent;

/**
 * ProxyHttpService
 *
 * Centralised outbound HTTP layer that routes ALL project traffic through a
 * configurable SOCKS5 (or HTTP) proxy, with an opt-out bypass list for
 * localhost / private addresses.
 *
 * Why node-fetch + socks-proxy-agent?
 *  - Node's native fetch() (undici) does not support SOCKS5 dispatchers
 *    without a custom connect hook.
 *  - node-fetch v2 supports the `agent` option which accepts any
 *    http.Agent / https.Agent — and SocksProxyAgent extends https.Agent.
 *  - Telegraf v4 uses node-fetch internally and accepts the same agent.
 *
 * Consumers should call proxyFetch() instead of global fetch() for every
 * outbound request that must leave the machine.
 */
@Injectable()
export class ProxyHttpService implements OnModuleInit {
  private readonly logger = new Logger(ProxyHttpService.name);
  private httpsAgent: HttpsAgent | undefined;
  private httpAgent: HttpsAgent | undefined;
  // Guards the one-time async agent creation so that callers that need the
  // agent before this service's onModuleInit() has run (e.g. Telegraf, which
  // is instantiated eagerly) can lazily initialise it on demand.
  private initPromise: Promise<void> | undefined;

  async onModuleInit(): Promise<void> {
    await this.ensureAgent();
  }

  /**
   * Lazily creates the SOCKS5 agent exactly once. Safe to call from any
   * provider's onModuleInit() regardless of NestJS lifecycle ordering.
   * Returns the https.Agent (or undefined when the proxy is disabled /
   * bypassed), so consumers like Telegraf can attach it immediately.
   */
  public ensureAgent(): Promise<HttpsAgent | undefined> {
    if (!this.initPromise) {
      this.initPromise = this.initAgent();
    }
    return this.initPromise.then(() => this.httpsAgent);
  }

  private async initAgent(): Promise<void> {
    if (!config.proxy.enabled) {
      this.logger.log('Outbound proxy disabled — direct connections will be used');
      return;
    }
    const url = config.proxy.url;
    try {
      // socks-proxy-agent v10 is pure ESM — load it via dynamic import() so a
      // CommonJS NestJS build can still use it at runtime.
      const mod = (await import('socks-proxy-agent')) as {
        SocksProxyAgent: SocksProxyAgentCtor;
      };
      // SocksProxyAgent handles socks5://, socks5h:// and socks:// schemes.
      // It extends https.Agent, so it is reused for both http and https targets
      // (node-fetch picks the agent based on the request URL scheme via the
      // `agent` callback below).
      this.httpsAgent = new mod.SocksProxyAgent(url);
      this.httpAgent = new mod.SocksProxyAgent(url);
      this.logger.log(`Outbound proxy enabled via ${this.maskUrl(url)} (bypass: ${config.proxy.bypass.join(',') || 'none'})`);
    } catch (err) {
      this.logger.error(`Failed to create proxy agent for "${url}": ${(err as Error).message}. Falling back to direct connections.`);
    }
  }

  /** Returns true when the target host must skip the proxy. */
  public shouldBypass(targetUrl: string): boolean {
    let host: string;
    try {
      host = new URL(targetUrl).hostname.toLowerCase();
    } catch {
      return true; // unparseable — don't risk routing through proxy
    }
    // Always bypass loopback / link-local regardless of config.
    const localhostPatterns = ['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'];
    if (localhostPatterns.includes(host)) return true;
    // Configured bypass list (supports exact host and *.suffix wildcards).
    for (const entry of config.proxy.bypass) {
      const rule = entry.toLowerCase();
      if (rule === host) return true;
      if (rule.startsWith('*.') && host.endsWith(rule.slice(1))) return true;
    }
    return false;
  }

  /**
   * Returns the proxy agent for the given URL, or undefined when the proxy is
   * disabled / the host is bypassed. Suitable for passing to node-fetch's
   * `agent` option (function form) or to Telegraf.
   */
  public getAgent(targetUrl: string): HttpsAgent | undefined {
    if (!config.proxy.enabled || !this.httpsAgent) return undefined;
    if (this.shouldBypass(targetUrl)) return undefined;
    return this.httpsAgent;
  }

  /**
   * fetch() wrapper that transparently applies the proxy agent.
   * Drop-in replacement for the native fetch signature (subset).
   */
  public async proxyFetch(url: string, init: RequestInit = {}): Promise<Response> {
    const agent = this.getAgent(url);
    if (agent) {
      init.agent = ((_url: string) => agent) as unknown as RequestInit['agent'];
    }
    return nodeFetch(url, init);
  }

  /** Exposes the underlying https.Agent for libraries that need a raw agent
   *  (e.g. Telegraf's `agent` option which expects an https.Agent). */
  public get httpsAgentInstance(): HttpsAgent | undefined {
    return this.httpsAgent as unknown as HttpsAgent | undefined;
  }

  private maskUrl(url: string): string {
    try {
      const u = new URL(url);
      return `${u.protocol}//${u.hostname}:${u.port}`;
    } catch {
      return '***';
    }
  }
}
