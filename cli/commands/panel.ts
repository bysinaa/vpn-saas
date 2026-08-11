/** Read-only 3X-UI host and application-context diagnosis. */
import { BaseCommand } from './install.interface';

const { createXuiRuntimeDetector } = require('../installer/xui-runtime-detector') as {
  createXuiRuntimeDetector: () => { discover(): Promise<{ data?: any }> };
};
const { diagnosisFailureMessage, resolveCanonicalPanel } = require('../installer/canonical-runtime') as {
  diagnosisFailureMessage(appRunning: boolean, detail?: string): string;
  resolveCanonicalPanel(config: any, detection?: any): any;
};

export interface PanelOptions {
  diagnose?: boolean;
  verbose?: boolean;
}

export class PanelCommand extends BaseCommand {
  async execute(options: PanelOptions): Promise<void> {
    this.setExecutionMode(options);
    this.section('3X-UI Panel Diagnosis');
    await this.diagnosePanel();
  }

  private async diagnosePanel(): Promise<void> {
    const runtime = await this.loadRuntimeConfig();
    const detection = await createXuiRuntimeDetector().discover();
    const data = detection.data;
    const panel = data?.panel;
    const subscription = data?.subscription;
    const diagnostics = data?.diagnostics ?? [];
    const canonical = resolveCanonicalPanel(runtime, detection);
    const listenerCoherent = panel?.listening === true && !diagnostics.some((item: { code?: string }) =>
      ['PANEL_PORT_NOT_LISTENING', 'SUBSCRIPTION_PORT_NOT_LISTENING', 'PORT_OWNED_BY_DIFFERENT_PROCESS'].includes(item.code ?? ''),
    );

    console.log(`Installation detection: ${data?.installation?.kind && data.installation.kind !== 'unknown' ? `DETECTED (${data.installation.kind})` : 'NOT_FOUND'}`);
    console.log(`DB detection: ${data?.database?.path || data?.database?.dsn ? `DETECTED (${data.database.backend})` : 'NOT_FOUND'}`);
    console.log(`Host-local panel probe: ${canonical.hostProbePanelUrl || 'unknown'}`);
    console.log(`Panel endpoint (app context): ${canonical.panelUrl || 'unknown'}`);
    console.log(`Host-local subscription probe: ${canonical.hostProbeSubscriptionUrl || 'unknown'}`);
    console.log(`Subscription endpoint (app context): ${canonical.subscriptionUrl || 'unknown'}`);
    console.log(`Listeners: panel=${panel?.listening === true ? 'LISTENING' : 'NOT_LISTENING'}, subscription=${subscription?.listening === true ? 'LISTENING' : 'NOT_LISTENING'}, coherent=${listenerCoherent ? 'yes' : 'no'}`);

    const payload = JSON.stringify({
      baseUrl: canonical.panelUrl,
      subPort: canonical.subscriptionPort,
      subPath: canonical.subscriptionPath,
      source: data?.installation?.kind === 'docker' ? '3x-ui-docker-settings' : '3x-ui-settings',
      observedAt: new Date().toISOString(),
      listenerCoherent,
      hostDetected: Boolean(panel?.url),
    });
    const result = await this.execWithInput(
      this.composeCommand('exec -T app node dist/src/scripts/diagnose-xui.js'),
      payload,
      { timeout: 120000 },
    );
    if (!result.ok) {
      const app = await this.execCommand(
        this.composeCommand('ps --status running --services'),
        { allowFailure: true },
      );
      const appRunning = app.ok && app.stdout.split(/\r?\n/).some((service) => service.trim() === 'app');
      console.log(`Authentication: ${canonical.authenticated ? 'INSTALLER_VERIFIED' : 'NOT_VERIFIED'}`);
      console.log('Authenticated API/inbound probe: FAILED');
      console.log('Application-context connectivity: FAILED');
      this.log(diagnosisFailureMessage(appRunning, result.stderr.trim().slice(0, 200)), 'warn');
      return;
    }

    const line = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
    const diagnosis = line ? JSON.parse(line) as any : null;
    if (!diagnosis) throw new Error('App-container diagnosis returned no result');
    console.log(`Authentication: ${diagnosis.authentication}`);
    console.log(`Authenticated API/inbound probe: ${diagnosis.apiProbe ? 'PASS' : 'FAIL'}`);
    console.log(`Inbounds: discovered=${diagnosis.inbounds.discovered}, enabled=${diagnosis.inbounds.enabled}, eligible=${diagnosis.inbounds.eligible}`);
    console.log(`Reconciliation: VpnPanel=${diagnosis.reconciliation.vpnPanel ? 'present' : 'missing'}, Server=${diagnosis.reconciliation.serverCount}, InboundConfig=${diagnosis.reconciliation.inboundConfigCount}`);
    console.log(`Application-context connectivity: ${diagnosis.applicationConnectivity ? 'PASS' : 'FAIL'}`);
    console.log(`Drift: ${diagnosis.drift.classification}; stored health=${diagnosis.panel?.healthStatus || 'N/A'}, sync=${diagnosis.panel?.syncStatus || 'N/A'}`);
    console.log(`Connection state: ${diagnosis.state}`);
  }
}
