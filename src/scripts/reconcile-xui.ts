import { NestFactory } from '@nestjs/core';
import { AppModule } from '@/app.module';
import { PanelInstallerService, type XuiInstallerConnection } from '@/modules/panels/panel-installer.service';

process.env.TAZAXY_CLI_CONTEXT = '1';

async function readInput(): Promise<XuiInstallerConnection> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as XuiInstallerConnection;
  if (!input.baseUrl || !input.username || !input.password || !input.subPath) throw new Error('Incomplete XUI reconciliation input');
  return input;
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const result = await app.get(PanelInstallerService).reconcileXui(await readInput());
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await app.close();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'XUI reconciliation failed'}\n`);
  process.exitCode = 1;
});
