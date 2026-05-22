import { createHash, randomBytes } from 'node:crypto';

import {
  canAccessShopDomain,
  describeAllowedShopDomains,
  type AdminCommerceActor
} from './admin-commerce-auth.js';
import type { CommerceConnectionRecord, CommerceConnectionAuditLogInput } from './commerce-connection.repository.js';
import {
  type SafeWooCommerceConnection,
  toSafeWooCommerceConnection
} from './commerce-connection.service.js';
import { assertHttpsWooSiteUrl, WooCommerceCredentialVerificationError } from './woocommerce-connection-verifier.js';

const MAX_LABEL_LENGTH = 128;
const MAX_TIMEZONE_LENGTH = 64;
const MAX_SECRET_LENGTH = 512;
const MAX_SITE_URL_LENGTH = 2048;
const WEBHOOK_SECRET_BYTES = 32;

export type WooCommerceCredentialVerifier = {
  verify(input: {
    consumerKey: string;
    consumerSecret: string;
    siteUrl: string;
  }): Promise<{ checkedAt: Date; status: 'VERIFIED' }>;
};

export type WooCommerceCredentialStore = {
  rotateWooCommerceCredentials(input: {
    at: Date;
    connectionId: string;
    consumerKey: string;
    consumerSecret: string;
    credentialFingerprint: string;
    lastVerificationStatus: string;
  }): Promise<SafeWooCommerceConnection>;
  rotateWooCommerceWebhookSecret(input: {
    at: Date;
    connectionId: string;
    webhookSecret: string;
  }): Promise<SafeWooCommerceConnection>;
  updateWooCommerceConnectionStatus(input: {
    connectionId: string;
    status: 'ACTIVE' | 'DISABLED';
  }): Promise<SafeWooCommerceConnection>;
  upsertWooCommerceConnection(input: {
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
  }): Promise<SafeWooCommerceConnection>;
};

export type WooCommerceOnboardingRepository = {
  findConnectionById(input: { connectionId: string }): Promise<CommerceConnectionRecord | null>;
  listWooCommerceConnectionsByShop(input: { shopDomain: string }): Promise<CommerceConnectionRecord[]>;
  recordCommerceConnectionAuditLog?(input: CommerceConnectionAuditLogInput): Promise<void>;
};

export type WooCommerceOnboardingInput = {
  actor: AdminCommerceActor;
  consumerKey: string;
  consumerSecret: string;
  label?: string | null;
  shopDomain: string;
  siteUrl: string;
  timezone?: string | null;
  webhookSecret?: string | null;
};

export type WooCommerceOnboardingResult = {
  connection: SafeWooCommerceConnection;
  webhookSetup?: {
    oneTimeSecret?: string;
  };
};

export class WooCommerceOnboardingError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: 400 | 403 | 404 | 422
  ) {
    super(message);
    this.name = 'WooCommerceOnboardingError';
  }
}

export class WooCommerceConnectionOnboardingService {
  constructor(
    private readonly options: {
      credentialStore: WooCommerceCredentialStore;
      now?: () => Date;
      repository: WooCommerceOnboardingRepository;
      verifier: WooCommerceCredentialVerifier;
      webhookSecretGenerator?: () => string;
    }
  ) {}

  async testConnection(input: WooCommerceOnboardingInput): Promise<{ checkedAt: string; status: 'VERIFIED' }> {
    const normalized = normalizeCredentialInput(input);
    assertActorCanAccessShop(input.actor, normalized.shopDomain);

    try {
      const verification = await this.options.verifier.verify({
        consumerKey: normalized.consumerKey,
        consumerSecret: normalized.consumerSecret,
        siteUrl: normalized.siteUrl
      });
      await this.recordAudit({
        action: 'woocommerce_connection.test',
        actor: input.actor,
        metadata: { siteUrl: normalized.siteUrl, verificationStatus: verification.status },
        shopDomain: normalized.shopDomain,
        status: 'success'
      });
      return { checkedAt: verification.checkedAt.toISOString(), status: verification.status };
    } catch (error) {
      await this.recordAudit({
        action: 'woocommerce_connection.test',
        actor: input.actor,
        metadata: { siteUrl: normalized.siteUrl, verificationStatus: 'FAILED' },
        shopDomain: normalized.shopDomain,
        status: 'failed'
      });
      throw toOnboardingVerificationError(error);
    }
  }

  async createConnection(input: WooCommerceOnboardingInput): Promise<WooCommerceOnboardingResult> {
    const normalized = normalizeCredentialInput(input);
    assertActorCanAccessShop(input.actor, normalized.shopDomain);
    const suppliedWebhookSecret = readOptionalSecret(input.webhookSecret);
    const webhookSecret = suppliedWebhookSecret ?? this.generateWebhookSecret();

    let verification: { checkedAt: Date; status: 'VERIFIED' };
    try {
      verification = await this.options.verifier.verify({
        consumerKey: normalized.consumerKey,
        consumerSecret: normalized.consumerSecret,
        siteUrl: normalized.siteUrl
      });
    } catch (error) {
      await this.recordAudit({
        action: 'woocommerce_connection.create',
        actor: input.actor,
        metadata: { siteUrl: normalized.siteUrl, verificationStatus: 'FAILED' },
        shopDomain: normalized.shopDomain,
        status: 'failed'
      });
      throw toOnboardingVerificationError(error);
    }

    const now = this.now();
    const connection = await this.options.credentialStore.upsertWooCommerceConnection({
      consumerKey: normalized.consumerKey,
      credentialFingerprint: fingerprintCredential(normalized.consumerKey),
      credentialRotatedAt: now,
      consumerSecret: normalized.consumerSecret,
      label: normalized.label,
      lastVerifiedAt: verification.checkedAt,
      lastVerificationStatus: verification.status,
      shopDomain: normalized.shopDomain,
      siteUrl: normalized.siteUrl,
      timezone: normalized.timezone,
      webhookSecret,
      webhookSecretRotatedAt: now
    });
    await this.recordAudit({
      action: 'woocommerce_connection.create',
      actor: input.actor,
      commerceConnectionId: connection.id,
      metadata: { siteUrl: connection.siteUrl, verificationStatus: verification.status },
      shopDomain: connection.shopDomain,
      status: 'success'
    });
    return {
      connection,
      webhookSetup: suppliedWebhookSecret === null ? { oneTimeSecret: webhookSecret } : {}
    };
  }

  async listConnections(input: {
    actor: AdminCommerceActor;
    shopDomain?: string | null;
  }): Promise<SafeWooCommerceConnection[]> {
    const shopDomain = resolveRequestedShopDomain(input.actor, input.shopDomain);
    const records = await this.options.repository.listWooCommerceConnectionsByShop({ shopDomain });
    return records.map((record) => toSafeWooCommerceConnection(record));
  }

  async getConnection(input: {
    actor: AdminCommerceActor;
    connectionId: string;
  }): Promise<SafeWooCommerceConnection> {
    const record = await this.requireScopedConnection(input);
    return toSafeWooCommerceConnection(record);
  }

  async rotateCredentials(input: {
    actor: AdminCommerceActor;
    connectionId: string;
    consumerKey: string;
    consumerSecret: string;
  }): Promise<SafeWooCommerceConnection> {
    const record = await this.requireScopedConnection(input);
    const consumerKey = readRequiredSecret(input.consumerKey, 'WooCommerce consumer key');
    const consumerSecret = readRequiredSecret(input.consumerSecret, 'WooCommerce consumer secret');

    let verification: { checkedAt: Date; status: 'VERIFIED' };
    try {
      verification = await this.options.verifier.verify({
        consumerKey,
        consumerSecret,
        siteUrl: record.siteUrl
      });
    } catch (error) {
      await this.recordAudit({
        action: 'woocommerce_connection.rotate_credentials',
        actor: input.actor,
        commerceConnectionId: record.id,
        metadata: { siteUrl: record.siteUrl, verificationStatus: 'FAILED' },
        shopDomain: record.shopDomain,
        status: 'failed'
      });
      throw toOnboardingVerificationError(error);
    }

    const connection = await this.options.credentialStore.rotateWooCommerceCredentials({
      at: verification.checkedAt,
      connectionId: record.id,
      consumerKey,
      consumerSecret,
      credentialFingerprint: fingerprintCredential(consumerKey),
      lastVerificationStatus: verification.status
    });
    await this.recordAudit({
      action: 'woocommerce_connection.rotate_credentials',
      actor: input.actor,
      commerceConnectionId: connection.id,
      metadata: { siteUrl: connection.siteUrl, verificationStatus: verification.status },
      shopDomain: connection.shopDomain,
      status: 'success'
    });
    return connection;
  }

  async rotateWebhookSecret(input: {
    actor: AdminCommerceActor;
    connectionId: string;
    webhookSecret?: string | null;
  }): Promise<WooCommerceOnboardingResult> {
    const record = await this.requireScopedConnection(input);
    const suppliedSecret = readOptionalSecret(input.webhookSecret);
    const webhookSecret = suppliedSecret ?? this.generateWebhookSecret();
    const connection = await this.options.credentialStore.rotateWooCommerceWebhookSecret({
      at: this.now(),
      connectionId: record.id,
      webhookSecret
    });
    await this.recordAudit({
      action: 'woocommerce_connection.rotate_webhook_secret',
      actor: input.actor,
      commerceConnectionId: connection.id,
      metadata: { siteUrl: connection.siteUrl },
      shopDomain: connection.shopDomain,
      status: 'success'
    });
    return {
      connection,
      webhookSetup: suppliedSecret === null ? { oneTimeSecret: webhookSecret } : {}
    };
  }

  async updateStatus(input: {
    actor: AdminCommerceActor;
    connectionId: string;
    status: 'ACTIVE' | 'DISABLED';
  }): Promise<SafeWooCommerceConnection> {
    const record = await this.requireScopedConnection(input);
    const connection = await this.options.credentialStore.updateWooCommerceConnectionStatus({
      connectionId: record.id,
      status: input.status
    });
    await this.recordAudit({
      action: 'woocommerce_connection.status',
      actor: input.actor,
      commerceConnectionId: connection.id,
      metadata: { siteUrl: connection.siteUrl, status: input.status },
      shopDomain: connection.shopDomain,
      status: 'success'
    });
    return connection;
  }

  private async requireScopedConnection(input: {
    actor: AdminCommerceActor;
    connectionId: string;
  }): Promise<CommerceConnectionRecord> {
    const connectionId = readConnectionId(input.connectionId);
    const record = await this.options.repository.findConnectionById({ connectionId });
    if (record === null || record.platform !== 'WOOCOMMERCE') {
      throw new WooCommerceOnboardingError('NOT_FOUND', 'WooCommerce connection not found', 404);
    }
    assertActorCanAccessShop(input.actor, record.shopDomain);
    return record;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private generateWebhookSecret(): string {
    return this.options.webhookSecretGenerator?.() ?? randomBytes(WEBHOOK_SECRET_BYTES).toString('base64url');
  }

  private async recordAudit(input: {
    action: string;
    actor: AdminCommerceActor;
    commerceConnectionId?: string;
    metadata: Record<string, string>;
    shopDomain: string;
    status: 'failed' | 'success';
  }): Promise<void> {
    if (this.options.repository.recordCommerceConnectionAuditLog === undefined) return;
    await this.options.repository.recordCommerceConnectionAuditLog({
      action: input.action,
      actorSubject: input.actor.subject,
      ...(input.commerceConnectionId === undefined ? {} : { commerceConnectionId: input.commerceConnectionId }),
      metadata: input.metadata,
      shopDomain: input.shopDomain,
      status: input.status
    });
  }
}

function normalizeCredentialInput(input: WooCommerceOnboardingInput): {
  consumerKey: string;
  consumerSecret: string;
  label: string | null;
  shopDomain: string;
  siteUrl: string;
  timezone: string | null;
} {
  return {
    consumerKey: readRequiredSecret(input.consumerKey, 'WooCommerce consumer key'),
    consumerSecret: readRequiredSecret(input.consumerSecret, 'WooCommerce consumer secret'),
    label: readOptionalText(input.label ?? null, 'label', MAX_LABEL_LENGTH),
    shopDomain: readShopDomain(input.shopDomain),
    siteUrl: readSiteUrl(input.siteUrl),
    timezone: readOptionalText(input.timezone ?? null, 'timezone', MAX_TIMEZONE_LENGTH)
  };
}

function assertActorCanAccessShop(actor: AdminCommerceActor, shopDomain: string): void {
  if (!canAccessShopDomain(actor, shopDomain)) {
    throw new WooCommerceOnboardingError(
      'FORBIDDEN',
      `Admin actor is not authorized for requested shop scope (${describeAllowedShopDomains(actor)})`,
      403
    );
  }
}

function resolveRequestedShopDomain(actor: AdminCommerceActor, value: string | null | undefined): string {
  if (value !== undefined && value !== null && value.trim() !== '') {
    const shopDomain = readShopDomain(value);
    assertActorCanAccessShop(actor, shopDomain);
    return shopDomain;
  }
  if (actor.allowedShopDomains !== '*' && actor.allowedShopDomains.length === 1) {
    const onlyShopDomain = actor.allowedShopDomains[0];
    if (onlyShopDomain !== undefined) return onlyShopDomain;
  }
  throw new WooCommerceOnboardingError('BAD_REQUEST', 'shopDomain is required for this admin actor', 400);
}

function readConnectionId(value: string): string {
  const trimmed = value.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(trimmed)) {
    throw new WooCommerceOnboardingError('BAD_REQUEST', 'WooCommerce connection id must be a UUID', 400);
  }
  return trimmed;
}

function readShopDomain(value: string): string {
  const trimmed = value.trim().toLowerCase().replace(/^https?:\/\//iu, '').replace(/\/.*$/u, '');
  if (trimmed === '') {
    throw new WooCommerceOnboardingError('BAD_REQUEST', 'shopDomain is required', 400);
  }
  if (trimmed.length > 255 || !/^[a-z0-9.-]+$/u.test(trimmed)) {
    throw new WooCommerceOnboardingError('BAD_REQUEST', 'shopDomain is invalid', 400);
  }
  return trimmed;
}

function readSiteUrl(value: string): string {
  if (value.trim().length > MAX_SITE_URL_LENGTH) {
    throw new WooCommerceOnboardingError('BAD_REQUEST', 'WooCommerce site URL is too long', 400);
  }
  try {
    return assertHttpsWooSiteUrl(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'WooCommerce site URL is invalid';
    throw new WooCommerceOnboardingError('BAD_REQUEST', message, 400);
  }
}

function readRequiredSecret(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed === '') {
    throw new WooCommerceOnboardingError('BAD_REQUEST', `${label} is required`, 400);
  }
  if (trimmed.length > MAX_SECRET_LENGTH) {
    throw new WooCommerceOnboardingError('BAD_REQUEST', `${label} is too long`, 400);
  }
  return trimmed;
}

function readOptionalSecret(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  return readRequiredSecret(value, 'WooCommerce webhook secret');
}

function readOptionalText(value: string | null, label: string, maxLength: number): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed.length > maxLength) {
    throw new WooCommerceOnboardingError('BAD_REQUEST', `${label} is too long`, 400);
  }
  return trimmed;
}

function fingerprintCredential(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
}

function toOnboardingVerificationError(error: unknown): WooCommerceOnboardingError {
  if (error instanceof WooCommerceOnboardingError) return error;
  if (error instanceof WooCommerceCredentialVerificationError) {
    return new WooCommerceOnboardingError(error.code, error.message, 422);
  }
  if (error instanceof Error) {
    if (error.message.includes('required') || error.message.includes('HTTPS') || error.message.includes('invalid')) {
      return new WooCommerceOnboardingError('BAD_REQUEST', error.message, 400);
    }
  }
  return new WooCommerceOnboardingError(
    'WOOCOMMERCE_VERIFICATION_FAILED',
    'WooCommerce REST API verification failed',
    422
  );
}
