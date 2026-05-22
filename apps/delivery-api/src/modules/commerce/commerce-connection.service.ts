import { randomUUID } from 'node:crypto';

import type { TokenEncryptionKey } from '../security/token-encryption.js';
import {
  decryptCommerceCredential,
  encryptCommerceCredential
} from './commerce-credential-encryption.js';
import {
  normalizeCommerceSiteUrl,
  normalizeShopDomain,
  type CommerceConnectionRecord
} from './commerce-connection.repository.js';

type CommerceConnectionRepository = {
  createWooCommerceConnection(input: WooCommerceConnectionWrite): Promise<CommerceConnectionRecord>;
  findConnectionById(input: { connectionId: string }): Promise<CommerceConnectionRecord | null>;
  findWooCommerceConnectionByShopAndSite(input: {
    shopDomain: string;
    siteUrl: string;
  }): Promise<CommerceConnectionRecord | null>;
  markWooCommerceWebhookAccepted?(input: { at: Date; connectionId: string }): Promise<void>;
  updateWooCommerceCredentialCiphertexts?(input: {
    at: Date;
    connectionId: string;
    consumerKeyCiphertext: string;
    consumerSecretCiphertext: string;
    credentialFingerprint: string;
    lastVerificationStatus: string;
  }): Promise<CommerceConnectionRecord>;
  updateWooCommerceConnection(input: WooCommerceConnectionWrite): Promise<CommerceConnectionRecord>;
  updateWooCommerceConnectionStatus?(input: {
    connectionId: string;
    status: 'ACTIVE' | 'DISABLED';
  }): Promise<CommerceConnectionRecord>;
  updateWooCommerceWebhookSecretCiphertext?(input: {
    at: Date;
    connectionId: string;
    webhookSecretCiphertext: string;
  }): Promise<CommerceConnectionRecord>;
};

type WooCommerceConnectionWrite = {
  connectionId: string;
  credentialFingerprint?: string | null;
  credentialRotatedAt?: Date | null;
  consumerKeyCiphertext: string;
  consumerSecretCiphertext: string;
  label: string | null;
  lastVerifiedAt?: Date | null;
  lastVerificationStatus?: string | null;
  shopDomain: string;
  siteUrl: string;
  timezone: string | null;
  webhookSecretCiphertext: string;
  webhookSecretRotatedAt?: Date | null;
};

export type UpsertWooCommerceConnectionInput = {
  consumerKey: string;
  credentialFingerprint?: string | null;
  credentialRotatedAt?: Date | null;
  consumerSecret: string;
  label?: string | null;
  lastVerifiedAt?: Date | null;
  lastVerificationStatus?: string | null;
  shopDomain: string;
  siteUrl: string;
  timezone?: string | null;
  webhookSecret: string;
  webhookSecretRotatedAt?: Date | null;
};

type NormalizedWooCommerceConnectionInput = {
  consumerKey: string;
  consumerSecret: string;
  label: string | null;
  shopDomain: string;
  siteUrl: string;
  timezone: string | null;
  webhookSecret: string;
};

export type SafeWooCommerceConnection = {
  credential: {
    fingerprint: string | null;
    rotatedAt: string | null;
    status: 'stored';
  };
  id: string;
  label: string | null;
  lastRestSyncAt: string | null;
  lastWebhookAt: string | null;
  shopDomain: string;
  siteUrl: string;
  status: 'ACTIVE' | 'DISABLED';
  timezone: string | null;
  verification: {
    lastVerifiedAt: string | null;
    status: string | null;
  };
  webhook: {
    rotatedAt: string | null;
    status: 'stored';
  };
};

export type DecryptedWooCommerceConnection = SafeWooCommerceConnection & {
  consumerKey: string;
  consumerSecret: string;
  webhookSecret: string;
};

export type WooCommerceWebhookConnection = SafeWooCommerceConnection & {
  webhookSecret: string;
};

export class CommerceConnectionCredentialService {
  constructor(
    private readonly options: {
      credentialKey: TokenEncryptionKey;
      repository: CommerceConnectionRepository;
    }
  ) {}

  async upsertWooCommerceConnection(
    input: UpsertWooCommerceConnectionInput
  ): Promise<SafeWooCommerceConnection> {
    const normalized = normalizeWooCommerceConnectionInput(input);
    const existing = await this.options.repository.findWooCommerceConnectionByShopAndSite({
      shopDomain: normalized.shopDomain,
      siteUrl: normalized.siteUrl
    });
    const connectionId = existing?.id ?? randomUUID();
    const write = this.encryptWrite({
      connectionId,
      consumerKey: normalized.consumerKey,
      credentialFingerprint: input.credentialFingerprint ?? null,
      credentialRotatedAt: input.credentialRotatedAt ?? null,
      consumerSecret: normalized.consumerSecret,
      label: normalized.label,
      lastVerifiedAt: input.lastVerifiedAt ?? null,
      lastVerificationStatus: input.lastVerificationStatus ?? null,
      shopDomain: normalized.shopDomain,
      siteUrl: normalized.siteUrl,
      timezone: normalized.timezone,
      webhookSecret: normalized.webhookSecret,
      webhookSecretRotatedAt: input.webhookSecretRotatedAt ?? null
    });
    const record =
      existing === null
        ? await this.options.repository.createWooCommerceConnection(write)
        : await this.options.repository.updateWooCommerceConnection(write);

    return toSafeWooCommerceConnection(record);
  }

  async readDecryptedWooCommerceConnection(input: {
    connectionId: string;
  }): Promise<DecryptedWooCommerceConnection | null> {
    const record = await this.options.repository.findConnectionById({
      connectionId: input.connectionId
    });
    if (record === null || record.platform !== 'WOOCOMMERCE' || record.status !== 'ACTIVE') {
      return null;
    }

    return {
      ...toSafeWooCommerceConnection(record),
      consumerKey: decryptCommerceCredential({
        ciphertext: record.consumerKeyCiphertext,
        connectionId: record.id,
        key: this.options.credentialKey,
        kind: 'consumer-key'
      }),
      consumerSecret: decryptCommerceCredential({
        ciphertext: record.consumerSecretCiphertext,
        connectionId: record.id,
        key: this.options.credentialKey,
        kind: 'consumer-secret'
      }),
      webhookSecret: decryptCommerceCredential({
        ciphertext: record.webhookSecretCiphertext,
        connectionId: record.id,
        key: this.options.credentialKey,
        kind: 'webhook-secret'
      })
    };
  }

  async readWooCommerceWebhookConnection(input: {
    connectionId: string;
  }): Promise<WooCommerceWebhookConnection | null> {
    const record = await this.options.repository.findConnectionById({
      connectionId: input.connectionId
    });
    if (record === null || record.platform !== 'WOOCOMMERCE' || record.status !== 'ACTIVE') {
      return null;
    }

    return {
      ...toSafeWooCommerceConnection(record),
      webhookSecret: decryptCommerceCredential({
        ciphertext: record.webhookSecretCiphertext,
        connectionId: record.id,
        key: this.options.credentialKey,
        kind: 'webhook-secret'
      })
    };
  }

  markWooCommerceWebhookAccepted(input: { at: Date; connectionId: string }): Promise<void> {
    if (this.options.repository.markWooCommerceWebhookAccepted === undefined) {
      return Promise.resolve();
    }
    return this.options.repository.markWooCommerceWebhookAccepted(input);
  }

  async rotateWooCommerceCredentials(input: {
    at: Date;
    connectionId: string;
    consumerKey: string;
    consumerSecret: string;
    credentialFingerprint: string;
    lastVerificationStatus: string;
  }): Promise<SafeWooCommerceConnection> {
    if (this.options.repository.updateWooCommerceCredentialCiphertexts === undefined) {
      throw new Error('WooCommerce credential rotation is not supported by the repository');
    }
    const consumerKey = readRequiredSecret(input.consumerKey, 'WooCommerce consumer key');
    const consumerSecret = readRequiredSecret(input.consumerSecret, 'WooCommerce consumer secret');
    const record = await this.options.repository.updateWooCommerceCredentialCiphertexts({
      at: input.at,
      connectionId: input.connectionId,
      consumerKeyCiphertext: encryptCommerceCredential({
        connectionId: input.connectionId,
        key: this.options.credentialKey,
        kind: 'consumer-key',
        plaintext: consumerKey
      }),
      consumerSecretCiphertext: encryptCommerceCredential({
        connectionId: input.connectionId,
        key: this.options.credentialKey,
        kind: 'consumer-secret',
        plaintext: consumerSecret
      }),
      credentialFingerprint: input.credentialFingerprint,
      lastVerificationStatus: input.lastVerificationStatus
    });
    return toSafeWooCommerceConnection(record);
  }

  async rotateWooCommerceWebhookSecret(input: {
    at: Date;
    connectionId: string;
    webhookSecret: string;
  }): Promise<SafeWooCommerceConnection> {
    if (this.options.repository.updateWooCommerceWebhookSecretCiphertext === undefined) {
      throw new Error('WooCommerce webhook secret rotation is not supported by the repository');
    }
    const webhookSecret = readRequiredSecret(input.webhookSecret, 'WooCommerce webhook secret');
    const record = await this.options.repository.updateWooCommerceWebhookSecretCiphertext({
      at: input.at,
      connectionId: input.connectionId,
      webhookSecretCiphertext: encryptCommerceCredential({
        connectionId: input.connectionId,
        key: this.options.credentialKey,
        kind: 'webhook-secret',
        plaintext: webhookSecret
      })
    });
    return toSafeWooCommerceConnection(record);
  }

  async updateWooCommerceConnectionStatus(input: {
    connectionId: string;
    status: 'ACTIVE' | 'DISABLED';
  }): Promise<SafeWooCommerceConnection> {
    if (this.options.repository.updateWooCommerceConnectionStatus === undefined) {
      throw new Error('WooCommerce status updates are not supported by the repository');
    }
    return toSafeWooCommerceConnection(
      await this.options.repository.updateWooCommerceConnectionStatus(input)
    );
  }

  private encryptWrite(input: {
    connectionId: string;
    consumerKey: string;
    credentialFingerprint: string | null;
    credentialRotatedAt: Date | null;
    consumerSecret: string;
    label: string | null;
    lastVerifiedAt: Date | null;
    lastVerificationStatus: string | null;
    shopDomain: string;
    siteUrl: string;
    timezone: string | null;
    webhookSecret: string;
    webhookSecretRotatedAt: Date | null;
  }): WooCommerceConnectionWrite {
    return {
      connectionId: input.connectionId,
      credentialFingerprint: input.credentialFingerprint,
      credentialRotatedAt: input.credentialRotatedAt,
      consumerKeyCiphertext: encryptCommerceCredential({
        connectionId: input.connectionId,
        key: this.options.credentialKey,
        kind: 'consumer-key',
        plaintext: input.consumerKey
      }),
      consumerSecretCiphertext: encryptCommerceCredential({
        connectionId: input.connectionId,
        key: this.options.credentialKey,
        kind: 'consumer-secret',
        plaintext: input.consumerSecret
      }),
      label: input.label,
      lastVerifiedAt: input.lastVerifiedAt,
      lastVerificationStatus: input.lastVerificationStatus,
      shopDomain: input.shopDomain,
      siteUrl: input.siteUrl,
      timezone: input.timezone,
      webhookSecretCiphertext: encryptCommerceCredential({
        connectionId: input.connectionId,
        key: this.options.credentialKey,
        kind: 'webhook-secret',
        plaintext: input.webhookSecret
      }),
      webhookSecretRotatedAt: input.webhookSecretRotatedAt
    };
  }
}

function normalizeWooCommerceConnectionInput(
  input: UpsertWooCommerceConnectionInput
): NormalizedWooCommerceConnectionInput {
  return {
    consumerKey: readRequiredSecret(input.consumerKey, 'WooCommerce consumer key'),
    consumerSecret: readRequiredSecret(input.consumerSecret, 'WooCommerce consumer secret'),
    label: readNullableString(input.label ?? null),
    shopDomain: normalizeShopDomain(input.shopDomain),
    siteUrl: normalizeCommerceSiteUrl(input.siteUrl),
    timezone: readNullableString(input.timezone ?? null),
    webhookSecret: readRequiredSecret(input.webhookSecret, 'WooCommerce webhook secret')
  };
}

export function toSafeWooCommerceConnection(record: CommerceConnectionRecord): SafeWooCommerceConnection {
  return {
    credential: {
      fingerprint: record.credentialFingerprint,
      rotatedAt: record.credentialRotatedAt?.toISOString() ?? null,
      status: 'stored'
    },
    id: record.id,
    label: record.label,
    lastRestSyncAt: record.lastRestSyncAt?.toISOString() ?? null,
    lastWebhookAt: record.lastWebhookAt?.toISOString() ?? null,
    shopDomain: record.shopDomain,
    siteUrl: record.siteUrl,
    status: record.status,
    timezone: record.timezone,
    verification: {
      lastVerifiedAt: record.lastVerifiedAt?.toISOString() ?? null,
      status: record.lastVerificationStatus
    },
    webhook: {
      rotatedAt: record.webhookSecretRotatedAt?.toISOString() ?? null,
      status: 'stored'
    }
  };
}

function readRequiredSecret(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed === '') throw new Error(`${label} is required`);
  return trimmed;
}

function readNullableString(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
