import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { config } from '@/config';
import { HealthService } from './health.service';

@ApiTags('Health')
@Controller(config.monitoring.healthPath)
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  @ApiOperation({ summary: 'Liveness probe' })
  liveness() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe (checks DB + Redis)' })
  readiness() {
    return this.health.checkReadiness();
  }
}
