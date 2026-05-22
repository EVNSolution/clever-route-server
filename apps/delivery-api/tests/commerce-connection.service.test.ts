import { describe, expect, test } from 'vitest';

import {
  commerceCredentialAad,
  loadCredentialEncryptionKey
} from '../src/modules/commerce/commerce-credential-encryption.js';
import {
  CommerceConnectionCredentialService,
  type UpsertWooCommerceConnectionInput
} from '../src/modules/commerce/commerce-connection.service.js';
import type { CommerceConnectionRecord } from '../src/modules/commerce/commerce-connection.repository.js';

const key = loadCredentialEncryptionKey('base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
const wrongKey = loadCredentialEncryptionKey('base64:AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=');

describe('CommerceConnectionCredentialService', () => {
  test('stores WooCommerce credentials as ciphertext and decrypts them by connection id', async () => {
    const repository = createRepositoryHarness();
    const service = new CommerceConnectionCredentialService({ credentialKey: key, repository });

    const safe = await service.upsertWooCommerceConnection(connectionInput());
    const stored = repository.records.get(safe.id);

    expect(safe).toEqual({
      credential: {
        fingerprint: null,
        rotatedAt: null,
        status: 'stored'
      },
      id: safe.id,
      label: 'Tomatono local',
      lastRestSyncAt: null,
      lastWebhookAt: null,
      shopDomain: 'tomatonofood.com',
      siteUrl: 'https://tomatonofood.com',
      status: 'ACTIVE',
      timezone: 'America/Toronto',
      verification: {
        lastVerifiedAt: null,
        status: null
      },
      webhook: {
        rotatedAt: null,
        status: 'stored'
      }
    });
    expect(stored).toBeDefined();
    expect(stored?.consumerKeyCiphertext).toMatch(/^v1:/u);
    expect(stored?.consumerKeyCiphertext).not.toContain('ck_test_value');
    expect(stored?.consumerSecretCiphertext).not.toContain('cs_test_value');
    expect(stored?.webhookSecretCiphertext).not.toContain('whsec_test_value');

    await expect(service.readDecryptedWooCommerceConnection({ connectionId: safe.id })).resolves.toEqual({
      ...safe,
      consumerKey: 'ck_test_value',
      consumerSecret: 'cs_test_value',
      webhookSecret: 'whsec_test_value'
    });
    await expect(service.readWooCommerceWebhookConnection({ connectionId: safe.id })).resolves.toEqual({
      ...safe,
      webhookSecret: 'whsec_test_value'
    });
  });

  test('binds encrypted values to the connection id AAD so row swaps fail closed', async () => {
    const repository = createRepositoryHarness();
    const service = new CommerceConnectionCredentialService({ credentialKey: key, repository });
    const first = await service.upsertWooCommerceConnection(connectionInput({ siteUrl: 'https://first.example.test' }));
    const second = await service.upsertWooCommerceConnection(
      connectionInput({
        consumerKey: 'ck_second',
        consumerSecret: 'cs_second',
        siteUrl: 'https://second.example.test',
        webhookSecret: 'whsec_second'
      })
    );

    const firstRecord = repository.records.get(first.id);
    const secondRecord = repository.records.get(second.id);
    expect(firstRecord).toBeDefined();
    expect(secondRecord).toBeDefined();
    if (firstRecord !== undefined && secondRecord !== undefined) {
      firstRecord.consumerKeyCiphertext = secondRecord.consumerKeyCiphertext;
    }

    await expect(service.readDecryptedWooCommerceConnection({ connectionId: first.id })).rejects.toThrow(
      'Failed to decrypt secret'
    );
  });

  test('requires the same master key for reading stored connector credentials', async () => {
    const repository = createRepositoryHarness();
    const service = new CommerceConnectionCredentialService({ credentialKey: key, repository });
    const safe = await service.upsertWooCommerceConnection(connectionInput());
    const wrongKeyService = new CommerceConnectionCredentialService({
      credentialKey: wrongKey,
      repository
    });

    await expect(wrongKeyService.readDecryptedWooCommerceConnection({ connectionId: safe.id })).rejects.toThrow(
      'Failed to decrypt secret'
    );
  });

  test('re-upsert rotates ciphertext while preserving the same tenant/site connection id', async () => {
    const repository = createRepositoryHarness();
    const service = new CommerceConnectionCredentialService({ credentialKey: key, repository });
    const first = await service.upsertWooCommerceConnection(connectionInput());
    const firstStored = repository.records.get(first.id);
    const second = await service.upsertWooCommerceConnection(
      connectionInput({
        consumerKey: 'ck_rotated_value',
        consumerSecret: 'cs_rotated_value',
        webhookSecret: 'whsec_rotated_value'
      })
    );
    const secondStored = repository.records.get(second.id);

    expect(second.id).toBe(first.id);
    expect(firstStored?.consumerKeyCiphertext).not.toBe(secondStored?.consumerKeyCiphertext);
    expect(secondStored?.consumerKeyCiphertext).not.toContain('ck_rotated_value');
    expect(secondStored?.consumerSecretCiphertext).not.toContain('cs_rotated_value');
    expect(secondStored?.webhookSecretCiphertext).not.toContain('whsec_rotated_value');
  });

  test('rejects blank secrets before encryption and keeps safe DTO secret-free', async () => {
    const repository = createRepositoryHarness();
    const service = new CommerceConnectionCredentialService({ credentialKey: key, repository });

    await expect(
      service.upsertWooCommerceConnection(connectionInput({ consumerSecret: '   ' }))
    ).rejects.toThrow('WooCommerce consumer secret is required');
    expect(repository.records.size).toBe(0);

    const safe = await service.upsertWooCommerceConnection(connectionInput());
    const serialized = JSON.stringify(safe);
    expect(serialized).not.toContain('ck_test_value');
    expect(serialized).not.toContain('cs_test_value');
    expect(serialized).not.toContain('whsec_test_value');
    expect(serialized).not.toContain('consumerKey');
    expect(serialized).not.toContain('consumerSecret');
  });

  test('documents stable WooCommerce AAD strings used for DB credential rows', () => {
    expect(commerceCredentialAad('consumer-key', 'connection-1')).toBe('woocommerce:consumer-key:connection-1');
    expect(commerceCredentialAad('consumer-secret', 'connection-1')).toBe('woocommerce:consumer-secret:connection-1');
    expect(commerceCredentialAad('webhook-secret', 'connection-1')).toBe('woocommerce:webhook-secret:connection-1');
  });
});

function createRepositoryHarness() {
  const records = new Map<string, CommerceConnectionRecord>();
  return {
    records,
    createWooCommerceConnection(input: {
      connectionId: string;
      consumerKeyCiphertext: string;
      consumerSecretCiphertext: string;
      label: string | null;
      shopDomain: string;
      siteUrl: string;
      timezone: string | null;
      webhookSecretCiphertext: string;
    }): Promise<CommerceConnectionRecord> {
      const record = toRecord(input);
      records.set(record.id, record);
      return Promise.resolve(record);
    },
    findConnectionById(input: { connectionId: string }): Promise<CommerceConnectionRecord | null> {
      return Promise.resolve(records.get(input.connectionId) ?? null);
    },
    findWooCommerceConnectionByShopAndSite(input: {
      shopDomain: string;
      siteUrl: string;
    }): Promise<CommerceConnectionRecord | null> {
      return Promise.resolve(
        [...records.values()].find(
          (record) => record.shopDomain === input.shopDomain && record.siteUrl === input.siteUrl
        ) ?? null
      );
    },
    updateWooCommerceConnection(input: {
      connectionId: string;
      consumerKeyCiphertext: string;
      consumerSecretCiphertext: string;
      label: string | null;
      shopDomain: string;
      siteUrl: string;
      timezone: string | null;
      webhookSecretCiphertext: string;
    }): Promise<CommerceConnectionRecord> {
      const record = toRecord(input);
      records.set(record.id, record);
      return Promise.resolve(record);
    }
  };
}

function toRecord(input: {
  connectionId: string;
  consumerKeyCiphertext: string;
  consumerSecretCiphertext: string;
  label: string | null;
  shopDomain: string;
  siteUrl: string;
  timezone: string | null;
  webhookSecretCiphertext: string;
}): CommerceConnectionRecord {
  return {
    credentialFingerprint: null,
    credentialRotatedAt: null,
    consumerKeyCiphertext: input.consumerKeyCiphertext,
    consumerSecretCiphertext: input.consumerSecretCiphertext,
    id: input.connectionId,
    label: input.label,
    lastRestSyncAt: null,
    lastVerifiedAt: null,
    lastVerificationStatus: null,
    lastWebhookAt: null,
    platform: 'WOOCOMMERCE',
    shopDomain: input.shopDomain,
    shopId: `shop-${input.shopDomain}`,
    siteUrl: input.siteUrl,
    status: 'ACTIVE',
    timezone: input.timezone,
    webhookSecretCiphertext: input.webhookSecretCiphertext,
    webhookSecretRotatedAt: null
  };
}

function connectionInput(
  overrides: Partial<UpsertWooCommerceConnectionInput> = {}
): UpsertWooCommerceConnectionInput {
  return {
    consumerKey: 'ck_test_value',
    consumerSecret: 'cs_test_value',
    label: 'Tomatono local',
    shopDomain: 'TomatonoFood.com',
    siteUrl: 'tomatonofood.com/',
    timezone: 'America/Toronto',
    webhookSecret: 'whsec_test_value',
    ...overrides
  };
}
