import { Module } from '@nestjs/common';
import { PrismaService } from '@/common/prisma/prisma.service';
import { ProxyHttpService } from '@/common/proxy/proxy-http.service';
import { XuiClient } from './xui.client';
import { XuiAuthService } from './xui.auth';
import { XuiService } from './xui.service';
import { XuiController } from './xui.controller';

@Module({
  controllers: [XuiController],
  providers: [PrismaService, ProxyHttpService, XuiClient, XuiAuthService, XuiService],
  exports: [XuiService],
})
export class XuiModule {}