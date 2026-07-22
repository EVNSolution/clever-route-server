import { describe, expect, test } from 'vitest';

import {
  DsvForbiddenError,
  createDsvAdminPrincipal,
  requireCustomerDeliveryPrincipal,
  requireDsvScopes,
} from '../src/modules/dsv/dsv-principal.js';
import type { DsvPrincipal } from '../src/modules/dsv/dsv-principal.js';

describe('DSV principal authorization', () => {
  test('maps legacy DSV admin sessions to explicit admin scopes', () => {
    const principal = createDsvAdminPrincipal({ shopId: 'tomatonofood.com' });

    expect(principal).toMatchObject({
      principalType: 'DSV_ADMIN',
      shopId: 'tomatonofood.com',
    });
    expect('customerId' in principal).toBe(false);
    expect('driverId' in principal).toBe(false);
    expect(principal.scopes).toEqual(expect.arrayContaining([
      'dsv:session:read',
      'dsv:control:read',
      'dsv:resources:read',
      'dsv:resources:write',
      'dsv:conditions:read',
      'dsv:conditions:write',
      'dsv:imports:read',
      'dsv:imports:write',
      'dsv:settings:read',
      'dsv:settings:write',
      'dsv:destinations:read',
      'dsv:destinations:write',
    ]));
    expect(() => requireDsvScopes(principal, ['dsv:resources:write'])).not.toThrow();
  });

  test('reports stable forbidden error information when a scope is missing', () => {
    const principal: DsvPrincipal = {
      principalType: 'IMPORT_WORKER',
      scopes: ['dsv:imports:apply'],
      shopId: 'shop-1',
    };

    expect(() => requireDsvScopes(principal, ['dsv:resources:write'])).toThrow(DsvForbiddenError);

    try {
      requireDsvScopes(principal, ['dsv:resources:write']);
    } catch (error) {
      expect(error).toBeInstanceOf(DsvForbiddenError);
      expect(error).toMatchObject({
        code: 'DSV_FORBIDDEN',
        details: {
          principalType: 'IMPORT_WORKER',
          requiredScopes: ['dsv:resources:write'],
          shopId: 'shop-1',
        },
        httpStatus: 403,
        message: 'DSV principal does not have the required scope.',
      });
    }
  });

  test('requires customer authorization from the account customerId, never destinationId alone', () => {
    const customerPrincipal: DsvPrincipal = {
      customerId: 'customer-a',
      principalType: 'CUSTOMER_USER',
      scopes: ['dsv:customer-deliveries:read'],
      shopId: 'shop-1',
    };
    const adminPrincipal = createDsvAdminPrincipal({ shopId: 'shop-1' });

    expect(requireCustomerDeliveryPrincipal({
      customerId: 'customer-a',
      destinationId: 'shared-destination',
      principal: customerPrincipal,
    })).toBe(customerPrincipal);
    expect(() => requireCustomerDeliveryPrincipal({
      destinationId: 'shared-destination',
      principal: adminPrincipal,
    })).toThrow(DsvForbiddenError);
    expect(() => requireCustomerDeliveryPrincipal({
      customerId: 'customer-b',
      destinationId: 'shared-destination',
      principal: customerPrincipal,
    })).toThrow(DsvForbiddenError);
  });
});
