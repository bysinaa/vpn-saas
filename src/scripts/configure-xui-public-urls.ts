import { NestFactory } from '@nestjs/core';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/common/prisma/prisma.service';

process.env.TAZAXY_CLI_CONTEXT = '1';

type Input = { panelUrl: string; subscriptionBaseUrl: string };

async function readInput(): Promise<Input> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Input;
  for (const value of [input.panelUrl, input.subscriptionBaseUrl]) {
    const url = new URL(value);
    if (url.protocol !== 'https:') throw new Error('Public XUI URLs must use HTTPS');
  }
  return input;
}

async function main(): Promise<void> {
  const input = await readInput();
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const prisma = app.get(PrismaService);
    const panel = await prisma.vpnPanel.findFirst({
      where: { type: 'XUI' },
      orderBy: { createdAt: 'asc' },
    });
    if (!panel) throw new Error('No XUI panel is registered');
    const metadata = {
      ...((panel.metadata as Record<string, unknown>) ?? {}),
      publicPanelUrl: input.panelUrl,
      publicSubscriptionBaseUrl: input.subscriptionBaseUrl,
    };
    await prisma.$transaction(async (tx) => {
      await tx.vpnPanel.update({ where: { id: panel.id }, data: { metadata } });
      const users = await tx.vpnUser.findMany({
        where: { panelId: panel.id, subToken: { not: null } },
        select: { id: true, subscriptionId: true, subToken: true },
      });
      for (const user of users) {
        const path = (panel.subPath || 'sub').replace(/^\/+|\/+$/g, '');
        const link = `${input.subscriptionBaseUrl.replace(/\/+$/, '')}/${path}/${encodeURIComponent(user.subToken!)}`;
        await tx.vpnUser.update({ where: { id: user.id }, data: { subLink: link } });
        if (user.subscriptionId)
          await tx.subscription.update({
            where: { id: user.subscriptionId },
            data: { subscriptionLink: link },
          });
      }
    });
    process.stdout.write(
      `${JSON.stringify({ panelUrl: input.panelUrl, subscriptionBaseUrl: input.subscriptionBaseUrl })}\n`,
    );
  } finally {
    await app.close();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Public XUI URL configuration failed'}\n`,
  );
  process.exitCode = 1;
});
