import { Module } from '@nestjs/common';
import { PanelsService } from './panels.service';
import { PanelsController } from './panels.controller';
import { XuiPanelClient } from './xui-panel.client';
import { PanelInboundsService } from './panel-inbounds.service';
import { PanelInstallerService } from './panel-installer.service';
import { PANEL_CLIENTS, type IPanelClient } from './panel-client.interface';

/**
 * Builds the panel client lookup map keyed by panel type code.
 */
function buildPanelClientMap(clients: IPanelClient[]): Map<string, IPanelClient> {
  const map = new Map<string, IPanelClient>();
  for (const c of clients) map.set(c.type, c);
  return map;
}

@Module({
  controllers: [PanelsController],
  providers: [
    XuiPanelClient,
    {
      provide: PANEL_CLIENTS,
      inject: [XuiPanelClient],
      useFactory: (xui: XuiPanelClient) => buildPanelClientMap([xui]),
    },
    PanelsService,
    PanelInboundsService,
    PanelInstallerService,
  ],
  exports: [PanelsService, PanelInboundsService, PanelInstallerService],
})
export class PanelsModule {}
