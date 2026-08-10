import type { PrismaClient } from '@prisma/client';
import { describe, expect, test, vi } from 'vitest';

import { loadDsvV1ReadDependencies } from '../src/modules/dsv/dsv-v1-read.dependencies.js';
import { createDsvAdminSessionSubject } from '../src/modules/dsv/dsv-admin-session-subject.js';
import { dsvAdminScopes } from '../src/modules/dsv/dsv-principal.js';
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

  test('keeps DSV v1 read disabled in production until explicitly enabled', () => {
    const { prisma } = createPrismaMock();

    expect(loadDsvV1ReadDependencies({
      env: {
        CLEVER_ADMIN_ALLOWED_SHOP_DOMAINS: 'example.myshopify.com',
        CLEVER_ADMIN_WEB_SESSION_SECRET: sessionSecret,
      },
      nodeEnv: 'production',
      prisma,
    })).toBeUndefined();
  });

  test.each([
    ['missing session secret', 'CLEVER_ADMIN_WEB_SESSION_SECRET', undefined, 'CLEVER_ADMIN_WEB_SESSION_SECRET'],
    ['empty tenant allowlist', 'CLEVER_ADMIN_ALLOWED_SHOP_DOMAINS', '', 'CLEVER_ADMIN_ALLOWED_SHOP_DOMAINS'],
    ['wildcard tenant allowlist', 'CLEVER_ADMIN_ALLOWED_SHOP_DOMAINS', '*', 'CLEVER_ADMIN_ALLOWED_SHOP_DOMAINS'],
  ] as const)('throws a clear production configuration error for %s', (_caseName, key, value, messagePart) => {
    const { prisma } = createPrismaMock();
    const env: Record<string, string> = {
      CLEVER_ADMIN_ALLOWED_SHOP_DOMAINS: 'example.myshopify.com',
      CLEVER_ADMIN_WEB_SESSION_SECRET: sessionSecret,
      CLEVER_DSV_ENABLED: 'true',
    };
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }

    expect(() => loadDsvV1ReadDependencies({
      env,
      nodeEnv: 'production',
      prisma,
    })).toThrow(messagePart);
  });

  test('loads DSV v1 read in production with explicit enabled flag and tenant allowlist', () => {
    const { prisma } = createPrismaMock();

    const dependencies = loadDsvV1ReadDependencies({
      env: {
        CLEVER_ADMIN_ALLOWED_SHOP_DOMAINS: 'example.myshopify.com',
        CLEVER_ADMIN_WEB_SESSION_SECRET: sessionSecret,
        CLEVER_DSV_ENABLED: 'true',
      },
      nodeEnv: 'production',
      prisma,
    });

    expect(dependencies).toMatchObject({
      cookieName: 'clever_dsv_admin',
      secureCookies: true,
    });
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

  test('loads a strict DSV map profile from DSV-specific env', () => {
    const { prisma } = createPrismaMock();

    const dependencies = loadDsvV1ReadDependencies({
      env: {
        ...validDsvMapProfileEnv(),
        CLEVER_ADMIN_WEB_SESSION_SECRET: sessionSecret,
      },
      nodeEnv: 'test',
      prisma,
    });

    expect(dependencies?.mapProfile).toEqual({
      attribution: 'OpenFreeMap © OpenMapTiles Data from OpenStreetMap',
      bounds: [124.5, 33, 132, 39.5],
      initialView: { center: [126.995, 37.43], zoom: 10.35 },
      profileId: 'dsv-korea-v1',
      providerMode: 'public_allowlisted',
      regionCode: 'KR',
      styleUrl: '/map/styles/dsv-korea-v1.json',
      version: '2026-07',
    });
  });

  test.each([
    ['missing profile id', { DSV_MAP_PROFILE_ID: '' }],
    ['invalid provider mode', { DSV_MAP_PROVIDER_MODE: 'disabled' }],
    ['public style without allowlisted host', {
      DSV_MAP_ALLOWED_HOSTS: 'tiles.example.com',
      DSV_MAP_PROVIDER_MODE: 'public_allowlisted',
      DSV_MAP_STYLE_URL: 'https://tiles.other.example/styles/dsv.json',
    }],
    ['public style over insecure HTTP', {
      DSV_MAP_ALLOWED_HOSTS: 'tiles.openfreemap.org',
      DSV_MAP_PROVIDER_MODE: 'public_allowlisted',
      DSV_MAP_STYLE_URL: 'http://tiles.openfreemap.org/styles/dsv.json',
    }],
    ['public root-relative style without approved external asset hosts', { DSV_MAP_ALLOWED_HOSTS: '' }],
    ['self-hosted external style', { DSV_MAP_STYLE_URL: 'https://tiles.example.com/styles/dsv.json' }],
    ['out-of-range bounds', { DSV_MAP_BOUNDS: '124.5,33,181,39' }],
    ['reversed bounds', { DSV_MAP_BOUNDS: '132,33,124.5,39' }],
    ['center outside bounds', { DSV_MAP_INITIAL_CENTER: '140,37.5665' }],
    ['invalid zoom', { DSV_MAP_INITIAL_ZOOM: '25' }],
  ])('omits DSV map profile for invalid env: %s', (_caseName, override) => {
    const { prisma } = createPrismaMock();

    const dependencies = loadDsvV1ReadDependencies({
      env: {
        ...validDsvMapProfileEnv(),
        ...override,
        CLEVER_ADMIN_WEB_SESSION_SECRET: sessionSecret,
      },
      nodeEnv: 'test',
      prisma,
    });

    expect(dependencies?.mapProfile).toBeUndefined();
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

function validDsvMapProfileEnv(): Record<string, string> {
  return {
    DSV_MAP_ATTRIBUTION: 'OpenFreeMap © OpenMapTiles Data from OpenStreetMap',
    DSV_MAP_BOUNDS: '124.5,33,132,39.5',
    DSV_MAP_INITIAL_CENTER: '126.995,37.43',
    DSV_MAP_INITIAL_ZOOM: '10.35',
    DSV_MAP_ALLOWED_HOSTS: 'tiles.openfreemap.org',
    DSV_MAP_PROFILE_ID: 'dsv-korea-v1',
    DSV_MAP_PROVIDER_MODE: 'public_allowlisted',
    DSV_MAP_REGION_CODE: 'KR',
    DSV_MAP_STYLE_URL: '/map/styles/dsv-korea-v1.json',
    DSV_MAP_VERSION: '2026-07',
  };
}

describe('DsvV1SessionResolver', () => {
  test('resolves an active personal administrator account session', async () => {
    const { dsvAdminAccount, prisma, shop } = createPrismaMock();
    shop.findFirst.mockResolvedValueOnce({ id: shopId, shopDomain: 'example.myshopify.com' });
    dsvAdminAccount.findFirst.mockResolvedValueOnce({
      displayName: '운영 관리자',
      id: accountId,
      scopes: [...dsvAdminScopes],
      tokenVersion: 3,
    });
    const resolver = loadResolver(prisma, {
      CLEVER_ADMIN_ALLOWED_SHOP_DOMAINS: 'example.myshopify.com',
    });

    const principal = await resolver.resolve(createDsvAdminSessionSubject({
      accountId,
      shopDomain: 'example.myshopify.com',
      tokenVersion: 3,
    }));

    expect(principal).toMatchObject({
      actorId: accountId,
      displayName: '운영 관리자',
      principalType: 'DSV_ADMIN',
      shopId,
    });
  });

  test('rejects legacy accountless admin subjects', async () => {
    const { prisma, shop } = createPrismaMock();
    shop.findFirst.mockResolvedValueOnce({
      id: shopId,
      shopDomain: 'example.myshopify.com',
    });
    const resolver = loadResolver(prisma, {
      CLEVER_ADMIN_ALLOWED_SHOP_DOMAINS: 'example.myshopify.com',
    });

    await expect(resolver.resolve('dsv-shop: Example.MyShopify.com ')).rejects.toBeInstanceOf(DsvV1AuthenticationError);
    expect(shop.findFirst).not.toHaveBeenCalled();
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
        scopeVersion: true,
        shop: { select: { id: true, shopDomain: true } },
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
      shopDomain: 'example.myshopify.com',
      shopId,
    });
  });

  test('accepts scope-versioned customer subjects and rejects stale versions', async () => {
    const { customerAccount, prisma } = createPrismaMock();
    customerAccount.findUnique.mockResolvedValueOnce(customerAccountRow({ scopeVersion: 3 }));
    const resolver = loadResolver(prisma);

    await expect(resolver.resolve(`dsv-customer-account:${accountId}:3`))
      .resolves.toMatchObject({ customerId, principalType: 'CUSTOMER_USER' });

    customerAccount.findUnique.mockResolvedValueOnce(customerAccountRow({ scopeVersion: 4 }));
    await expect(resolver.resolve(`dsv-customer-account:${accountId}:3`))
      .rejects.toBeInstanceOf(DsvV1AuthenticationError);
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
  shop: { id: string; shopDomain: string };
  shopId: string;
  scopeVersion: number;
  status: string;
  subject: string;
};

type CustomerAccountFindUnique = (args: {
  select: {
    customer: { select: { id: true; shopId: true } };
    customerId: true;
    id: true;
    issuer: true;
    shop: { select: { id: true; shopDomain: true } };
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
  dsvAdminAccount: { findFirst: ReturnType<typeof vi.fn> };
  prisma: PrismaClient;
  shop: { findFirst: ReturnType<typeof vi.fn<ShopFindFirst>> };
} {
  const customerAccount = {
    findUnique: vi.fn<CustomerAccountFindUnique>(),
  };
  const dsvAdminAccount = {
    findFirst: vi.fn(),
  };
  const shop = {
    findFirst: vi.fn<ShopFindFirst>(),
  };

  return {
    customerAccount,
    dsvAdminAccount,
    prisma: { customerAccount, dsvAdminAccount, shop } as unknown as PrismaClient,
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
  scopeVersion?: number;
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
    scopeVersion: input.scopeVersion ?? 1,
    shop: { id: input.canonicalShopId ?? shopId, shopDomain: 'example.myshopify.com' },
    shopId,
    status: input.status ?? 'ACTIVE',
    subject: 'customer@example.com',
  };
}
