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
  updateWooCommerceConnection(input: WooCommerceConnectionWrite): Promise<CommerceConnectionRecord>;
};

type WooCommerceConnectionWrite = {
  connectionId: string;
  consumerKeyCiphertext: string;
  consumerSecretCiphertext: string;
  label: string | null;
  shopDomain: string;
  siteUrl: string;
  timezone: string | null;
  webhookSecretCiphertext: string;
};

export type UpsertWooCommerceConnectionInput = {
  consumerKey: string;
  consumerSecret: string;
  label?: string | null;
  shopDomain: string;
  siteUrl: string;
  timezone?: string | null;
  webhookSecret: string;
};

export type SafeWooCommerceConnection = {
  id: string;
  label: string | null;
  shopDomain: string;
  siteUrl: string;
  status: 'ACTIVE' | 'DISABLED';
  timezone: string | null;
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
      consumerSecret: normalized.consumerSecret,
      label: normalized.label,
      shopDomain: normalized.shopDomain,
      siteUrl: normalized.siteUrl,
      timezone: normalized.timezone,
      webhookSecret: normalized.webhookSecret
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

  private encryptWrite(input: {
    connectionId: string;
    consumerKey: string;
    consumerSecret: string;
    label: string | null;
    shopDomain: string;
    siteUrl: string;
    timezone: string | null;
    webhookSecret: string;
  }): WooCommerceConnectionWrite {
    return {
      connectionId: input.connectionId,
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
      shopDomain: input.shopDomain,
      siteUrl: input.siteUrl,
      timezone: input.timezone,
      webhookSecretCiphertext: encryptCommerceCredential({
        connectionId: input.connectionId,
        key: this.options.credentialKey,
        kind: 'webhook-secret',
        plaintext: input.webhookSecret
      })
    };
  }
}

function normalizeWooCommerceConnectionInput(
  input: UpsertWooCommerceConnectionInput
): Required<UpsertWooCommerceConnectionInput> {
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

function toSafeWooCommerceConnection(record: CommerceConnectionRecord): SafeWooCommerceConnection {
  return {
    id: record.id,
    label: record.label,
    shopDomain: record.shopDomain,
    siteUrl: record.siteUrl,
    status: record.status,
    timezone: record.timezone
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
