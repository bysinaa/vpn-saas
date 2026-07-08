import { SetMetadata } from '@nestjs/common';

export const PERMISSIONS_KEY = 'permissions';

/**
 * Require specific permission strings (e.g. "read:users").
 * Multiple permissions are treated as ALL-required (AND).
 * Pass { requireAll: false } as second arg for OR semantics.
 */
export const RequirePermissions = (
  permissions: string[],
  opts: { requireAll?: boolean } = {},
) =>
  SetMetadata(PERMISSIONS_KEY, {
    permissions,
    requireAll: opts.requireAll ?? true,
  });
