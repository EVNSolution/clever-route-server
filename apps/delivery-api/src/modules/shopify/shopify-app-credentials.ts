import { DEFAULT_SHOPIFY_APP_ID, SHOPIFY_DEV_APP_ID, normalizeShopifyAppId } from './shopify-app-scope.js';

export type ShopifyAppCredential = {
  appId: string;
  clientId: string;
  clientSecret: string;
};

export type ShopifyAppCredentialsEnv = Partial<
  Record<
    | 'SHOPIFY_API_KEY'
    | 'SHOPIFY_API_SECRET'
    | 'SHOPIFY_APP_CREDENTIALS'
    | 'SHOPIFY_DEV_API_KEY'
    | 'SHOPIFY_DEV_API_SECRET',
    string
  >
>;

export function loadShopifyAppCredentials(env: ShopifyAppCredentialsEnv): ShopifyAppCredential[] {
  const credentials: ShopifyAppCredential[] = [];
  const mainClientId = readOptional(env.SHOPIFY_API_KEY);
  const mainSecret = readOptional(env.SHOPIFY_API_SECRET);
  if (mainClientId !== undefined && mainSecret !== undefined) {
    credentials.push({ appId: DEFAULT_SHOPIFY_APP_ID, clientId: mainClientId, clientSecret: mainSecret });
  }

  const devClientId = readOptional(env.SHOPIFY_DEV_API_KEY);
  const devSecret = readOptional(env.SHOPIFY_DEV_API_SECRET);
  if (devClientId !== undefined && devSecret !== undefined) {
    credentials.push({ appId: SHOPIFY_DEV_APP_ID, clientId: devClientId, clientSecret: devSecret });
  }

  for (const credential of readCredentialList(env.SHOPIFY_APP_CREDENTIALS)) {
    credentials.push(credential);
  }

  return dedupeCredentials(credentials);
}

function readCredentialList(value: string | undefined): ShopifyAppCredential[] {
  const text = readOptional(value);
  if (text === undefined) return [];

  return text.split(',').map((entry) => {
    const [appId, clientId, clientSecret, ...extra] = entry.split(':');
    if (
      appId === undefined ||
      clientId === undefined ||
      clientSecret === undefined ||
      extra.length > 0 ||
      clientId.trim() === '' ||
      clientSecret.trim() === ''
    ) {
      throw new Error('SHOPIFY_APP_CREDENTIALS must be appId:clientId:clientSecret entries');
    }

    return {
      appId: normalizeShopifyAppId(appId),
      clientId: clientId.trim(),
      clientSecret: clientSecret.trim()
    };
  });
}

function dedupeCredentials(credentials: ShopifyAppCredential[]): ShopifyAppCredential[] {
  const byAppId = new Map<string, ShopifyAppCredential>();
  const clientIds = new Set<string>();
  for (const credential of credentials) {
    const existing = byAppId.get(credential.appId);
    if (existing !== undefined) {
      if (existing.clientId !== credential.clientId || existing.clientSecret !== credential.clientSecret) {
        throw new Error(`Duplicate Shopify app credential for ${credential.appId}`);
      }
      continue;
    }
    if (clientIds.has(credential.clientId)) {
      throw new Error(`Duplicate Shopify client id: ${credential.clientId}`);
    }
    byAppId.set(credential.appId, credential);
    clientIds.add(credential.clientId);
  }
  return [...byAppId.values()];
}

function readOptional(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  return value.trim();
}
