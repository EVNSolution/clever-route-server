import type { PrismaClient } from '@prisma/client';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import { DsvAssignmentCommandService } from '../src/modules/dsv/dsv-assignment-command.service.js';
import { loadDsvControlDependencies } from '../src/modules/dsv/dsv-control.dependencies.js';
import type { RouteGroupingService } from '../src/modules/route-grouping/route-grouping.types.js';

const loginSecret = 'operator-password';
const sessionSecret = '0123456789abcdef0123456789abcdef';

describe('loadDsvControlDependencies', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('keeps DSV control disabled until admin secrets are configured', () => {
    expect(loadDsvControlDependencies({
      env: {},
      nodeEnv: 'test',
      prisma: {} as PrismaClient,
      routeGroupingService: {} as RouteGroupingService
    })).toBeUndefined();
  });

  test('wires assignment command service so unassign route is not service unavailable', async () => {
    const dependencies = loadDsvControlDependencies({
      env: {
        CLEVER_ADMIN_ALLOWED_SHOP_DOMAINS: 'example.myshopify.com',
        CLEVER_ADMIN_WEB_LOGIN_SECRET: loginSecret,
        CLEVER_ADMIN_WEB_SESSION_SECRET: sessionSecret
      },
      nodeEnv: 'test',
      prisma: {} as PrismaClient,
      routeGroupingService: {} as RouteGroupingService
    });
    expect(dependencies?.assignmentCommandService).toBeDefined();
    if (dependencies === undefined || dependencies.assignmentCommandService === undefined) {
      throw new Error('DSV control dependencies did not load assignment commands');
    }

    vi.spyOn(dependencies.repository, 'hasShop').mockResolvedValue(true);
    vi.spyOn(dependencies.repository, 'resolveShopId').mockResolvedValue('shop-1');
    vi.spyOn(DsvAssignmentCommandService.prototype, 'unassign').mockResolvedValue({
      assignmentStatus: 'UNASSIGNED',
      auditEventId: 'audit-1',
      commandId: 'command-1',
      etaStatus: 'NOT_REQUIRED',
      newRouteVersionId: 'route-version-2',
      previousRouteVersionId: 'route-version-1',
      receiptId: 'receipt-1',
      routePlanId: null,
      sellerOrderId: '11111111-1111-4111-8111-111111111111'
    });

    const app = await buildApp({ dsvControl: dependencies });
    try {
      const loginResponse = await app.inject({
        method: 'POST',
        payload: {
          id: 'operator',
          password: loginSecret,
          shopDomain: 'example.myshopify.com'
        },
        url: '/api/dsv/auth/login'
      });
      expect(loginResponse.statusCode).toBe(200);
      const cookie = loginResponse.headers['set-cookie'];
      const csrfToken = loginResponse.json<{ data: { csrfToken: string } }>().data.csrfToken;

      const response = await app.inject({
        headers: {
          cookie: Array.isArray(cookie) ? cookie[0] : cookie,
          'idempotency-key': 'command-1',
          'x-csrf-token': csrfToken
        },
        method: 'POST',
        payload: {
          commandId: 'command-1',
          expectedVersion: 'route-version-1'
        },
        url: '/api/dsv/seller-orders/11111111-1111-4111-8111-111111111111/assignment/unassign'
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        data: {
          assignmentResult: {
            receiptId: 'receipt-1',
            sellerOrderId: '11111111-1111-4111-8111-111111111111'
          }
        },
        error: null
      });
    } finally {
      await app.close();
    }
  });
});
