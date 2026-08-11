import { NestFactory } from '@nestjs/core';
import { AppModule } from '@/app.module';
import { PanelInstallerService, type XuiDriftObservation } from '@/modules/panels/panel-installer.service';

process.env.TAZAXY_CLI_CONTEXT = '1';

async function readInput(): Promise<XuiDriftObservation> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as XuiDriftObservation;
  if (!input.baseUrl || !input.subPath || !input.source || !input.observedAt || typeof input.listenerCoherent !== 'boolean') {
    throw new Error('Incomplete XUI diagnostic observation');
  }
  return input;
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    process.stdout.write(`${JSON.stringify(await app.get(PanelInstallerService).diagnoseXui(await readInput()))}\n`);
  } finally {
    await app.close();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'XUI diagnosis failed'}\n`);
  process.exitCode = 1;
});
