import { Module } from '@nestjs/common';
import { PanelsService } from './panels.service';
import { PanelsController } from './panels.controller';
import { ThreeXuiPanelClient } from './sanity-panel.client';
import {
  PANEL_CLIENTS,
  type IPanelClient,
} from './panel-client.interface';

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
    ThreeXuiPanelClient,
    {
      provide: PANEL_CLIENTS,
      inject: [ThreeXuiPanelClient],
      useFactory: (threeXui: ThreeXuiPanelClient) =>
        buildPanelClientMap([threeXui]),
    },
    PanelsService,
  ],
  exports: [PanelsService],
})
export class PanelsModule {}
