import { Injectable, Logger } from '@nestjs/common';

// VpnProcessor: BullMQ disabled (Redis 3.0 incompatible).
// VPN operations are now handled directly via PanelsService.
// This file is kept as a stub to avoid import errors elsewhere.

/**
 * @deprecated BullMQ processor disabled. Use PanelsService directly.
 */
@Injectable()
export class VpnProcessor {
  private readonly logger = new Logger(VpnProcessor.name);
}