import type { PrismaClient } from '@prisma/client';

import { parseAllowedShopDomains } from '../commerce/admin-commerce-auth.js';
import { PrismaDsvControlRepository } from './dsv-control.repository.js';
import type { DsvControlDependencies } from '../../routes/dsv-control.routes.js';
import { isStrongAdminWebSecret, isValidAdminWebLoginSecret } from '../../routes/admin-ui-session.js';

export type DsvControlRuntimeEnv = Partial<Record<
  | 'CLEVER_ADMIN_ALLOWED_SHOP_DOMAINS'
  | 'CLEVER_ADMIN_WEB_LOGIN_SECRET'
  | 'CLEVER_ADMIN_WEB_SESSION_SECRET'
  | 'CLEVER_DSV_ADMIN_ID'
  | 'CLEVER_DSV_WEB_COOKIE_NAME',
  string
>>;

export function loadDsvControlDependencies(input: {
  env: DsvControlRuntimeEnv;
  nodeEnv: string;
  prisma: PrismaClient;
}): DsvControlDependencies | undefined {
  const loginSecret = readOptional(input.env.CLEVER_ADMIN_WEB_LOGIN_SECRET);
  const sessionSecret = readOptional(input.env.CLEVER_ADMIN_WEB_SESSION_SECRET);
  if (!isValidAdminWebLoginSecret(loginSecret) || !isStrongAdminWebSecret(sessionSecret)) return undefined;

  return {
    allowedShopDomains: parseAllowedShopDomains(input.env.CLEVER_ADMIN_ALLOWED_SHOP_DOMAINS),
    cookieName: readOptional(input.env.CLEVER_DSV_WEB_COOKIE_NAME) ?? 'clever_dsv_admin',
    loginId: readOptional(input.env.CLEVER_DSV_ADMIN_ID) ?? 'operator',
    loginSecret,
    repository: new PrismaDsvControlRepository(input.prisma),
    secureCookies: input.nodeEnv !== 'development' && input.nodeEnv !== 'test',
    sessionSecret,
  };
}

function readOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized === '' ? undefined : normalized;
}
