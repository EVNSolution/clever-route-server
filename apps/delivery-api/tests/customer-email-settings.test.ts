import { describe, expect, test } from 'vitest';

import {
  customerEmailSignals,
  defaultCustomerEmailSettings,
  normalizeCustomerEmailSettings,
  validateCustomerEmailSettingsPayload,
} from '../src/modules/customer-email/customer-email-settings.js';
import { normalizeRouteOpsUiSettings } from '../src/modules/route-ops/route-ops-ui-settings.js';

describe('customer email settings', () => {
  test('defaults five enabled templates and nearby threshold', () => {
    const settings = defaultCustomerEmailSettings();

    expect(settings.nearbyStopsThreshold).toBe(3);
    expect(customerEmailSignals.every((signal) => settings.templates[signal].enabled)).toBe(true);
  });

  test('validates version and whitelisted variables', () => {
    const settings = defaultCustomerEmailSettings();

    expect(validateCustomerEmailSettingsPayload({
      ...settings,
      senderEmail: 'Sender@Example.com',
      templates: {
        ...settings.templates,
        DELIVERY_SCHEDULED: {
          body: 'Hello {{customerName}} {{orderNumber}}',
          enabled: true,
          subject: 'Scheduled {{deliveryDate}}',
        },
      },
    })).toMatchObject({ senderEmail: 'sender@example.com' });

    expect(() => validateCustomerEmailSettingsPayload({
      ...settings,
      senderEmail: 'sender@example.com',
      templates: {
        ...settings.templates,
        DELIVERY_SCHEDULED: {
          body: 'Hello {{notAllowed}}',
          enabled: true,
          subject: 'Bad',
        },
      },
    })).toThrow(/Unsupported customer email template variable/u);
  });

  test('requires version, nearbyStopsThreshold, and template enabled fields', () => {
    const settings = { ...defaultCustomerEmailSettings(), senderEmail: 'sender@example.com' };

    expect(() => validateCustomerEmailSettingsPayload({
      ...settings,
      version: undefined,
    })).toThrow(/version must be 1/u);
    expect(() => validateCustomerEmailSettingsPayload({
      ...settings,
      nearbyStopsThreshold: undefined,
    })).toThrow(/nearbyStopsThreshold/u);
    expect(() => validateCustomerEmailSettingsPayload({
      ...settings,
      templates: {
        ...settings.templates,
        DELIVERY_SCHEDULED: {
          body: 'Body',
          subject: 'Subject',
        },
      },
    })).toThrow(/enabled must be boolean/u);
  });

  test('normalizes missing settings and legacy routeOpsUiSettings v1 safely', () => {
    expect(normalizeCustomerEmailSettings(null)).toEqual(defaultCustomerEmailSettings());
    expect(normalizeRouteOpsUiSettings({
      destinationDwellMinutes: 7,
      etaDelayMinutes: 12,
      forwardDelayAlerts: false,
      gpsSilenceSeconds: 60,
      loadingStartTime: '08:00',
      plannedDepartureTime: '09:00',
      recordMissingProof: true,
      showTemperatureAlerts: false,
      temperatureLimit: 4,
      version: 1,
    })).toMatchObject({
      destinationDwellMinutes: 7,
      emailNotifications: {
        enabled: false,
        template: { body: '', subject: '' },
      },
    });
  });
});
