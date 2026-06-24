import { DEFAULT_SHOPIFY_APP_ID, normalizeShopifyAppId } from './shopify-app-scope.js';

export type ShopifyTokenExchangeResult = {
  accessToken: string;
  expiresIn: number | null;
  refreshToken: string | null;
  refreshTokenExpiresIn: number | null;
  scope: string;
};

export type ShopifyTokenExchangeInput = {
  appId?: string | undefined;
  sessionToken: string;
  shopDomain: string;
};

type ShopifyTokenExchangeCredential = {
  appId: string;
  clientId: string;
  clientSecret: string;
};

type ShopifyTokenExchangeClientOptions = {
  appCredentials?: ShopifyTokenExchangeCredential[];
  appId?: string | undefined;
  clientId?: string;
  clientSecret?: string;
  fetchImpl?: FetchLike;
};

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

type ShopifyTokenExchangeResponse = {
  access_token?: unknown;
  expires_in?: unknown;
  refresh_token?: unknown;
  refresh_token_expires_in?: unknown;
  scope?: unknown;
};

export class ShopifyTokenExchangeClient {
  private readonly fetchImpl: FetchLike;
  private readonly appCredentials: ShopifyTokenExchangeCredential[];

  constructor(options: ShopifyTokenExchangeClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.appCredentials =
      options.appCredentials ??
      [
        {
          appId: normalizeShopifyAppId(options.appId ?? DEFAULT_SHOPIFY_APP_ID),
          clientId: requireOption(options.clientId, 'clientId'),
          clientSecret: requireOption(options.clientSecret, 'clientSecret')
        }
      ];
  }

  async exchangeSessionTokenForOfflineToken(
    input: ShopifyTokenExchangeInput
  ): Promise<ShopifyTokenExchangeResult> {
    const shopDomain = normalizeShopDomain(input.shopDomain);
    const credential = this.findCredential(input.appId);
    const body = new URLSearchParams({
      client_id: credential.clientId,
      client_secret: credential.clientSecret,
      expiring: '1',
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      requested_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
      subject_token: input.sessionToken,
      subject_token_type: 'urn:ietf:params:oauth:token-type:id_token'
    });

    const response = await this.fetchImpl(`https://${shopDomain}/admin/oauth/access_token`, {
      body,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      method: 'POST'
    });

    const payload = (await readJson(response)) as ShopifyTokenExchangeResponse;
    if (!response.ok) {
      throw new Error('Shopify token exchange failed');
    }

    return parseTokenExchangeResponse(payload);
  }

  private findCredential(appId = DEFAULT_SHOPIFY_APP_ID): ShopifyTokenExchangeCredential {
    const normalizedAppId = normalizeShopifyAppId(appId);
    const credential = this.appCredentials.find((item) => normalizeShopifyAppId(item.appId) === normalizedAppId);
    if (credential === undefined) {
      throw new Error(`Shopify token exchange credential not configured for ${normalizedAppId}`);
    }
    return credential;
  }
}

function requireOption(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === '') {
    throw new Error(`Shopify token exchange ${name} is required`);
  }
  return value.trim();
}

function parseTokenExchangeResponse(
  payload: ShopifyTokenExchangeResponse
): ShopifyTokenExchangeResult {
  if (typeof payload.access_token !== 'string' || payload.access_token.trim() === '') {
    throw new Error('Shopify token exchange response missing access_token');
  }

  if (typeof payload.scope !== 'string') {
    throw new Error('Shopify token exchange response missing scope');
  }

  return {
    accessToken: payload.access_token,
    expiresIn: optionalNumber(payload.expires_in),
    refreshToken: optionalString(payload.refresh_token),
    refreshTokenExpiresIn: optionalNumber(payload.refresh_token_expires_in),
    scope: payload.scope
  };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw new Error('Shopify token exchange returned invalid JSON', { cause: error });
  }
}

function optionalNumber(value: unknown): number | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('Shopify token exchange response has invalid numeric metadata');
  }

  return value;
}

function optionalString(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== 'string') {
    throw new Error('Shopify token exchange response has invalid string metadata');
  }

  return value;
}

function normalizeShopDomain(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const withoutProtocol = trimmed.replace(/^https?:\/\//u, '').replace(/\/$/u, '');

  if (!withoutProtocol.endsWith('.myshopify.com')) {
    throw new Error('Shop domain must end with .myshopify.com');
  }

  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/u.test(withoutProtocol)) {
    throw new Error('Shop domain is not a valid myshopify.com domain');
  }

  return withoutProtocol;
}
