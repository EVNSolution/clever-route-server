import { createHash, randomBytes } from 'node:crypto';

import { normalizeCommerceSiteUrl } from '../commerce/commerce-connection.repository.js';
import type {
  WordPressPluginConnectionContext,
  WordPressPluginPairInput,
  WordPressPluginPairResult
} from './wordpress-plugin.types.js';

type PairingCodeConnectionRecord = {
  id: string;
  label: string | null;
  shopDomain: string;
  shopId: string;
  siteUrl: string;
  status: 'ACTIVE' | 'DISABLED';
};

type PairingCodeRecord = {
  commerceConnection: PairingCodeConnectionRecord;
  commerceConnectionId: string;
  consumedAt: Date | null;
  expiresAt: Date;
  id: string;
  shopId: string;
  siteUrl: string;
};

type PluginTokenRecord = {
  commerceConnection: PairingCodeConnectionRecord;
  id: string;
  status: 'ACTIVE' | 'REVOKED';
  tokenPrefix: string;
};

export type WordPressPluginAuthRepository = {
  consumePairingCode(input: {
    consumedAt: Date;
    consumedBySiteUrl: string;
    pairingCodeId: string;
  }): Promise<boolean>;
  createPluginToken(input: {
    commerceConnectionId: string;
    issuedAt: Date;
    tokenHash: string;
    tokenPrefix: string;
  }): Promise<{ id: string; tokenPrefix: string }>;
  findPairingCodeByHash(input: { codeHash: string }): Promise<PairingCodeRecord | null>;
  findPluginTokenByHash(input: { tokenHash: string }): Promise<PluginTokenRecord | null>;
  incrementPairingCodeFailedAttempt(input: { failedAt: Date; pairingCodeId: string }): Promise<void>;
  touchPluginToken(input: { lastUsedAt: Date; tokenId: string }): Promise<void>;
};

export class WordPressPluginPairingExpiredError extends Error {
  constructor() {
    super('WordPress plugin pairing code has expired');
    this.name = 'WordPressPluginPairingExpiredError';
  }
}

export class WordPressPluginPairingConsumedError extends Error {
  constructor() {
    super('WordPress plugin pairing code has already been consumed');
    this.name = 'WordPressPluginPairingConsumedError';
  }
}

export class WordPressPluginPairingInvalidError extends Error {
  constructor() {
    super('WordPress plugin pairing code is invalid');
    this.name = 'WordPressPluginPairingInvalidError';
  }
}

export class WordPressPluginConnectionDisabledError extends Error {
  constructor() {
    super('WordPress plugin connection is disabled');
    this.name = 'WordPressPluginConnectionDisabledError';
  }
}

export class WordPressPluginAuthService {
  constructor(
    private readonly options: {
      now?: () => Date;
      repository: WordPressPluginAuthRepository;
    }
  ) {}

  async pairPlugin(input: WordPressPluginPairInput): Promise<WordPressPluginPairResult> {
    const now = this.now();
    const normalizedCode = normalizeSecret(input.pairingCode);
    const normalizedSiteUrl = normalizeCommerceSiteUrl(input.siteUrl);
    const pairingCode = await this.options.repository.findPairingCodeByHash({
      codeHash: hashSecret(normalizedCode)
    });

    if (pairingCode === null) {
      throw new WordPressPluginPairingInvalidError();
    }

    if (pairingCode.consumedAt !== null) {
      throw new WordPressPluginPairingConsumedError();
    }

    if (pairingCode.expiresAt.getTime() <= now.getTime()) {
      await this.options.repository.incrementPairingCodeFailedAttempt({
        failedAt: now,
        pairingCodeId: pairingCode.id
      });
      throw new WordPressPluginPairingExpiredError();
    }

    if (
      pairingCode.siteUrl !== normalizedSiteUrl ||
      pairingCode.commerceConnection.siteUrl !== normalizedSiteUrl ||
      pairingCode.commerceConnection.status !== 'ACTIVE'
    ) {
      await this.options.repository.incrementPairingCodeFailedAttempt({
        failedAt: now,
        pairingCodeId: pairingCode.id
      });
      throw new WordPressPluginPairingInvalidError();
    }

    const consumed = await this.options.repository.consumePairingCode({
      consumedAt: now,
      consumedBySiteUrl: normalizedSiteUrl,
      pairingCodeId: pairingCode.id
    });
    if (!consumed) {
      throw new WordPressPluginPairingConsumedError();
    }

    const token = generatePluginToken();
    const tokenPrefix = safeTokenPrefix(token);
    const createdToken = await this.options.repository.createPluginToken({
      commerceConnectionId: pairingCode.commerceConnectionId,
      issuedAt: now,
      tokenHash: hashSecret(token),
      tokenPrefix
    });

    return {
      connectionId: pairingCode.commerceConnectionId,
      expiresAt: pairingCode.expiresAt.toISOString(),
      siteUrl: normalizedSiteUrl,
      token,
      tokenPrefix: createdToken.tokenPrefix
    };
  }

  async authenticateToken(token: string): Promise<WordPressPluginConnectionContext | null> {
    const normalizedToken = normalizeSecret(token);
    const tokenRecord = await this.options.repository.findPluginTokenByHash({
      tokenHash: hashSecret(normalizedToken)
    });

    if (tokenRecord === null || tokenRecord.status !== 'ACTIVE') {
      return null;
    }

    if (tokenRecord.commerceConnection.status !== 'ACTIVE') {
      throw new WordPressPluginConnectionDisabledError();
    }

    return {
      connectionId: tokenRecord.commerceConnection.id,
      label: tokenRecord.commerceConnection.label,
      shopDomain: tokenRecord.commerceConnection.shopDomain,
      shopId: tokenRecord.commerceConnection.shopId,
      siteUrl: tokenRecord.commerceConnection.siteUrl,
      status: tokenRecord.commerceConnection.status,
      tokenId: tokenRecord.id,
      tokenPrefix: tokenRecord.tokenPrefix
    };
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

export function createPairingCode(): string {
  return `crp-pair-${randomBytes(18).toString('base64url')}`;
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(normalizeSecret(secret), 'utf8').digest('hex');
}

export function safeTokenPrefix(token: string): string {
  return token.slice(0, 16);
}

function generatePluginToken(): string {
  return `crp_${randomBytes(6).toString('hex')}_${randomBytes(32).toString('base64url')}`;
}

function normalizeSecret(secret: string): string {
  const normalized = secret.trim();
  if (normalized === '') {
    throw new WordPressPluginPairingInvalidError();
  }
  return normalized;
}
