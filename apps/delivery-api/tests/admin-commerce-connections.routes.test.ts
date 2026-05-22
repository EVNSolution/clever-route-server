import { describe, expect, test, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import type { AdminCommerceActor } from '../src/modules/commerce/admin-commerce-auth.js';
import { loadCredentialEncryptionKey } from '../src/modules/commerce/commerce-credential-encryption.js';
import type { CommerceConnectionRecord, WooCommerceConnectionWriteInput } from '../src/modules/commerce/commerce-connection.repository.js';
import { CommerceConnectionCredentialService } from '../src/modules/commerce/commerce-connection.service.js';
import { WooCommerceConnectionOnboardingService } from '../src/modules/commerce/woocommerce-connection-onboarding.service.js';
import { WooCommerceCredentialVerificationError } from '../src/modules/commerce/woocommerce-connection-verifier.js';
import type { AdminCommerceConnectionsDependencies } from '../src/routes/admin-commerce-connections.routes.js';

const encryptionKey = loadCredentialEncryptionKey('base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
const checkedAt = new Date('2026-05-22T04:00:00.000Z');
const now = new Date('2026-05-22T04:01:00.000Z');

type WooConnectionResponse = {
  data: {
    connection: {
      credential: {
        status: 'stored';
      };
      id: string;
      label: string | null;
      shopDomain: string;
      siteUrl: string;
      status: 'ACTIVE' | 'DISABLED';
      verification: {
        lastVerifiedAt: string | null;
        status: string | null;
      };
      webhook: {
        deliveryPath: string;
        deliveryUrl: string;
        status: 'stored';
      };
    };
    webhookSetup?: {
      deliveryPath: string;
      deliveryUrl: string;
      oneTimeSecret?: string;
    };
  };
  error: null;
};

describe('Admin WooCommerce connection routes', () => {
  test('requires the internal CLEVER admin bearer token before accepting credentials', async () => {
    const { app, repository, verifier } = await createAppHarness();

    try {
      const response = await app.inject({
        method: 'POST',
        payload: credentialPayload(),
        url: '/admin/commerce-connections/woocommerce/test'
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'UNAUTHORIZED', message: 'Missing CLEVER admin bearer token' }
      });
      expect(verifier.verify).not.toHaveBeenCalled();
      expect(repository.records.size).toBe(0);
    } finally {
      await app.close();
    }
  });

  test('tests Woo credentials without persistence and without query-string secrets', async () => {
    const { app, repository, verifier } = await createAppHarness();

    try {
      const response = await app.inject({
        headers: authHeaders(),
        method: 'POST',
        payload: credentialPayload(),
        url: '/admin/commerce-connections/woocommerce/test'
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        data: { checkedAt: checkedAt.toISOString(), status: 'VERIFIED' },
        error: null
      });
      expect(repository.records.size).toBe(0);
      expect(verifier.verify).toHaveBeenCalledWith({
        consumerKey: 'ck_test_value',
        consumerSecret: 'cs_test_value',
        siteUrl: 'https://woo.example.test'
      });
      expect(repository.auditLogs).toContainEqual(
        expect.objectContaining({ action: 'woocommerce_connection.test', status: 'success' })
      );
      expect(JSON.stringify(repository.auditLogs)).not.toContain('ck_test_value');
      expect(JSON.stringify(repository.auditLogs)).not.toContain('cs_test_value');
    } finally {
      await app.close();
    }
  });

  test('creates an encrypted connection and returns only safe metadata plus one-time webhook setup', async () => {
    const { app, repository } = await createAppHarness();

    try {
      const response = await app.inject({
        headers: authHeaders(),
        method: 'POST',
        payload: credentialPayload(),
        url: '/admin/commerce-connections/woocommerce'
      });

      expect(response.statusCode).toBe(201);
      const body = parseJson<WooConnectionResponse>(response.body);
      expect(body.data.connection.credential.status).toBe('stored');
      expect(body.data.connection.id).toEqual(expect.any(String));
      expect(body.data.connection.label).toBe('Woo main');
      expect(body.data.connection.shopDomain).toBe('tenant-a.example.test');
      expect(body.data.connection.siteUrl).toBe('https://woo.example.test');
      expect(body.data.connection.status).toBe('ACTIVE');
      expect(body.data.connection.verification).toEqual({
        lastVerifiedAt: checkedAt.toISOString(),
        status: 'VERIFIED'
      });
      expect(body.data.connection.webhook.deliveryPath).toMatch(/^\/woocommerce\/webhooks\/.+\/orders$/u);
      expect(body.data.connection.webhook.deliveryUrl).toMatch(
        /^https:\/\/delivery\.example\.test\/woocommerce\/webhooks\/.+\/orders$/u
      );
      expect(body.data.connection.webhook.status).toBe('stored');
      expect(body.data.webhookSetup).toEqual({
        deliveryPath: body.data.connection.webhook.deliveryPath,
        deliveryUrl: body.data.connection.webhook.deliveryUrl,
        oneTimeSecret: 'generated-whsec'
      });
      expect(JSON.stringify(body.data.connection)).not.toContain('consumerKey');
      expect(JSON.stringify(body.data.connection)).not.toContain('consumerSecret');
      expect(JSON.stringify(body.data.connection)).not.toContain('ck_test_value');
      expect(JSON.stringify(body.data.connection)).not.toContain('cs_test_value');

      const stored = repository.records.get(body.data.connection.id);
      expect(stored).toBeDefined();
      expect(stored?.consumerKeyCiphertext).toMatch(/^v1:/u);
      expect(stored?.consumerKeyCiphertext).not.toContain('ck_test_value');
      expect(stored?.consumerSecretCiphertext).not.toContain('cs_test_value');
      expect(stored?.webhookSecretCiphertext).not.toContain('generated-whsec');
      expect(repository.auditLogs).toContainEqual(
        expect.objectContaining({ action: 'woocommerce_connection.create', status: 'success' })
      );
    } finally {
      await app.close();
    }
  });

  test('list and detail responses never return raw stored secrets after save', async () => {
    const { app } = await createAppHarness();

    try {
      const created = await createConnection(app);
      const list = await app.inject({
        headers: authHeaders(),
        method: 'GET',
        url: '/admin/commerce-connections/woocommerce?shopDomain=tenant-a.example.test'
      });
      const detail = await app.inject({
        headers: authHeaders(),
        method: 'GET',
        url: `/admin/commerce-connections/woocommerce/${created.id}`
      });

      expect(list.statusCode).toBe(200);
      expect(detail.statusCode).toBe(200);
      const unsafeResponses = `${list.body}\n${detail.body}`;
      expect(unsafeResponses).not.toContain('ck_test_value');
      expect(unsafeResponses).not.toContain('cs_test_value');
      expect(unsafeResponses).not.toContain('generated-whsec');
      expect(unsafeResponses).not.toContain('oneTimeSecret');
      expect(unsafeResponses).not.toContain('consumerKey');
      expect(unsafeResponses).not.toContain('consumerSecret');
    } finally {
      await app.close();
    }
  });

  test('sanitizes failed Woo validation and persists neither credentials nor secret fields', async () => {
    const { app, repository } = await createAppHarness();

    try {
      const response = await app.inject({
        headers: authHeaders(),
        method: 'POST',
        payload: credentialPayload({ consumerKey: 'ck_invalid', consumerSecret: 'cs_invalid' }),
        url: '/admin/commerce-connections/woocommerce'
      });

      expect(response.statusCode).toBe(422);
      expect(response.json()).toEqual({
        data: null,
        error: {
          code: 'WOOCOMMERCE_UNAUTHORIZED',
          message: 'WooCommerce REST API rejected the supplied credentials'
        }
      });
      expect(response.body).not.toContain('ck_invalid');
      expect(response.body).not.toContain('cs_invalid');
      expect(repository.records.size).toBe(0);
      expect(repository.auditLogs).toContainEqual(
        expect.objectContaining({ action: 'woocommerce_connection.create', status: 'failed' })
      );
      expect(JSON.stringify(repository.auditLogs)).not.toContain('ck_invalid');
      expect(JSON.stringify(repository.auditLogs)).not.toContain('cs_invalid');
    } finally {
      await app.close();
    }
  });

  test('rotates credentials, rotates webhook secret once, and disables webhook credential reads', async () => {
    const { app, credentialStore, repository } = await createAppHarness();

    try {
      const created = await createConnection(app);
      const rotateCredentials = await app.inject({
        headers: authHeaders(),
        method: 'PATCH',
        payload: { consumerKey: 'ck_rotated', consumerSecret: 'cs_rotated' },
        url: `/admin/commerce-connections/woocommerce/${created.id}/credentials`
      });
      const rotateWebhook = await app.inject({
        headers: authHeaders(),
        method: 'PATCH',
        payload: {},
        url: `/admin/commerce-connections/woocommerce/${created.id}/webhook-secret`
      });
      const disable = await app.inject({
        headers: authHeaders(),
        method: 'PATCH',
        payload: { status: 'DISABLED' },
        url: `/admin/commerce-connections/woocommerce/${created.id}/status`
      });

      expect(rotateCredentials.statusCode).toBe(200);
      expect(rotateCredentials.body).not.toContain('ck_rotated');
      expect(rotateCredentials.body).not.toContain('cs_rotated');
      expect(rotateWebhook.statusCode).toBe(200);
      expect(parseJson<WooConnectionResponse>(rotateWebhook.body).data.webhookSetup?.oneTimeSecret).toBe('generated-whsec');
      expect(disable.statusCode).toBe(200);
      expect(parseJson<WooConnectionResponse>(disable.body).data.connection.status).toBe('DISABLED');
      await expect(credentialStore.readWooCommerceWebhookConnection({ connectionId: created.id })).resolves.toBeNull();
      expect(repository.auditLogs.map((log) => log.action)).toEqual(
        expect.arrayContaining([
          'woocommerce_connection.rotate_credentials',
          'woocommerce_connection.rotate_webhook_secret',
          'woocommerce_connection.status'
        ])
      );
    } finally {
      await app.close();
    }
  });

  test('rejects out-of-scope tenant access before returning connection metadata', async () => {
    const tenantB = await createAppHarness({ actor: { allowedShopDomains: ['tenant-b.example.test'], subject: 'tenant-b-admin' } });
    const tenantBConnection = await createConnection(tenantB.app, authHeaders(), {
      shopDomain: 'tenant-b.example.test',
      siteUrl: 'https://tenant-b-woo.example.test'
    });
    await tenantB.app.close();

    const tenantA = await createAppHarness({
      actor: { allowedShopDomains: ['tenant-a.example.test'], subject: 'tenant-a-admin' },
      repository: tenantB.repository
    });

    try {
      const response = await tenantA.app.inject({
        headers: authHeaders(),
        method: 'GET',
        url: `/admin/commerce-connections/woocommerce/${tenantBConnection.id}`
      });

      expect(response.statusCode).toBe(403);
      expect(response.body).not.toContain('tenant-b-woo.example.test');
    } finally {
      await tenantA.app.close();
    }
  });
});

async function createAppHarness(options: {
  actor?: AdminCommerceActor;
  repository?: ReturnType<typeof createRepositoryHarness>;
} = {}) {
  const repository = options.repository ?? createRepositoryHarness();
  const credentialStore = new CommerceConnectionCredentialService({ credentialKey: encryptionKey, repository });
  const verifier = {
    verify: vi.fn((input: { consumerKey: string; consumerSecret: string; siteUrl: string }) => {
      if (input.consumerKey.includes('invalid') || input.consumerSecret.includes('invalid')) {
        return Promise.reject(
          new WooCommerceCredentialVerificationError(
            'WooCommerce REST API rejected the supplied credentials',
            'WOOCOMMERCE_UNAUTHORIZED'
          )
        );
      }
      return Promise.resolve({ checkedAt, status: 'VERIFIED' as const });
    })
  };
  const service = new WooCommerceConnectionOnboardingService({
    credentialStore,
    now: () => now,
    repository,
    verifier,
    webhookSecretGenerator: () => 'generated-whsec'
  });
  const dependencies: AdminCommerceConnectionsDependencies = {
    adminTokenVerifier: {
      verify: (token: string) => {
        if (token !== 'admin-token') throw new Error('bad token');
        return options.actor ?? { allowedShopDomains: ['tenant-a.example.test'], subject: 'operator-1' };
      }
    },
    onboardingService: service,
    publicBaseUrl: 'https://delivery.example.test'
  };
  return { app: await buildApp({ adminCommerceConnections: dependencies }), credentialStore, repository, verifier };
}

function createRepositoryHarness() {
  const records = new Map<string, CommerceConnectionRecord>();
  const auditLogs: Array<{
    action: string;
    actorSubject: string;
    commerceConnectionId: string | null;
    metadata: unknown;
    shopDomain: string;
    status: string;
  }> = [];
  let nextRecordId = 1;

  return {
    auditLogs,
    records,
    createWooCommerceConnection(input: WooCommerceConnectionWriteInput): Promise<CommerceConnectionRecord> {
      const record = toRecord(input, { id: input.connectionId || `11111111-1111-4111-8111-${String(nextRecordId++).padStart(12, '0')}` });
      records.set(record.id, record);
      return Promise.resolve(record);
    },
    findConnectionById(input: { connectionId: string }): Promise<CommerceConnectionRecord | null> {
      return Promise.resolve(records.get(input.connectionId) ?? null);
    },
    findWooCommerceConnectionByShopAndSite(input: { shopDomain: string; siteUrl: string }): Promise<CommerceConnectionRecord | null> {
      return Promise.resolve(
        [...records.values()].find(
          (record) => record.shopDomain === input.shopDomain && record.siteUrl === input.siteUrl
        ) ?? null
      );
    },
    listWooCommerceConnectionsByShop(input: { shopDomain: string }): Promise<CommerceConnectionRecord[]> {
      return Promise.resolve([...records.values()].filter((record) => record.shopDomain === input.shopDomain));
    },
    recordCommerceConnectionAuditLog(input: {
      action: string;
      actorSubject: string;
      commerceConnectionId?: string | null;
      metadata?: unknown;
      shopDomain: string;
      status: string;
    }): Promise<void> {
      auditLogs.push({
        action: input.action,
        actorSubject: input.actorSubject,
        commerceConnectionId: input.commerceConnectionId ?? null,
        metadata: input.metadata ?? null,
        shopDomain: input.shopDomain,
        status: input.status
      });
      return Promise.resolve();
    },
    updateWooCommerceConnection(input: WooCommerceConnectionWriteInput): Promise<CommerceConnectionRecord> {
      const previous = records.get(input.connectionId);
      const record = toRecord(input, previous === undefined ? {} : { previous });
      records.set(record.id, record);
      return Promise.resolve(record);
    },
    updateWooCommerceConnectionStatus(input: { connectionId: string; status: 'ACTIVE' | 'DISABLED' }): Promise<CommerceConnectionRecord> {
      const previous = requireRecord(records, input.connectionId);
      const record = { ...previous, status: input.status };
      records.set(record.id, record);
      return Promise.resolve(record);
    },
    updateWooCommerceCredentialCiphertexts(input: {
      at: Date;
      connectionId: string;
      consumerKeyCiphertext: string;
      consumerSecretCiphertext: string;
      credentialFingerprint: string;
      lastVerificationStatus: string;
    }): Promise<CommerceConnectionRecord> {
      const previous = requireRecord(records, input.connectionId);
      const record = {
        ...previous,
        consumerKeyCiphertext: input.consumerKeyCiphertext,
        consumerSecretCiphertext: input.consumerSecretCiphertext,
        credentialFingerprint: input.credentialFingerprint,
        credentialRotatedAt: input.at,
        lastVerifiedAt: input.at,
        lastVerificationStatus: input.lastVerificationStatus
      };
      records.set(record.id, record);
      return Promise.resolve(record);
    },
    updateWooCommerceWebhookSecretCiphertext(input: {
      at: Date;
      connectionId: string;
      webhookSecretCiphertext: string;
    }): Promise<CommerceConnectionRecord> {
      const previous = requireRecord(records, input.connectionId);
      const record = {
        ...previous,
        webhookSecretCiphertext: input.webhookSecretCiphertext,
        webhookSecretRotatedAt: input.at
      };
      records.set(record.id, record);
      return Promise.resolve(record);
    }
  };
}

function toRecord(
  input: WooCommerceConnectionWriteInput,
  options: { id?: string; previous?: CommerceConnectionRecord } = {}
): CommerceConnectionRecord {
  return {
    credentialFingerprint: input.credentialFingerprint ?? options.previous?.credentialFingerprint ?? null,
    credentialRotatedAt: input.credentialRotatedAt ?? options.previous?.credentialRotatedAt ?? null,
    consumerKeyCiphertext: input.consumerKeyCiphertext,
    consumerSecretCiphertext: input.consumerSecretCiphertext,
    id: options.id ?? input.connectionId,
    label: input.label,
    lastRestSyncAt: options.previous?.lastRestSyncAt ?? null,
    lastVerifiedAt: input.lastVerifiedAt ?? options.previous?.lastVerifiedAt ?? null,
    lastVerificationStatus: input.lastVerificationStatus ?? options.previous?.lastVerificationStatus ?? null,
    lastWebhookAt: options.previous?.lastWebhookAt ?? null,
    platform: 'WOOCOMMERCE',
    shopDomain: input.shopDomain,
    shopId: `shop-${input.shopDomain}`,
    siteUrl: input.siteUrl,
    status: options.previous?.status ?? 'ACTIVE',
    timezone: input.timezone,
    webhookSecretCiphertext: input.webhookSecretCiphertext,
    webhookSecretRotatedAt: input.webhookSecretRotatedAt ?? options.previous?.webhookSecretRotatedAt ?? null
  };
}

function requireRecord(records: Map<string, CommerceConnectionRecord>, id: string): CommerceConnectionRecord {
  const record = records.get(id);
  if (record === undefined) throw new Error(`Missing record ${id}`);
  return record;
}

async function createConnection(
  app: Awaited<ReturnType<typeof buildApp>>,
  headers: Record<string, string> = authHeaders(),
  overrides: Partial<ReturnType<typeof credentialPayload>> = {}
): Promise<{ id: string }> {
  const response = await app.inject({
    headers,
    method: 'POST',
    payload: credentialPayload(overrides),
    url: '/admin/commerce-connections/woocommerce'
  });
  expect(response.statusCode).toBe(201);
  return parseJson<WooConnectionResponse>(response.body).data.connection;
}

function parseJson<T>(body: string): T {
  const parsed: unknown = JSON.parse(body);
  return parsed as T;
}

function authHeaders(): { authorization: string } {
  return { authorization: 'Bearer admin-token' };
}

function credentialPayload(overrides: Partial<{
  consumerKey: string;
  consumerSecret: string;
  label: string;
  shopDomain: string;
  siteUrl: string;
  timezone: string;
  webhookSecret: string;
}> = {}) {
  return {
    consumerKey: 'ck_test_value',
    consumerSecret: 'cs_test_value',
    label: 'Woo main',
    shopDomain: 'tenant-a.example.test',
    siteUrl: 'https://woo.example.test',
    timezone: 'America/Toronto',
    ...overrides
  };
}
