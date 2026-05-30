import type { BootstrapPayload, StoreSettingsDto } from '../types';
import { defaultRouteScopeConfig } from '../routeScopeConfig';

export function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'CLEVER Route request failed';
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function toNullableNumber(value: string): number | null {
  if (value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function emptySettings(bootstrap: BootstrapPayload): StoreSettingsDto {
  return {
    defaultDepotAddress: null,
    defaultDepotLatitude: null,
    defaultDepotLongitude: null,
    locale: 'en-CA',
    routeScopeConfig: defaultRouteScopeConfig(),
    shopDomain: bootstrap.shopDomain ?? ''
  };
}
