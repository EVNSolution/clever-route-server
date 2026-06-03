import { describe, expect, test, vi } from 'vitest';

import {
  hashSecret,
  WordPressPluginAuthService,
  WordPressPluginPairingConsumedError,
  WordPressPluginPairingExpiredError,
  WordPressPluginPairingInvalidError
} from '../src/modules/wordpress-plugin/wordpress-plugin-auth.service.js';
import type { WordPressPluginAuthRepository } from '../src/modules/wordpress-plugin/wordpress-plugin-auth.service.js';

const now = new Date('2026-05-22T01:30:00.000Z');
type PairingCodeRecord = NonNullable<Awaited<ReturnType<WordPressPluginAuthRepository['findPairingCodeByHash']>>>;
type PluginTokenRecord = NonNullable<Awaited<ReturnType<WordPressPluginAuthRepository['findPluginTokenByHash']>>>;

describe('WordPressPluginAuthService', () => {
  test('consumes a one-time site-bound pairing code and returns plaintext token once', async () => {
    const repository = createRepositoryHarness();
    repository.pairingCodes.set(hashSecret('pair-code'), pairingCodeRecord());
    const service = new WordPressPluginAuthService({ now: () => now, repository });

    const paired = await service.pairPlugin({
      pairingCode: 'pair-code',
      siteUrl: 'https://Woo.Example.Test/'
    });

    expect(paired.connectionId).toBe('connection-id');
    expect(paired.expiresAt).toBe('2026-05-22T01:45:00.000Z');
    expect(paired.siteUrl).toBe('https://woo.example.test');
    expect(paired.token).toMatch(/^crp_/u);
    expect(paired.tokenPrefix).toMatch(/^crp_/u);
    expect(repository.consumedPairingCodeIds).toEqual(['pairing-id']);
    const createdToken = repository.createdTokens[0];
    expect(createdToken?.commerceConnectionId).toBe('connection-id');
    expect(createdToken?.tokenHash).not.toContain(paired.token);
    expect(createdToken?.tokenPrefix).toBe(paired.tokenPrefix);
  });

  test('rejects expired, consumed, and wrong-site pairing codes', async () => {
    const repository = createRepositoryHarness();
    repository.pairingCodes.set(hashSecret('expired'), pairingCodeRecord({ expiresAt: new Date('2026-05-22T01:00:00.000Z') }));
    repository.pairingCodes.set(hashSecret('consumed'), pairingCodeRecord({ consumedAt: now }));
    repository.pairingCodes.set(hashSecret('wrong-site'), pairingCodeRecord({ siteUrl: 'https://other.example.test' }));
    const service = new WordPressPluginAuthService({ now: () => now, repository });

    await expect(service.pairPlugin({ pairingCode: 'expired', siteUrl: 'https://woo.example.test' })).rejects.toBeInstanceOf(
      WordPressPluginPairingExpiredError
    );
    await expect(service.pairPlugin({ pairingCode: 'consumed', siteUrl: 'https://woo.example.test' })).rejects.toBeInstanceOf(
      WordPressPluginPairingConsumedError
    );
    await expect(service.pairPlugin({ pairingCode: 'wrong-site', siteUrl: 'https://woo.example.test' })).rejects.toBeInstanceOf(
      WordPressPluginPairingInvalidError
    );
    expect(repository.failedAttemptIds).toEqual(['pairing-id', 'pairing-id']);
  });

  test('valid token resolves tenant from token only without blocking on last-used telemetry', async () => {
    const repository = createRepositoryHarness();
    repository.tokens.set(hashSecret('token-value'), {
      commerceConnection: connectionRecord(),
      id: 'token-id',
      status: 'ACTIVE',
      tokenPrefix: 'crp_prefix'
    });
    const service = new WordPressPluginAuthService({ now: () => now, repository });

    const context = await service.authenticateToken('token-value');

    expect(context).toEqual({
      connectionId: 'connection-id',
      label: 'Woo test',
      shopDomain: 'woo.example.test',
      shopId: 'shop-id',
      siteUrl: 'https://woo.example.test',
      status: 'ACTIVE',
      tokenId: 'token-id',
      tokenPrefix: 'crp_prefix'
    });
    expect(repository.touchedTokenIds).toEqual([]);
  });

  test('invalid and revoked tokens fail closed', async () => {
    const repository = createRepositoryHarness();
    repository.tokens.set(hashSecret('revoked-token'), {
      commerceConnection: connectionRecord(),
      id: 'token-id',
      status: 'REVOKED',
      tokenPrefix: 'crp_prefix'
    });
    const service = new WordPressPluginAuthService({ now: () => now, repository });

    await expect(service.authenticateToken('missing-token')).resolves.toBeNull();
    await expect(service.authenticateToken('revoked-token')).resolves.toBeNull();
  });
});

function createRepositoryHarness(): WordPressPluginAuthRepository & {
  consumedPairingCodeIds: string[];
  createdTokens: Array<{ commerceConnectionId: string; tokenHash: string; tokenPrefix: string }>;
  failedAttemptIds: string[];
  pairingCodes: Map<string, PairingCodeRecord>;
  tokens: Map<string, PluginTokenRecord>;
  touchedTokenIds: string[];
} {
  const pairingCodes = new Map<string, PairingCodeRecord>();
  const tokens = new Map<string, PluginTokenRecord>();
  const consumedPairingCodeIds: string[] = [];
  const createdTokens: Array<{ commerceConnectionId: string; tokenHash: string; tokenPrefix: string }> = [];
  const failedAttemptIds: string[] = [];
  const touchedTokenIds: string[] = [];
  return {
    consumedPairingCodeIds,
    createdTokens,
    failedAttemptIds,
    pairingCodes,
    tokens,
    touchedTokenIds,
    consumePairingCode: vi.fn<WordPressPluginAuthRepository['consumePairingCode']>((input) => {
      consumedPairingCodeIds.push(input.pairingCodeId);
      return Promise.resolve(true);
    }),
    createPluginToken: vi.fn<WordPressPluginAuthRepository['createPluginToken']>((input) => {
      createdTokens.push({
        commerceConnectionId: input.commerceConnectionId,
        tokenHash: input.tokenHash,
        tokenPrefix: input.tokenPrefix
      });
      tokens.set(input.tokenHash, {
        commerceConnection: connectionRecord(),
        id: 'token-id',
        status: 'ACTIVE',
        tokenPrefix: input.tokenPrefix
      });
      return Promise.resolve({ id: 'token-id', tokenPrefix: input.tokenPrefix });
    }),
    findPairingCodeByHash: vi.fn<WordPressPluginAuthRepository['findPairingCodeByHash']>((input) =>
      Promise.resolve(pairingCodes.get(input.codeHash) ?? null)
    ),
    findPluginTokenByHash: vi.fn<WordPressPluginAuthRepository['findPluginTokenByHash']>((input) =>
      Promise.resolve(tokens.get(input.tokenHash) ?? null)
    ),
    incrementPairingCodeFailedAttempt: vi.fn<WordPressPluginAuthRepository['incrementPairingCodeFailedAttempt']>((input) => {
      failedAttemptIds.push(input.pairingCodeId);
      return Promise.resolve();
    }),
    touchPluginToken: vi.fn<WordPressPluginAuthRepository['touchPluginToken']>((input) => {
      touchedTokenIds.push(input.tokenId);
      return Promise.resolve();
    })
  };
}

function pairingCodeRecord(overrides: { consumedAt?: Date | null; expiresAt?: Date; siteUrl?: string } = {}): PairingCodeRecord {
  return {
    commerceConnection: connectionRecord(overrides.siteUrl === undefined ? {} : { siteUrl: overrides.siteUrl }),
    commerceConnectionId: 'connection-id',
    consumedAt: overrides.consumedAt ?? null,
    expiresAt: overrides.expiresAt ?? new Date('2026-05-22T01:45:00.000Z'),
    id: 'pairing-id',
    shopId: 'shop-id',
    siteUrl: overrides.siteUrl ?? 'https://woo.example.test'
  };
}

function connectionRecord(overrides: { siteUrl?: string; status?: 'ACTIVE' | 'DISABLED' } = {}) {
  return {
    id: 'connection-id',
    label: 'Woo test',
    shopDomain: 'woo.example.test',
    shopId: 'shop-id',
    siteUrl: overrides.siteUrl ?? 'https://woo.example.test',
    status: overrides.status ?? 'ACTIVE'
  };
}
