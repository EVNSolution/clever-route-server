import { describe, expect, test } from 'vitest';

import {
  DsvForbiddenError,
  createDsvAdminPrincipal,
  createDsvCustomerUserPrincipalFromAccount,
  requireCustomerDeliveryPrincipal,
  requireDsvScopes,
} from '../src/modules/dsv/dsv-principal.js';
import type { DsvPrincipal } from '../src/modules/dsv/dsv-principal.js';

describe('DSV principal authorization', () => {
  test('maps legacy DSV admin sessions to a canonical Shop.id UUID principal with explicit admin scopes', () => {
    const principal = createDsvAdminPrincipal({
      shopDomain: 'tomatonofood.com',
      shopId: '99999999-9999-4999-8999-999999999999',
    });

    expect(principal).toMatchObject({
      principalType: 'DSV_ADMIN',
      shopDomain: 'tomatonofood.com',
      shopId: '99999999-9999-4999-8999-999999999999',
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
      'dsv:imports:apply',
      'dsv:settings:read',
      'dsv:settings:write',
      'dsv:destinations:read',
      'dsv:destinations:write',
    ]));
    expect(() => requireDsvScopes(principal, ['dsv:imports:apply'])).not.toThrow();
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

  test('ACTIVE CustomerAccount status grants CUSTOMER_USER scope from the canonical customerId and shopId', () => {
    const principal = createDsvCustomerUserPrincipalFromAccount({
      account: {
        customerId: 'customer-a',
        shopId: '99999999-9999-4999-8999-999999999999',
        status: 'ACTIVE',
      },
    });

    expect(principal).toEqual({
      customerId: 'customer-a',
      principalType: 'CUSTOMER_USER',
      scopes: ['dsv:session:read', 'dsv:customer-deliveries:read'],
      shopId: '99999999-9999-4999-8999-999999999999',
    });
    expect(() => requireDsvScopes(principal, ['dsv:session:read'])).not.toThrow();
    expect(() => requireDsvScopes(principal, ['dsv:customer-deliveries:read'])).not.toThrow();
    expect(requireCustomerDeliveryPrincipal({
      customerId: 'customer-a',
      destinationId: 'shared-destination',
      principal,
    })).toBe(principal);
    expect(() => requireCustomerDeliveryPrincipal({
      customerId: 'customer-b',
      destinationId: 'shared-destination',
      principal,
    })).toThrow(DsvForbiddenError);
  });

  test('missing, null, inactive, or empty CustomerAccount status cannot grant CUSTOMER_USER scope', () => {
    type PrincipalInput = Parameters<typeof createDsvCustomerUserPrincipalFromAccount>[0];
    const baseAccount = {
      customerId: 'customer-a',
      shopId: '99999999-9999-4999-8999-999999999999',
    };

    expect(() => createDsvCustomerUserPrincipalFromAccount({
      account: baseAccount,
    } as unknown as PrincipalInput)).toThrow(DsvForbiddenError);
    expect(() => createDsvCustomerUserPrincipalFromAccount({
      account: {
        ...baseAccount,
        status: null,
      },
    } as unknown as PrincipalInput)).toThrow(DsvForbiddenError);
    expect(() => createDsvCustomerUserPrincipalFromAccount({
      account: {
        ...baseAccount,
        status: 'INACTIVE',
      },
    })).toThrow(DsvForbiddenError);
    expect(() => createDsvCustomerUserPrincipalFromAccount({
      account: {
        ...baseAccount,
        status: '',
      },
    })).toThrow(DsvForbiddenError);
  });

  test('destination ID alone cannot authorize customer reads', () => {
    const customerPrincipal = createDsvCustomerUserPrincipalFromAccount({
      account: {
        customerId: 'customer-a',
        shopId: '99999999-9999-4999-8999-999999999999',
        status: 'ACTIVE',
      },
    });
    const adminPrincipal = createDsvAdminPrincipal({ shopId: '99999999-9999-4999-8999-999999999999' });

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
