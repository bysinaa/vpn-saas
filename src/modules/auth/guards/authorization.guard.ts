import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ForbiddenException,
} from '@nestjs/common';
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
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest();
    const user: AuthenticatedUser | undefined = req.user;
    if (!user) throw new ForbiddenException('Authentication required');

    if (user.role === 'SUPER_ADMIN') return true;

    // Roles
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (requiredRoles && requiredRoles.length > 0) {
      if (!requiredRoles.includes(user.role)) {
        throw new ForbiddenException('Insufficient role');
      }
    }

    // Permissions
    const permMeta = this.reflector.getAllAndOverride<{
      permissions: string[];
      requireAll: boolean;
    }>(PERMISSIONS_KEY, [context.getHandler(), context.getClass()]);
    if (permMeta && permMeta.permissions.length > 0) {
      const userPerms = user.permissions ?? [];
      const satisfied = permMeta.requireAll
        ? permMeta.permissions.every((p) => this.hasPermission(userPerms, p))
        : permMeta.permissions.some((p) => this.hasPermission(userPerms, p));
      if (!satisfied) throw new ForbiddenException('Insufficient permissions');
    }
    return true;
  }

  private hasPermission(perms: string[], required: string): boolean {
    if (perms.includes('*')) return true;
    if (perms.includes(required)) return true;
    // wildcard resource: "*:read" matches "read:anything"
    const [action, resource] = required.split(':');
    return perms.includes(`*: ${resource}`) || perms.includes(`${action}:*`);
  }
}
