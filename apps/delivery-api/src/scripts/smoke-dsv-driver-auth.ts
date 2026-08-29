import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { assertShopifyShopPrivacyWriteAllowed } from '../modules/shopify/order-privacy-redaction.js';

const SAFE_TARGET = 'safe-local-dsv-driver-auth-temp-cluster';
const target = process.env.DSV_DRIVER_AUTH_SMOKE_TARGET;
const databaseUrl = process.env.DATABASE_URL;
const apiBaseUrl = process.env.DELIVERY_API_BASE_URL;

if (target !== SAFE_TARGET) throw new Error(`DSV_DRIVER_AUTH_SMOKE_TARGET must equal ${SAFE_TARGET}`);
if (databaseUrl === undefined || !isSafeDisposableDatabase(databaseUrl)) {
  throw new Error('DATABASE_URL must target the disposable loopback clever_driver_auth database on port 55456');
}
if (apiBaseUrl === undefined || !isLoopbackApi(apiBaseUrl)) {
  throw new Error('DELIVERY_API_BASE_URL must be an HTTP loopback URL');
}

const prisma = new PrismaClient();
const suffix = randomBytes(4).toString('hex');
const shopDomain = `dsv-driver-auth-${suffix}.local`;
const fixtures = [
  {
    loginId: `qa.driver.a.${suffix}`,
    name: 'QA 배송원 A',
    password: `Qa-driver-A-${suffix}!`,
    phone: '01090000001',
  },
  {
    loginId: `qa.driver.b.${suffix}`,
    name: 'QA 배송원 B',
    password: `Qa-driver-B-${suffix}!`,
    phone: '01090000002',
  },
] as const;

let shopId: string | undefined;
const driverIds: string[] = [];

try {
  const shop = await prisma.$transaction(async (tx) => {
    await assertShopifyShopPrivacyWriteAllowed(tx, { appId: 'clever', shopDomain });
    return tx.shop.create({ data: { appId: 'clever', shopDomain } });
  });
  shopId = shop.id;

  for (const fixture of fixtures) {
    const driver = await prisma.driver.create({
      data: {
        displayName: fixture.name,
        dsvProfile: {
          create: {
            age: 30,
            career: '합성 스모크 테스트',
            gender: '미제공',
            lookupName: fixture.name,
            residentNumberFrontFingerprint: null,
            score: '미제공',
            traits: [],
            zone: '테스트 구역',
          },
        },
        phone: fixture.phone,
        shopId: shop.id,
        status: 'ACTIVE',
      },
    });
    driverIds.push(driver.id);
  }

  const decoy = await prisma.driver.create({
    data: {
      displayName: 'QA 배송원 불일치',
      dsvProfile: {
        create: {
          age: 30,
          career: '합성 스모크 테스트',
          gender: '미제공',
          lookupName: 'QA 배송원 불일치',
          residentNumberFrontFingerprint: null,
          score: '미제공',
          traits: [],
          zone: '테스트 구역',
        },
      },
      phone: '01090000999',
      shopId: shop.id,
      status: 'ACTIVE',
    },
  });

  for (const [index, fixture] of fixtures.entries()) {
    const registration = await postJson('/api/dsv/driver/auth/register', fixture);
    assert.equal(registration.status, 201);
    assert.equal(registration.body.error, null);
    assert.equal(registration.body.data?.account.connectionStatus, 'LINKED');
    assert.deepEqual(registration.body.data?.account.linkedDrivers, [{
      driverId: driverIds[index],
      name: fixture.name,
      shopDomain,
    }]);

    const login = await postJson('/api/dsv/driver/auth/login', {
      loginId: fixture.loginId.toUpperCase(),
      password: fixture.password,
    });
    assert.equal(login.status, 200);
    assert.equal(login.body.data?.account.loginId, fixture.loginId);
    assert.equal(login.body.data?.account.connectionStatus, 'LINKED');
    assert.equal(login.body.data?.account.linkedDrivers[0]?.driverId, driverIds[index]);
  }

  const wrongPassword = await postJson('/api/dsv/driver/auth/login', {
    loginId: fixtures[0].loginId,
    password: 'definitely-wrong-password',
  });
  assert.equal(wrongPassword.status, 401);
  assert.equal(wrongPassword.body.error?.code, 'INVALID_CREDENTIALS');

  const duplicate = await postJson('/api/dsv/driver/auth/register', fixtures[0]);
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error?.code, 'ACCOUNT_EXISTS');

  const linkedDrivers = await prisma.driver.findMany({
    orderBy: { displayName: 'asc' },
    select: { account: { select: { loginId: true } }, authSubject: true, id: true },
    where: { id: { in: [...driverIds, decoy.id] } },
  });
  for (const [index, driverId] of driverIds.entries()) {
    const linked = linkedDrivers.find((driver) => driver.id === driverId);
    assert.equal(linked?.account?.loginId, fixtures[index]?.loginId);
    assert.equal(linked?.authSubject, `driver-${driverId}`);
  }
  const unlinkedDecoy = linkedDrivers.find((driver) => driver.id === decoy.id);
  assert.equal(unlinkedDecoy?.account, null);
  assert.equal(unlinkedDecoy?.authSubject, null);

  const accounts = await prisma.driverAccount.findMany({
    select: { loginId: true, passwordHash: true, residentNumberFrontFingerprint: true },
    where: { loginId: { in: fixtures.map((fixture) => fixture.loginId) } },
  });
  assert.equal(accounts.length, 2);
  for (const account of accounts) {
    const fixture = fixtures.find((candidate) => candidate.loginId === account.loginId);
    assert.ok(fixture);
    assert.notEqual(account.passwordHash, fixture.password);
    assert.equal(account.residentNumberFrontFingerprint, null);
  }

  console.log(JSON.stringify({
    checked: ['register', 'login', 'exact-link', 'wrong-password', 'duplicate-account', 'no-resident-identity-input'],
    driverCount: fixtures.length,
    result: 'passed',
  }));
} finally {
  await prisma.driverAccount.deleteMany({
    where: { loginId: { in: fixtures.map((fixture) => fixture.loginId) } },
  });
  if (shopId !== undefined) await prisma.shop.deleteMany({ where: { id: shopId } });
  await prisma.$disconnect();
}

type AuthResponse = {
  data: null | {
    account: {
      connectionStatus: 'LINKED' | 'UNLINKED';
      linkedDrivers: Array<{ driverId: string; name: string; shopDomain: string }>;
      loginId: string;
    };
  };
  error: null | { code: string; message: string };
};

async function postJson(path: string, payload: unknown): Promise<{ body: AuthResponse; status: number }> {
  const response = await fetch(new URL(path, apiBaseUrl), {
    body: JSON.stringify(payload),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
  return { body: await response.json() as AuthResponse, status: response.status };
}

function isSafeDisposableDatabase(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
      && url.port === '55456'
      && url.pathname === '/clever_driver_auth';
  } catch {
    return false;
  }
}

function isLoopbackApi(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
  } catch {
    return false;
  }
}
