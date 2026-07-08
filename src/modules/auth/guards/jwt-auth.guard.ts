import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { AuthService } from '../auth.service';
import { JwtTokenService } from '../jwt-token.service';
import { AuthenticatedUser } from '../auth.types';

/**
 * JWT auth guard. Extracts Bearer token, verifies it, and attaches the
 * authenticated user to the request. Supports @Public() opt-out.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: JwtTokenService,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest();
    const authHeader: string | undefined = req.headers?.authorization;
    const token = this.extractToken(authHeader);
    if (!token) throw new UnauthorizedException('Missing access token');

    let payload;
    try {
      payload = await this.tokens.verifyAccess(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
    if (payload.type !== 'access') {
      throw new UnauthorizedException('Invalid token type');
    }

    const status = await this.auth.getStatus(BigInt(payload.sub));
    if (status && status !== 'ACTIVE') {
      throw new UnauthorizedException('Account is not active');
    }

    const permissions = await this.auth.getPermissions(BigInt(payload.sub));

    const user: AuthenticatedUser = {
      id: BigInt(payload.sub),
      publicId: payload.publicId,
      role: payload.role,
      email: payload.email,
      telegramId: payload.telegramId,
      permissions,
    };
    req.user = user;
    return true;
  }

  private extractToken(header?: string): string | null {
    if (!header) return null;
    const [type, token] = header.split(' ');
    if (type?.toLowerCase() !== 'bearer' || !token) return null;
    return token;
  }
}
