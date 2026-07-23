import type { PrismaClient } from '@prisma/client';
import { describe, expect, test, vi } from 'vitest';

import { loadDsvV1ReadDependencies } from '../src/modules/dsv/dsv-v1-read.dependencies.js';
import { DsvV1AuthenticationError } from '../src/routes/dsv-v1-read.routes.js';

const sessionSecret = '12345678901234567890123456789012';
const shopId = '11111111-1111-4111-8111-111111111111';
const customerId = '22222222-2222-4222-8222-222222222222';
const accountId = '33333333-3333-4333-8333-333333333333';

describe('loadDsvV1ReadDependencies', () => {
  test('uses the default DSV cookie name when no configured name is provided', () => {
    const { prisma } = createPrismaMock();

    const dependencies = loadDsvV1ReadDependencies({
      env: { CLEVER_ADMIN_WEB_SESSION_SECRET: sessionSecret },
      nodeEnv: 'test',
      prisma,
    });

    expect(dependencies?.cookieName).toBe('clever_dsv_admin');
  });

  test('uses the configured DSV cookie name when env provides one', () => {
    const { prisma } = createPrismaMock();

    const dependencies = loadDsvV1ReadDependencies({
      env: {
        CLEVER_ADMIN_WEB_SESSION_SECRET: sessionSecret,
        CLEVER_DSV_WEB_COOKIE_NAME: ' custom_dsv_cookie ',
      },
      nodeEnv: 'test',
      prisma,
    });

    expect(dependencies?.cookieName).toBe('custom_dsv_cookie');
  });

  test('fails closed when the session secret is not strong enough', () => {
    const { prisma } = createPrismaMock();

    const dependencies = loadDsvV1ReadDependencies({
      env: { CLEVER_ADMIN_WEB_SESSION_SECRET: 'too-short' },
      nodeEnv: 'test',
      prisma,
    });

    expect(dependencies).toBeUndefined();
  });
});

describe('DsvV1SessionResolver', () => {
  test('maps a valid admin subject to the canonical shop and admin principal', async () => {
    const { prisma, shop } = createPrismaMock();
    shop.findFirst.mockResolvedValueOnce({
      id: shopId,
      shopDomain: 'example.myshopify.com',
    });
    const resolver = loadResolver(prisma, {
      CLEVER_ADMIN_ALLOWED_SHOP_DOMAINS: 'example.myshopify.com',
    });

    const principal = await resolver.resolve('dsv-shop: Example.MyShopify.com ');

    expect(shop.findFirst).toHaveBeenCalledWith({
      select: { id: true, shopDomain: true },
      where: { appId: 'clever', shopDomain: 'example.myshopify.com' },
    });
    expect(principal).toMatchObject({
      principalType: 'DSV_ADMIN',
      shopDomain: 'example.myshopify.com',
      shopId,
    });
    expect(principal.scopes).toContain('dsv:session:read');
    expect(principal.scopes).toContain('dsv:dispatches:read');
  });

  test('loads an active customer account and returns exact customer scopes', async () => {
    const { customerAccount, prisma } = createPrismaMock();
    customerAccount.findUnique.mockResolvedValueOnce(customerAccountRow());
    const resolver = loadResolver(prisma);

    const principal = await resolver.resolve(`dsv-customer-account:${accountId}`);

    expect(customerAccount.findUnique).toHaveBeenCalledWith({
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
    expect(principal).toEqual({
      customerId,
      principalType: 'CUSTOMER_USER',
      scopes: ['dsv:session:read', 'dsv:customer-deliveries:read'],
      shopId,
    });
  });

  test('throws an authentication error when the customer account does not exist', async () => {
    const { customerAccount, prisma } = createPrismaMock();
    customerAccount.findUnique.mockResolvedValueOnce(null);
    const resolver = loadResolver(prisma);

    await expect(resolver.resolve(`dsv-customer-account:${accountId}`))
      .rejects.toBeInstanceOf(DsvV1AuthenticationError);
  });

  test('throws a forbidden error when the customer account is inactive', async () => {
    const { customerAccount, prisma } = createPrismaMock();
    customerAccount.findUnique.mockResolvedValueOnce(customerAccountRow({ status: 'INACTIVE' }));
    const resolver = loadResolver(prisma);

    await expect(resolver.resolve(`dsv-customer-account:${accountId}`))
      .rejects.toMatchObject({
        message: 'DSV customer account is inactive',
        name: 'DsvV1ForbiddenError',
      });
  });

  test.each([
    ['canonical shop row differs', customerAccountRow({ canonicalShopId: '44444444-4444-4444-8444-444444444444' })],
    ['canonical customer row differs', customerAccountRow({ canonicalCustomerShopId: '55555555-5555-4555-8555-555555555555' })],
  ])('throws a forbidden error when the %s', async (_caseName, account) => {
    const { customerAccount, prisma } = createPrismaMock();
    customerAccount.findUnique.mockResolvedValueOnce(account);
    const resolver = loadResolver(prisma);

    await expect(resolver.resolve(`dsv-customer-account:${accountId}`))
      .rejects.toMatchObject({
        message: 'DSV customer account scope is invalid',
        name: 'DsvV1ForbiddenError',
      });
  });

  test('throws an authentication error when the subject prefix is unknown', async () => {
    const { prisma } = createPrismaMock();
    const resolver = loadResolver(prisma);

    await expect(resolver.resolve(`dsv-driver:${accountId}`))
      .rejects.toBeInstanceOf(DsvV1AuthenticationError);
  });
});

type CustomerAccountRow = {
  customer: { id: string; shopId: string };
  customerId: string;
  id: string;
  issuer: string;
  shop: { id: string };
  shopId: string;
  status: string;
  subject: string;
};

type CustomerAccountFindUnique = (args: {
  select: {
    customer: { select: { id: true; shopId: true } };
    customerId: true;
    id: true;
    issuer: true;
    shop: { select: { id: true } };
    shopId: true;
    status: true;
    subject: true;
  };
  where: { id: string };
}) => Promise<CustomerAccountRow | null>;

type ShopFindFirst = (args: {
  select: { id: true; shopDomain: true };
  where: { appId: 'clever'; shopDomain: string };
}) => Promise<{ id: string; shopDomain: string } | null>;

function createPrismaMock(): {
  customerAccount: { findUnique: ReturnType<typeof vi.fn<CustomerAccountFindUnique>> };
  prisma: PrismaClient;
  shop: { findFirst: ReturnType<typeof vi.fn<ShopFindFirst>> };
} {
  const customerAccount = {
    findUnique: vi.fn<CustomerAccountFindUnique>(),
  };
  const shop = {
    findFirst: vi.fn<ShopFindFirst>(),
  };

  return {
    customerAccount,
    prisma: { customerAccount, shop } as unknown as PrismaClient,
    shop,
  };
}

function loadResolver(
  prisma: PrismaClient,
  env: Partial<Record<'CLEVER_ADMIN_ALLOWED_SHOP_DOMAINS', string>> = {},
) {
  const dependencies = loadDsvV1ReadDependencies({
    env: {
      ...env,
      CLEVER_ADMIN_WEB_SESSION_SECRET: sessionSecret,
    },
    nodeEnv: 'test',
    prisma,
  });
  if (dependencies === undefined) {
    throw new Error('Expected DSV v1 read dependencies to load');
  }
  return dependencies.sessionResolver;
}

function customerAccountRow(input: {
  canonicalCustomerId?: string;
  canonicalCustomerShopId?: string;
  canonicalShopId?: string;
  status?: string;
} = {}): CustomerAccountRow {
  return {
    customer: {
      id: input.canonicalCustomerId ?? customerId,
      shopId: input.canonicalCustomerShopId ?? shopId,
    },
    customerId,
    id: accountId,
    issuer: 'customer-portal',
    shop: { id: input.canonicalShopId ?? shopId },
    shopId,
    status: input.status ?? 'ACTIVE',
    subject: 'customer@example.com',
  };
}
