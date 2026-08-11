/**
 * Status Command - Production runtime health inspection.
 */
import { BaseCommand } from './install.interface';

const { createXuiRuntimeDetector } = require('../installer/xui-runtime-detector') as {
  createXuiRuntimeDetector: () => { discover(): Promise<{ data?: any }> };
};
const { createPostgresDetector } = require('../installer/postgres-detector') as {
  createPostgresDetector: () => { discover(): Promise<{ status: string; connection?: any }> };
};
const { readCanonicalRuntime, resolveCanonicalPanel } = require('../installer/canonical-runtime') as {
  readCanonicalRuntime(options?: { cwd?: string }): { config: any; database: any };
  resolveCanonicalPanel(config: any, detection?: any): any;
};

export interface StatusOptions {
  verbose?: boolean;
}

interface ServiceStatus {
  name: string;
  status: 'online' | 'offline' | 'unknown';
  summary: string;
  details?: string;
}

export class StatusCommand extends BaseCommand {
  async execute(options: StatusOptions): Promise<void> {
    this.setExecutionMode(options);
    this.section('TAZAXY Health Status');

    const runtime = await this.loadRuntimeConfig();
    await this.reconcileXuiDrift(runtime);
    const services = await Promise.all([
      this.checkDocker(),
      this.checkCompose(),
      this.check3xui(runtime),
      this.checkDatabase(),
      this.checkRedis(),
      this.checkApplication(),
      this.checkConfiguredPorts(runtime.panel?.subscriptionPort),
    ]);

    services.forEach((service) => {
      const icon =
        service.status === 'online' ? '🟢' :
        service.status === 'offline' ? '🔴' :
        '🟡';

      console.log(`${icon} ${service.name}: ${service.summary}`);
      if (options.verbose && service.details) {
        console.log(`   ${service.details}`);
      }
    });

    const required = services.filter((item) => item.name !== 'Listener Occupancy');
    const onlineCount = required.filter((item) => item.status === 'online').length;
    console.log(`\n${onlineCount}/${required.length} required checks passing`);

    if (onlineCount === required.length) {
      this.log('Platform health checks passed.', 'success');
    } else {
      this.log('One or more platform checks need attention.', 'warn');
    }
  }

  /** One-shot host discovery plus app-container authentication; never polls. */
  private async reconcileXuiDrift(runtime: any): Promise<void> {
    const detection = await createXuiRuntimeDetector().discover();
    const data = detection.data;
    const panel = data?.panel;
    const canonical = resolveCanonicalPanel(runtime, detection);
    if (!panel?.url || !canonical.panelUrl || !canonical.subscriptionPath || !data?.installation) return;

    const diagnostics = data.diagnostics ?? [];
    const listenerCoherent = panel.listening === true && !diagnostics.some((item: { code?: string }) =>
      ['PANEL_PORT_NOT_LISTENING', 'SUBSCRIPTION_PORT_NOT_LISTENING', 'PORT_OWNED_BY_DIFFERENT_PROCESS'].includes(item.code ?? ''),
    );
    const payload = JSON.stringify({
      baseUrl: canonical.panelUrl,
      subPort: canonical.subscriptionPort,
      subPath: canonical.subscriptionPath,
      source: data.installation.kind === 'docker' ? '3x-ui-docker-settings' : '3x-ui-settings',
      observedAt: new Date().toISOString(),
      listenerCoherent,
    });
    const result = await this.execWithInput(
      this.composeCommand('exec -T app node dist/src/scripts/reconcile-xui-drift.js'),
      payload,
      { timeout: 120000 },
    );
    if (result.ok) this.log('3X-UI drift check reconciled the authenticated runtime.', 'success');
    else if (result.stderr.includes('AUTH_REQUIRED') || result.stderr.includes('login')) this.log('3X-UI credentials need re-authentication; endpoint data was retained.', 'warn');
    else this.log('3X-UI drift check could not reconcile the runtime; see status details or rerun after fixing panel connectivity.', 'warn');
  }

  private async checkDocker(): Promise<ServiceStatus> {
    const result = await this.execCommand('docker --version', { allowFailure: true });
    return {
      name: 'Docker',
      status: result.ok ? 'online' : 'offline',
      summary: result.ok ? result.stdout.trim() : 'Docker is not installed or unavailable',
      details: result.stderr.trim() || undefined,
    };
  }

  private async checkCompose(): Promise<ServiceStatus> {
    const result = await this.execCommand('docker compose version', { allowFailure: true });
    return {
      name: 'Docker Compose',
      status: result.ok ? 'online' : 'offline',
      summary: result.ok ? result.stdout.trim() : 'Docker Compose plugin is not available',
      details: result.stderr.trim() || undefined,
    };
  }

  private async check3xui(runtime: any): Promise<ServiceStatus> {
    const detection = await createXuiRuntimeDetector().discover();
    const data = detection.data;
    const canonical = resolveCanonicalPanel(runtime, detection);
    const installed = data?.installation?.kind && data.installation.kind !== 'unknown';
    return {
      name: '3X-UI',
      status: canonical.authenticated ? 'online' : installed ? 'unknown' : 'offline',
      summary: canonical.authenticated
        ? `Authenticated installer runtime configured at ${canonical.panelUrl}`
        : installed
        ? `Installation detected at ${canonical.panelUrl || 'an unresolved endpoint'}; run "tazaxy panel diagnose" for authenticated connection state`
        : '3X-UI installation was not detected',
      details: data?.diagnostics?.map((item: { code?: string }) => item.code).filter(Boolean).join(', ') || undefined,
    };
  }

  private async checkDatabase(): Promise<ServiceStatus> {
    const appProbe = await this.execCommand(
      this.composeCommand('exec -T app wget -qO- http://127.0.0.1:3000/health/ready'),
      { allowFailure: true },
    );
    const output = `${appProbe.stdout}\n${appProbe.stderr}`.trim();
    const ready = /"database"\s*:\s*\{[^}]*"status"\s*:\s*"up"/i.test(output);
    if (ready) return {
      name: 'PostgreSQL', status: 'online', summary: 'PostgreSQL is reachable from the healthy application container', details: output,
    };

    const [canonical, detection] = await Promise.all([
      Promise.resolve(readCanonicalRuntime({ cwd: this.workspaceRoot })),
      createPostgresDetector().discover(),
    ]);
    const detected = Boolean(canonical.database) || detection.status !== 'NOT_FOUND';

    return {
      name: 'PostgreSQL',
      status: detected ? 'unknown' : 'offline',
      summary: detected ? 'PostgreSQL route is configured; application-context readiness was not proven' : 'PostgreSQL was not discovered',
      details: output || undefined,
    };
  }

  private async checkRedis(): Promise<ServiceStatus> {
    const result = await this.execCommand(
      this.composeCommand('exec -T redis redis-cli ping'),
      { allowFailure: true },
    );

    const output = `${result.stdout}\n${result.stderr}`.trim();
    const ready = /^PONG$/im.test(output);

    return {
      name: 'Redis',
      status: ready ? 'online' : result.ok ? 'offline' : 'unknown',
      summary: ready ? 'Redis is responding' : 'Redis is not responding',
      details: output || undefined,
    };
  }

  private async checkApplication(): Promise<ServiceStatus> {
    const processResult = await this.execCommand(
      `${this.composeCommand('ps')} 2>/dev/null || pgrep -af "node.*dist/main.js" 2>/dev/null || pgrep -af "nest start" 2>/dev/null`,
      { allowFailure: true },
    );

    const output = `${processResult.stdout}\n${processResult.stderr}`.trim();
    const running = /Up|running|node|nest/i.test(output);

    return {
      name: 'TAZAXY Application',
      status: running ? 'online' : processResult.ok ? 'offline' : 'unknown',
      summary: running ? 'Application process/container detected' : 'Application process not detected',
      details: output || undefined,
    };
  }

  private async checkConfiguredPorts(subscriptionPort?: number): Promise<ServiceStatus> {
    const ports = [80, 443, 3000, 5432, 6379];
    if (subscriptionPort) {
      ports.push(subscriptionPort);
    }

    const statuses = await Promise.all(ports.map((port) => this.inspectPort(port)));
    const openPorts = statuses.filter((item) => item.inUse).map((item) => item.port);

    return {
      name: 'Listener Occupancy',
      status: 'unknown',
      summary: openPorts.length > 0 ? `Observed ports in use: ${openPorts.join(', ')} (occupancy is not a health check)` : 'No expected listener occupancy detected',
      details: statuses.map((item) => `${item.port}=${item.inUse ? 'used' : 'free'}`).join(', '),
    };
  }
}
