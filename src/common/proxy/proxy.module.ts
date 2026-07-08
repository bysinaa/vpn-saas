import { Global, Module } from '@nestjs/common';
import { ProxyHttpService } from './proxy-http.service';

/**
 * ProxyModule — global provider of the centralised SOCKS5/HTTP outbound proxy.
 *
 * Imported once in AppModule alongside the other @Global() infrastructure
 * modules so that any feature service can inject ProxyHttpService.
 */
@Global()
@Module({
  providers: [ProxyHttpService],
  exports: [ProxyHttpService],
})
export class ProxyModule {}
