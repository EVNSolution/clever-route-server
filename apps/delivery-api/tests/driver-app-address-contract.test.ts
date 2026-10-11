import { describe, expect, test } from 'vitest';
import { findDriverAppAddressGaps } from '../src/modules/driver/driver-app-address-contract.js';
import {
  findTemplateAddressGaps,
  PRIVATE_DRIVER_DEMO_TEMPLATES,
  type PrivateDriverDemoRouteTemplate
} from '../src/modules/driver/private-driver-demo-templates.js';

describe('driver app address contract', () => {
  test('reports every address part the app would reject', () => {
    expect(findDriverAppAddressGaps({
      address1: '100 Queen Street West', city: 'Toronto', countryCode: 'CA', postalCode: 'M5H 2N2', province: 'Ontario'
    })).toEqual([]);
    expect(findDriverAppAddressGaps({ address1: '', city: null, postalCode: '  ' }))
      .toEqual(['address1', 'city', 'province', 'postalCode', 'countryCode']);
  });

  test('every shipped demo template carries complete addresses', () => {
    for (const template of Object.values(PRIVATE_DRIVER_DEMO_TEMPLATES)) {
      expect(findTemplateAddressGaps(template)).toEqual([]);
    }
  });

  test('a template stop without a postal code is reported with its position', () => {
    const template: PrivateDriverDemoRouteTemplate = {
      proof: false,
      stops: [
        { ...PRIVATE_DRIVER_DEMO_TEMPLATES.simple.stops[0], postalCode: '' },
        PRIVATE_DRIVER_DEMO_TEMPLATES.simple.stops[1]
      ]
    };
    expect(findTemplateAddressGaps(template)).toEqual(['stop1.postalCode']);
  });
});
