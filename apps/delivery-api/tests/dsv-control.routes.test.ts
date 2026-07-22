import { describe, expect, test, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import { DestinationTipConflictError } from '../src/modules/dsv/dsv-control.repository.js';
import type { DsvControlRepository } from '../src/modules/dsv/dsv-control.repository.js';
import type { DsvControlDependencies } from '../src/routes/dsv-control.routes.js';

const stopId = '11111111-1111-4111-8111-111111111111';
const destinationId = '22222222-2222-4222-8222-222222222222';
const tipId = '33333333-3333-4333-8333-333333333333';

describe('DSV control routes', () => {
  test('requires a DSV session before returning selected delivery context', async () => {
    const { app, repository } = await createHarness();
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/api/dsv/control/delivery-stops/${stopId}/context`,
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'UNAUTHORIZED', message: 'DSV login required' },
      });
      expect(repository.getDeliveryStopContext).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('binds the authenticated session to an allowed shop and returns items with destination tips', async () => {
    const { app, repository } = await createHarness();
    try {
      const login = await loginToDsv(app);
      expect(login.response.statusCode).toBe(200);
      expect(login.response.headers['set-cookie']).toContain('Path=/api/dsv/');
      expect(login.response.json()).toMatchObject({
        data: { shopDomain: 'tomatonofood.com' },
        error: null,
      });

      const response = await app.inject({
        headers: { cookie: login.cookie },
        method: 'GET',
        url: `/api/dsv/control/delivery-stops/${stopId}/context`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.json()).toMatchObject({
        data: {
          deliveryStopId: stopId,
          destination: { destinationId, name: '강남세브란스병원' },
          items: [{ name: '진단키트', quantity: 2 }],
          tips: [{ tipId, title: '후문 이용' }],
        },
        error: null,
      });
      expect(repository.getDeliveryStopContext).toHaveBeenCalledWith({
        deliveryStopId: stopId,
        shopDomain: 'tomatonofood.com',
      });
    } finally {
      await app.close();
    }
  });

  test('requires CSRF for tip writes and reports optimistic revision conflicts', async () => {
    const { app, repository } = await createHarness();
    repository.updateDestinationTip.mockRejectedValueOnce(new DestinationTipConflictError(4));
    try {
      const login = await loginToDsv(app);
      const missingCsrf = await app.inject({
        headers: { cookie: login.cookie },
        method: 'POST',
        payload: {
          body: '지하 1층 하역장으로 진입합니다.',
          category: 'access',
          severity: 'warning',
          title: '후문 이용',
        },
        url: `/api/dsv/destinations/${destinationId}/tips`,
      });
      expect(missingCsrf.statusCode).toBe(403);
      expect(repository.createDestinationTip).not.toHaveBeenCalled();

      const conflict = await app.inject({
        headers: { cookie: login.cookie, 'x-csrf-token': login.csrfToken },
        method: 'PATCH',
        payload: { body: '수정된 내용', revision: 3 },
        url: `/api/dsv/destinations/${destinationId}/tips/${tipId}`,
      });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toEqual({
        data: null,
        error: {
          code: 'TIP_REVISION_CONFLICT',
          details: { currentRevision: 4 },
          message: 'Destination tip was changed by another operator',
        },
      });
    } finally {
      await app.close();
    }
  });

  test('does not reveal a disallowed or missing shop during login', async () => {
    const { app } = await createHarness();
    try {
      const response = await app.inject({
        method: 'POST',
        payload: { id: 'operator', password: 'correct-password', shopDomain: 'other.example' },
        url: '/api/dsv/auth/login',
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'NOT_FOUND', message: 'Customer workspace not found' },
      });
    } finally {
      await app.close();
    }
  });

  test('reports an actionable error when the DSV migration is missing', async () => {
    const { app, repository } = await createHarness();
    repository.getDeliveryStopContext.mockRejectedValueOnce({ code: 'P2021' });
    try {
      const login = await loginToDsv(app);
      const response = await app.inject({
        headers: { cookie: login.cookie },
        method: 'GET',
        url: `/api/dsv/control/delivery-stops/${stopId}/context`,
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        data: null,
        error: { code: 'DSV_SCHEMA_NOT_READY' },
      });
    } finally {
      await app.close();
    }
  });
});

async function createHarness(): Promise<{
  app: Awaited<ReturnType<typeof buildApp>>;
  repository: MockRepository;
}> {
  const repository = createRepository();
  const dependencies: DsvControlDependencies = {
    allowedShopDomains: ['tomatonofood.com'],
    cookieName: 'clever_dsv_admin',
    loginId: 'operator',
    loginSecret: 'correct-password',
    repository,
    secureCookies: false,
    sessionSecret: '12345678901234567890123456789012',
  };
  return { app: await buildApp({ dsvControl: dependencies }), repository };
}

type MockRepository = {
  [Key in keyof DsvControlRepository]: ReturnType<typeof vi.fn<DsvControlRepository[Key]>>;
};

function createRepository(): MockRepository {
  const tip = {
    body: '도착 전에 연락합니다.',
    category: 'access' as const,
    createdAt: '2026-07-10T00:00:00.000Z',
    destinationId,
    revision: 1,
    severity: 'warning' as const,
    source: { deliveryStopId: stopId, kind: 'delivery_record' as const, recordedAt: '2026-07-10T00:00:00.000Z' },
    status: 'active' as const,
    tipId,
    title: '후문 이용',
    updatedAt: '2026-07-10T00:00:00.000Z',
  };
  return {
    createDestinationTip: vi.fn(() => Promise.resolve(tip)),
    getDeliveryStopContext: vi.fn(() => Promise.resolve({
      deliveryStopId: stopId,
      destination: { address: '서울 강남구', destinationId, name: '강남세브란스병원' },
      items: [{ name: '진단키트', orderItemId: 'item-id', quantity: 2, sku: 'KIT-1', temperatureBand: null }],
      tips: [tip],
    })),
    hasShop: vi.fn((shopDomain) => Promise.resolve(shopDomain === 'tomatonofood.com')),
    listDestinationTips: vi.fn(() => Promise.resolve([tip])),
    updateDestinationTip: vi.fn(() => Promise.resolve(tip)),
  };
}

async function loginToDsv(app: Awaited<ReturnType<typeof buildApp>>): Promise<{
  cookie: string;
  csrfToken: string;
  response: Awaited<ReturnType<typeof app.inject>>;
}> {
  const response = await app.inject({
    method: 'POST',
    payload: { id: 'operator', password: 'correct-password', shopDomain: 'tomatonofood.com' },
    url: '/api/dsv/auth/login',
  });
  const cookie = String(response.headers['set-cookie']).split(';')[0] ?? '';
  const csrfToken = response.json<{ data: { csrfToken: string } }>().data.csrfToken;
  return { cookie, csrfToken, response };
}
