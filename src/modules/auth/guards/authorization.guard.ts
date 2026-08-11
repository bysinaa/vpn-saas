import { CanActivate, ExecutionContext, Injectable, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';
import type { AuthenticatedUser } from '../auth.types';
import type { UserRole } from '@prisma/client';

/**
 * Composite authorization guard enforcing both role and permission metadata.
 * SUPER_ADMIN short-circuits and always passes.
 * Respects @Public() so public routes (login/register/refresh) are not blocked.
 */
@Injectable()
export class AuthorizationGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Public routes bypass authorization
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest();
    const user = req.user as AuthenticatedUser | undefined;
    if (!user) throw new ForbiddenException('Authentication required');

    // SUPER_ADMIN bypasses all checks
    if (user.role === 'SUPER_ADMIN') return true;

    // Role check (simple and direct)
    const roles = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (roles?.length) {
      if (!roles.includes(user.role)) throw new ForbiddenException('Insufficient role');
    }

    // Permission check (keep it straightforward)
    const meta = this.reflector.getAllAndOverride<{ permissions: string[]; requireAll: boolean }>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (meta?.permissions?.length) {
      const userPerms = user.permissions ?? [];
      const ok = meta.requireAll
        ? meta.permissions.every((p) => this.hasPermission(userPerms, p))
        : meta.permissions.some((p) => this.hasPermission(userPerms, p));
      if (!ok) throw new ForbiddenException('Insufficient permissions');
    }

    return true;
  }

  private hasPermission(perms: string[], required: string): boolean {
    if (!required) return false;

    // fast path: full wildcard or exact match
    if (perms.includes('*')) return true;
    if (perms.includes(required)) return true;

    // split safely and handle simple wildcards without extra dependencies
    const [action = '', resource = ''] = required.split(':');

    for (const p of perms) {
      const perm = p.trim();
      if (perm === `*:${resource}`) return true;
      if (perm === `${action}:*`) return true;
    }

    return false;
  }
}
