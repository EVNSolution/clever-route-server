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
      id: safe.id,
      label: 'Tomatono local',
      shopDomain: 'tomatonofood.com',
      siteUrl: 'https://tomatonofood.com',
      status: 'ACTIVE',
      timezone: 'America/Toronto'
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
    consumerKeyCiphertext: input.consumerKeyCiphertext,
    consumerSecretCiphertext: input.consumerSecretCiphertext,
    id: input.connectionId,
    label: input.label,
    platform: 'WOOCOMMERCE',
    shopDomain: input.shopDomain,
    shopId: `shop-${input.shopDomain}`,
    siteUrl: input.siteUrl,
    status: 'ACTIVE',
    timezone: input.timezone,
    webhookSecretCiphertext: input.webhookSecretCiphertext
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
