import { describe, expect, test } from 'vitest';

import {
  canAccessShopDomain,
  parseAllowedShopDomains,
  StaticAdminCommerceTokenVerifier,
} from '../src/modules/commerce/admin-commerce-auth.js';

describe('admin commerce auth shop-domain allowlist', () => {
  test('fails closed when the allowed shop domain env is missing or blank', () => {
    expect(parseAllowedShopDomains(undefined)).toEqual([]);
    expect(parseAllowedShopDomains('')).toEqual([]);
    expect(parseAllowedShopDomains(' , , ')).toEqual([]);
    expect(
      canAccessShopDomain(
        { allowedShopDomains: parseAllowedShopDomains(undefined), subject: 'operator' },
        'store.example',
      ),
    ).toBe(false);
  });

  test('allows wildcard only when it is explicitly configured', () => {
    const actor = { allowedShopDomains: parseAllowedShopDomains('*'), subject: 'operator' };

    expect(actor.allowedShopDomains).toBe('*');
    expect(canAccessShopDomain(actor, 'store.example')).toBe(true);
  });

  test('normalizes explicit comma-separated shop domains', () => {
    expect(
      parseAllowedShopDomains(' https://STORE.example/admin,store.example, second.example '),
    ).toEqual(['store.example', 'second.example']);
  });

  test('static token verifier does not default to wildcard access', () => {
    const verifier = new StaticAdminCommerceTokenVerifier({ token: 'secret-token' });
    const actor = verifier.verify(' secret-token ');

    expect(actor.allowedShopDomains).toEqual([]);
    expect(canAccessShopDomain(actor, 'store.example')).toBe(false);
  });
});
