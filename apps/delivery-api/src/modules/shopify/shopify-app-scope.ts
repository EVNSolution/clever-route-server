export const DEFAULT_SHOPIFY_APP_ID = 'clever';
export const SHOPIFY_DEV_APP_ID = 'clever-route-dev';

export type ShopifyAppScope = {
  appId: string;
  shopDomain: string;
};

export function normalizeShopifyAppId(value: string | null | undefined): string {
  const appId = value?.trim() || DEFAULT_SHOPIFY_APP_ID;
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(appId)) {
    throw new Error('Shopify app id is invalid');
  }
  return appId;
}

export function appScopedShopWhere(input: { appId?: string | null | undefined; shopDomain: string }): {
  appId_shopDomain: { appId: string; shopDomain: string };
} {
  return {
    appId_shopDomain: {
      appId: normalizeShopifyAppId(input.appId),
      shopDomain: input.shopDomain
    }
  };
}
