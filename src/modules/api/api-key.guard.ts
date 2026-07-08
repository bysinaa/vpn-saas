import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiKeyService } from './api.service';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';
/** Minimal request shape (avoids a hard dependency on @types/express). */
interface HttpRequest {
  headers: Record<string, string | string[] | undefined>;
  [key: string]: unknown;
}

/**
 * ApiKeyGuard - authenticates requests using the `X-API-Key` header.
 *
 * Can be used as an alternative to JwtAuthGuard for programmatic clients.
 * When combined with the PermissionsGuard, scopes from the API key are
 * treated as permissions.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyGuard.name);

  constructor(
    private readonly apiKeys: ApiKeyService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<HttpRequest>();
    const rawKey = request.headers['x-api-key'] as string | undefined;
    if (!rawKey) {
      throw new UnauthorizedException('Missing X-API-Key header');
    }

    const result = await this.apiKeys.validate(rawKey);
    if (!result) {
      throw new UnauthorizedException('Invalid or expired API key');
    }

    // Attach the authenticated API user to the request for downstream guards
    (request as any).user = {
      id: result.userId,
      role: 'API_CLIENT',
      permissions: result.scopes,
    };
    return true;
  }
}
