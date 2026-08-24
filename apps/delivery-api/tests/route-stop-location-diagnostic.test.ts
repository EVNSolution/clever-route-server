import { describe, expect, test } from 'vitest';

import { diagnoseRouteStopLocation } from '../src/modules/route-plans/route-stop-location-diagnostic.js';

describe('route stop location diagnostics', () => {
  test('flags legacy zero coordinates even when geocoding was marked resolved', () => {
    expect(diagnoseRouteStopLocation({
      countryCode: '1',
      geocodeStatus: 'RESOLVED',
      latitude: 0,
      longitude: 0,
      province: 'ONTARIO'
    })).toEqual({
      issues: ['COUNTRY_CODE_INVALID', 'COORDINATES_ZERO', 'GEOCODE_STATUS_INCONSISTENT'],
      routeable: false,
      severity: 'CRITICAL'
    });
  });

  test('flags coordinates outside the address province without exposing address data', () => {
    expect(diagnoseRouteStopLocation({
      countryCode: 'CA',
      geocodeStatus: 'RESOLVED',
      latitude: 0.1,
      longitude: 0.1,
      province: 'ON'
    })).toEqual({
      issues: ['COORDINATES_OUTSIDE_COUNTRY', 'COORDINATES_OUTSIDE_PROVINCE', 'GEOCODE_STATUS_INCONSISTENT'],
      routeable: false,
      severity: 'CRITICAL'
    });
  });

  test('accepts plausible Ontario coordinates', () => {
    expect(diagnoseRouteStopLocation({
      countryCode: 'CA',
      geocodeStatus: 'RESOLVED',
      latitude: 43.6426,
      longitude: -79.3871,
      province: 'Ontario'
    })).toEqual({
      issues: [],
      routeable: true,
      severity: 'NONE'
    });
  });
});
