import type { AdminStoreSettings } from "../modules/commerce/admin-store-settings.service.js";
import { defaultRouteScopeConfig } from "../modules/route-ops/route-scope-config.js";
import type { GeocodingResult } from "../modules/geocoding/geocoding.types.js";

export function defaultRouteOpsSettings(
  shopDomain: string,
): AdminStoreSettings {
  return {
    defaultDepotAddress: null,
    defaultDepotLatitude: null,
    defaultDepotLongitude: null,
    locale: "en-CA",
    routeScopeConfig: defaultRouteScopeConfig(),
    shopDomain,
  };
}

export function toRouteOpsSettingsDto(
  settings: AdminStoreSettings,
): AdminStoreSettings {
  return {
    defaultDepotAddress: settings.defaultDepotAddress,
    defaultDepotLatitude: settings.defaultDepotLatitude,
    defaultDepotLongitude: settings.defaultDepotLongitude,
    locale: settings.locale === "ko-KR" ? "ko-KR" : "en-CA",
    routeScopeConfig: settings.routeScopeConfig,
    shopDomain: settings.shopDomain,
  };
}

export function readRememberedDepotGeocode(
  settings: AdminStoreSettings | null,
  defaultDepotAddress: string,
): Extract<GeocodingResult, { ok: true }> | null {
  if (
    settings === null ||
    settings.defaultDepotAddress === null ||
    normalizeDepotAddressText(settings.defaultDepotAddress) !==
      normalizeDepotAddressText(defaultDepotAddress) ||
    !isStoredLatitude(settings.defaultDepotLatitude) ||
    !isStoredLongitude(settings.defaultDepotLongitude)
  ) {
    return null;
  }
  return {
    cached: true,
    ok: true,
    result: {
      addressLabel: "store_settings",
      latitude: settings.defaultDepotLatitude,
      longitude: settings.defaultDepotLongitude,
      provider: "store_settings",
      providerPlaceId: null,
      rawLabel: null,
    },
  };
}

function normalizeDepotAddressText(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLowerCase();
}

function isStoredLatitude(value: number | null): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= -90 &&
    value <= 90
  );
}

function isStoredLongitude(value: number | null): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= -180 &&
    value <= 180
  );
}
