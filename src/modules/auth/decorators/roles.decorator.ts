import { SetMetadata } from '@nestjs/common';
import type { UserRole } from '@prisma/client';

export const ROLES_KEY = 'roles';

/** Restrict access to specific roles. @Roles('ADMIN','SUPER_ADMIN') */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
