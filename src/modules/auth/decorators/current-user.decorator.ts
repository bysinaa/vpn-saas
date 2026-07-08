import { createParamDecorator, ExecutionContext, ForbiddenException } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth.types';

/**
 * Extracts the authenticated user injected by JwtAuthGuard.
 * @CurrentUser() user
 * @CurrentUser('id') userId
 */
export const CurrentUser = createParamDecorator(
  (data: keyof AuthenticatedUser | undefined, ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest();
    const user: AuthenticatedUser | undefined = req.user;
    if (!user) throw new ForbiddenException('No authenticated user');
    return data ? user![data] : user;
  },
);
