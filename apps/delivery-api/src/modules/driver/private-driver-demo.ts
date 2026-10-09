import type { Prisma } from '@prisma/client';

export const KFOOD_PRIVATE_DEMO_APP_ID = 'clever-route-kfood-private-demo';
export const KFOOD_PRIVATE_DEMO_SHOP_DOMAIN = '7hrud1-xq.myshopify.com';

type Env = Partial<Record<string, string>>;
type PrivateDriverDemoScope = {
  shopId: string | null | undefined;
  appId: string | null | undefined;
  shopDomain: string | null | undefined;
  accountId: string | null | undefined;
};
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function getPrivateDriverDemoConfig(env: Env = process.env): { shopId: string; accountId: string } | null {
  const shopId = env.KFOOD_PRIVATE_DEMO_SHOP_ID;
  const accountId = env.KFOOD_PRIVATE_DEMO_ACCOUNT_ID;
  if (shopId === undefined || accountId === undefined || !UUID_PATTERN.test(shopId) || !UUID_PATTERN.test(accountId)) return null;
  return { shopId: shopId.toLowerCase(), accountId: accountId.toLowerCase() };
}

// Media and administrator denials must survive missing or invalid activation settings.
export function isPrivateDriverDemoAppId(appId: string | null | undefined): boolean {
  return appId === KFOOD_PRIVATE_DEMO_APP_ID;
}

export function isPrivateDriverDemoScope(scope: PrivateDriverDemoScope, env: Env = process.env): boolean {
  const config = getPrivateDriverDemoConfig(env);
  return config !== null && isPrivateDriverDemoAppId(scope.appId)
    && scope.shopDomain === KFOOD_PRIVATE_DEMO_SHOP_DOMAIN
    && scope.shopId === config.shopId && scope.accountId === config.accountId;
}

export function privateDriverDemoRouteWhere(env: Env = process.env): Prisma.RoutePlanWhereInput | null {
  const config = getPrivateDriverDemoConfig(env);
  return config === null ? null : {
    shopId: config.shopId,
    shop: { appId: KFOOD_PRIVATE_DEMO_APP_ID, shopDomain: KFOOD_PRIVATE_DEMO_SHOP_DOMAIN },
    driver: { accountId: config.accountId }
  };
}

// Apply before projecting historical records as well as before issuing new route access.
export function privateDriverDemoVisibilityWhere(env: Env = process.env): Prisma.RoutePlanWhereInput {
  const privateScope = privateDriverDemoRouteWhere(env);
  return { OR: [
    { shop: { appId: { not: KFOOD_PRIVATE_DEMO_APP_ID } } },
    ...(privateScope === null ? [] : [privateScope])
  ] };
}
