import { describe, expect, test } from 'vitest';

import {
  RouteScopeConfigValidationError,
  defaultRouteScopeConfig,
  isActiveDeliverySession,
  isActiveServiceType,
  validateRouteScopeConfigPayload
} from '../src/modules/route-ops/route-scope-config.js';

describe('route scope config helper', () => {
  test('returns backward-compatible defaults', () => {
    const config = defaultRouteScopeConfig();

    expect(config.serviceTypes.map((value) => value.value)).toEqual([
      'DELIVERY',
      'EVENING_DELIVERY',
      'PICKUP'
    ]);
    expect(config.deliverySessions.map((value) => value.value)).toEqual([
      'DAY',
      'EVENING',
      'PICKUP'
    ]);
    expect(config.timeWindow).toEqual(expect.objectContaining({ endExample: '21:00', startExample: '17:00' }));
  });

  test('accepts enabled custom safe tokens and marks disabled values inactive', () => {
    const base = defaultRouteScopeConfig();
    const config = validateRouteScopeConfigPayload({
      ...base,
      deliverySessions: [
        ...base.deliverySessions,
        { builtIn: false, description: null, enabled: true, example: 'MORNING', label: 'Morning', value: 'MORNING' },
        { builtIn: false, description: null, enabled: false, example: null, label: 'Late night', value: 'LATE_NIGHT' }
      ],
      serviceTypes: [
        ...base.serviceTypes,
        { builtIn: false, description: null, enabled: true, example: 'MORNING_DELIVERY', label: 'Morning delivery', value: 'MORNING_DELIVERY' }
      ]
    });

    expect(isActiveServiceType(config, 'MORNING_DELIVERY')).toBe(true);
    expect(isActiveDeliverySession(config, 'MORNING')).toBe(true);
    expect(isActiveDeliverySession(config, 'LATE_NIGHT')).toBe(false);
  });

  test('rejects duplicate, unsafe, invalid time, and disabled built-in values', () => {
    const base = defaultRouteScopeConfig();

    expect(() => validateRouteScopeConfigPayload({ ...base, serviceTypes: [base.serviceTypes[0], base.serviceTypes[0]] })).toThrow(RouteScopeConfigValidationError);
    expect(() => validateRouteScopeConfigPayload({ ...base, serviceTypes: [{ ...base.serviceTypes[0], value: 'BAD|TOKEN' }, ...base.serviceTypes.slice(1)] })).toThrow(RouteScopeConfigValidationError);
    expect(() => validateRouteScopeConfigPayload({ ...base, timeWindow: { ...base.timeWindow, startExample: '25:00' } })).toThrow(RouteScopeConfigValidationError);
    expect(() => validateRouteScopeConfigPayload({ ...base, deliverySessions: [{ ...base.deliverySessions[0], enabled: false }, ...base.deliverySessions.slice(1)] })).toThrow(RouteScopeConfigValidationError);
  });
});
