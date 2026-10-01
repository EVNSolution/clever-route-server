import type { ShopifyAdminGraphqlClient } from './admin-graphql.client.js';
import type { DeliveryCycleConfig } from './order-delivery-scope.js';
import type { DeliveryWeekday } from './order-sync.mapper.js';

// Read the installation belonging to the authenticated app, not another app on
// the same shop. The shop's IANA zone owns its local cutoff and delivery windows.
export const SHOPIFY_DELIVERY_SETTINGS_FIELDS = `
    shop { ianaTimezone }
    currentAppInstallation {
      metafield(namespace: "clever_route", key: "app_preferences") { value }
      legacyMetafield: metafield(namespace: "tomatono_route", key: "app_preferences") { value }
    }
`;

export class ShopifyDeliverySettingsError extends Error {
  readonly code = 'SHOPIFY_DELIVERY_SETTINGS_UNAVAILABLE';

  constructor() {
    super('Shopify delivery settings or shop timezone are unavailable; retry synchronization.');
    this.name = 'ShopifyDeliverySettingsError';
  }
}

export async function loadShopifyDeliveryCycle(
  client: Pick<ShopifyAdminGraphqlClient, 'request'>,
): Promise<DeliveryCycleConfig> {
  try {
    const data = await client.request({
      query: `query CleverDeliverySettings { ${SHOPIFY_DELIVERY_SETTINGS_FIELDS} }`,
    }, { signal: AbortSignal.timeout(5_000) });
    return readShopifyDeliveryCycle(data);
  } catch {
    // No GraphQL payload, token or tenant configuration belongs in a public error.
    throw new ShopifyDeliverySettingsError();
  }
}

export function readShopifyDeliveryCycle(value: unknown): DeliveryCycleConfig {
  const data = objectOrNull(value);
  const timeZone = objectOrNull(data?.shop)?.ianaTimezone;
  if (typeof timeZone !== 'string' || !isValidTimeZone(timeZone)) {
    throw new ShopifyDeliverySettingsError();
  }
  const installation = objectOrNull(data?.currentAppInstallation);
  if (installation === null || !('metafield' in installation) || !('legacyMetafield' in installation)) {
    throw new ShopifyDeliverySettingsError();
  }

  // An absent modern field may use the legacy field. Corrupt modern settings
  // must be retried/repaired, never silently replaced by older/default settings.
  const field = installation.metafield ?? installation.legacyMetafield;
  let preferences: Record<string, unknown> = {};
  if (field !== undefined && field !== null) {
    const encoded = objectOrNull(field)?.value;
    if (typeof encoded !== 'string') throw new ShopifyDeliverySettingsError();
    try {
      const parsed = objectOrNull(JSON.parse(encoded) as unknown);
      if (parsed === null) throw new ShopifyDeliverySettingsError();
      preferences = parsed;
    } catch {
      throw new ShopifyDeliverySettingsError();
    }
  }

  const cycle = preferences.deliveryCycle === undefined
    ? {}
    : objectOrNull(preferences.deliveryCycle);
  if (cycle === null) throw new ShopifyDeliverySettingsError();
  // These defaults match the app's unconfigured cutoff; timezone never defaults.
  const cutoffTime = cycle.cutoffTime === undefined ? '23:59' : cycle.cutoffTime;
  const cutoffWeekday = cycle.cutoffWeekday === undefined ? 'MONDAY' : cycle.cutoffWeekday;
  if (typeof cutoffTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/u.test(cutoffTime)
    || typeof cutoffWeekday !== 'string'
    || !['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'].includes(cutoffWeekday)) {
    throw new ShopifyDeliverySettingsError();
  }

  // Old app preferences persisted a Toronto default even for other shops.
  // Reading the shop zone also accounts for later merchant timezone changes.
  return { cutoffTime, cutoffWeekday: cutoffWeekday as DeliveryWeekday, timeZone };
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isValidTimeZone(value: string): boolean {
  if (value.trim() === '' || /^[+-]/u.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}
