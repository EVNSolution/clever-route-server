import { diagnoseRouteStopLocation } from '../route-plans/route-stop-location-diagnostic.js';
import { RouteGroupingValidationError, type CustomRouteGroupingStopFields } from './route-grouping.types.js';

const CUSTOM_STOP_LOCATION_ADDRESS_FIELDS = ['address1', 'address2', 'city', 'province', 'postalCode', 'countryCode'] as const;

export type RequiredCustomStopLocationFields = CustomRouteGroupingStopFields & {
  address1: string;
  countryCode: string;
  latitude: number;
  longitude: number;
};

export function validateRequiredCustomStopLocation(
  input: CustomRouteGroupingStopFields
): asserts input is RequiredCustomStopLocationFields {
  if (normalizeOptionalText(input.address1) === null) {
    throw new RouteGroupingValidationError(['custom stop address1 is required']);
  }
  if (normalizeCountryCode(input.countryCode) === null) {
    throw new RouteGroupingValidationError(['custom stop countryCode is required']);
  }
  if (!hasCustomStopCoordinates(input)) {
    throw new RouteGroupingValidationError(['custom stop latitude and longitude are required']);
  }
  validateCustomStopLocationValues(input);
}

export function validateCustomStopUpdateLocationRequest(input: CustomRouteGroupingStopFields): void {
  const latitudeProvided = input.latitude !== undefined;
  const longitudeProvided = input.longitude !== undefined;
  const coordinatesNonNull = latitudeProvided && longitudeProvided && input.latitude !== null && input.longitude !== null;

  if (hasCustomStopAddressChanges(input) && !coordinatesNonNull) {
    throw new RouteGroupingValidationError([
      'custom stop address changes must include non-null latitude and longitude in the same request'
    ]);
  }
  if ((latitudeProvided || longitudeProvided) && !coordinatesNonNull) {
    throw new RouteGroupingValidationError([
      'custom stop coordinate changes must include non-null latitude and longitude in the same request'
    ]);
  }
  if (coordinatesNonNull) validateCustomStopLocationValues(input);
}

export function validateCustomStopLocationValues(input: CustomRouteGroupingStopFields): void {
  const latitude = input.latitude ?? null;
  const longitude = input.longitude ?? null;
  if ((latitude === null) !== (longitude === null)) {
    throw new RouteGroupingValidationError(['latitude and longitude must be provided together']);
  }
  if (latitude !== null && (!Number.isFinite(latitude) || latitude < -90 || latitude > 90)) {
    throw new RouteGroupingValidationError(['latitude must be between -90 and 90']);
  }
  if (longitude !== null && (!Number.isFinite(longitude) || longitude < -180 || longitude > 180)) {
    throw new RouteGroupingValidationError(['longitude must be between -180 and 180']);
  }
  if (latitude !== null && longitude !== null) {
    const locationDiagnostic = diagnoseRouteStopLocation({
      countryCode: input.countryCode,
      geocodeStatus: 'RESOLVED',
      latitude,
      longitude,
      province: input.province
    });
    if (!locationDiagnostic.routeable) {
      throw new RouteGroupingValidationError([
        `custom stop location is not routeable: ${locationDiagnostic.issues.join(', ')}`
      ]);
    }
  }
}

export function hasCustomStopLocationChanges(input: CustomRouteGroupingStopFields): boolean {
  return hasCustomStopAddressChanges(input) || input.latitude !== undefined || input.longitude !== undefined;
}

function hasCustomStopAddressChanges(input: CustomRouteGroupingStopFields): boolean {
  return CUSTOM_STOP_LOCATION_ADDRESS_FIELDS.some((field) => input[field] !== undefined);
}

function hasCustomStopCoordinates(input: CustomRouteGroupingStopFields): boolean {
  return input.latitude !== undefined && input.latitude !== null && input.longitude !== undefined && input.longitude !== null;
}

function normalizeCountryCode(value: string | null | undefined): string | null {
  const normalized = normalizeOptionalText(value)?.toUpperCase() ?? null;
  if (normalized !== null && !/^[A-Z]{2}$/u.test(normalized)) {
    throw new RouteGroupingValidationError(['custom stop countryCode must be a two-letter ISO country code']);
  }
  return normalized;
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const normalized = value.trim();
  return normalized === '' ? null : normalized;
}
