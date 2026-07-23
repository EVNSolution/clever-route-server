import type { PrismaClient } from '@prisma/client';

import { canAccessShopDomain, parseAllowedShopDomains } from '../commerce/admin-commerce-auth.js';
import type { AdminCommerceActor } from '../commerce/admin-commerce-auth.js';
import {
  createDsvAdminPrincipal,
  createDsvCustomerUserPrincipalFromAccount,
} from './dsv-principal.js';
import type { DsvPrincipal } from './dsv-principal.js';
import {
  PrismaDsvV1ReadQueryService,
  type DsvV1ReadQueryService,
} from './dsv-v1-read-query.service.js';
import type {
  DsvV1ReadDependencies,
  DsvV1SessionResolver,
} from '../../routes/dsv-v1-read.routes.js';
import {
  DsvV1AuthenticationError,
  DsvV1ForbiddenError,
} from '../../routes/dsv-v1-read.routes.js';
import { isStrongAdminWebSecret } from '../../routes/admin-ui-session.js';

const adminSubjectPrefix = 'dsv-shop:';
const customerSubjectPrefix = 'dsv-customer-account:';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type DsvV1ReadRuntimeEnv = Partial<Record<
  | 'CLEVER_ADMIN_ALLOWED_SHOP_DOMAINS'
  | 'CLEVER_ADMIN_WEB_SESSION_SECRET'
  | 'CLEVER_DSV_WEB_COOKIE_NAME',
  string
>>;

export function loadDsvV1ReadDependencies(input: {
  env: DsvV1ReadRuntimeEnv;
  nodeEnv: string;
  prisma: PrismaClient;
  queryService?: DsvV1ReadQueryService;
}): DsvV1ReadDependencies | undefined {
  const sessionSecret = readOptional(input.env.CLEVER_ADMIN_WEB_SESSION_SECRET);
  if (!isStrongAdminWebSecret(sessionSecret)) return undefined;
  return {
    cookieName: readOptional(input.env.CLEVER_DSV_WEB_COOKIE_NAME) ?? 'clever_dsv_admin',
    queryService: input.queryService ?? new PrismaDsvV1ReadQueryService(input.prisma),
    secureCookies: input.nodeEnv !== 'development' && input.nodeEnv !== 'test',
    sessionResolver: new PrismaDsvV1SessionResolver({
      allowedShopDomains: parseAllowedShopDomains(input.env.CLEVER_ADMIN_ALLOWED_SHOP_DOMAINS),
      prisma: input.prisma,
    }),
    sessionSecret,
  };
}

class PrismaDsvV1SessionResolver implements DsvV1SessionResolver {
  private readonly allowedShopDomains: AdminCommerceActor['allowedShopDomains'];
  private readonly prisma: PrismaClient;

  constructor(input: { allowedShopDomains: AdminCommerceActor['allowedShopDomains']; prisma: PrismaClient }) {
    this.allowedShopDomains = input.allowedShopDomains;
    this.prisma = input.prisma;
  }

  async resolve(subject: string): Promise<DsvPrincipal> {
    if (subject.startsWith(adminSubjectPrefix)) {
      return this.resolveAdmin(subject.slice(adminSubjectPrefix.length));
    }
    if (subject.startsWith(customerSubjectPrefix)) {
      return this.resolveCustomer(subject.slice(customerSubjectPrefix.length));
    }
    throw new DsvV1AuthenticationError();
  }

  private async resolveAdmin(rawShopDomain: string): Promise<DsvPrincipal> {
    const shopDomain = normalizeShopDomain(rawShopDomain);
    if (shopDomain === null || !this.canAccessShopDomain(shopDomain)) throw new DsvV1AuthenticationError();
    const shop = await this.prisma.shop.findFirst({
      select: { id: true, shopDomain: true },
      where: { appId: 'clever', shopDomain },
    });
    if (shop === null) throw new DsvV1AuthenticationError();
    return createDsvAdminPrincipal({ shopDomain: shop.shopDomain, shopId: shop.id });
  }

  private async resolveCustomer(accountId: string): Promise<DsvPrincipal> {
    if (!uuidPattern.test(accountId)) throw new DsvV1AuthenticationError();
    const account = await this.prisma.customerAccount.findUnique({
      select: {
        customer: { select: { id: true, shopId: true } },
        customerId: true,
        id: true,
        issuer: true,
        shop: { select: { id: true } },
        shopId: true,
        status: true,
        subject: true,
      },
      where: { id: accountId },
    });
    if (account === null) throw new DsvV1AuthenticationError();
    if (account.status !== 'ACTIVE') throw new DsvV1ForbiddenError('DSV customer account is inactive');
    if (account.shop.id !== account.shopId || account.customer.id !== account.customerId || account.customer.shopId !== account.shopId) {
      throw new DsvV1ForbiddenError('DSV customer account scope is invalid');
    }
    return createDsvCustomerUserPrincipalFromAccount({ account });
  }

  private canAccessShopDomain(shopDomain: string): boolean {
    return canAccessShopDomain({ allowedShopDomains: this.allowedShopDomains, subject: 'dsv-v1-session' }, shopDomain);
  }
}

function normalizeShopDomain(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return normalized === '' ? null : normalized;
}

function readOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized === '' ? undefined : normalized;
}
