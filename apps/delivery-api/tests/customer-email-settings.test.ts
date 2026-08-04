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
    expect(settings.version).toBe(2);
    expect(settings.branding).toMatchObject({
      logoMode: 'hidden',
      showPoweredByClever: true,
    });
    expect(customerEmailSignals.every((signal) => settings.templates[signal].enabled)).toBe(true);
  });

  test('validates version and whitelisted variables', () => {
    const settings = defaultCustomerEmailSettings();

    expect(validateCustomerEmailSettingsPayload({
      ...settings,
      branding: {
        ...settings.branding,
        accentColor: '#0055aa',
        logoAltText: 'Brand',
        logoLinkUrl: 'https://example.com/email',
        logoMode: 'image',
        logoUrl: 'https://example.com/logo.png',
      },
      senderEmail: 'Sender@Example.com',
      templates: {
        ...settings.templates,
        DELIVERY_SCHEDULED: {
          body: 'Hello {{customerName}} {{orderNumber}}',
          enabled: true,
          subject: 'Scheduled {{deliveryDate}}',
        },
      },
    })).toMatchObject({
      branding: {
        accentColor: '#0055aa',
        logoLinkUrl: 'https://example.com/email',
        logoMode: 'image',
        logoUrl: 'https://example.com/logo.png',
      },
      senderEmail: 'sender@example.com',
      version: 2,
    });

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

  test('rejects unsafe v2 branding fields', () => {
    const settings = { ...defaultCustomerEmailSettings(), senderEmail: 'sender@example.com' };

    expect(() => validateCustomerEmailSettingsPayload({
      ...settings,
      branding: { ...settings.branding, accentColor: 'red' },
    })).toThrow(/hex color/u);
    expect(() => validateCustomerEmailSettingsPayload({
      ...settings,
      branding: { ...settings.branding, logoMode: 'image', logoUrl: 'http://example.com/logo.png' },
    })).toThrow(/HTTPS URL/u);
    expect(() => validateCustomerEmailSettingsPayload({
      ...settings,
      branding: { ...settings.branding, logoMode: 'image', logoUrl: null },
    })).toThrow(/logoUrl is required/u);
    expect(() => validateCustomerEmailSettingsPayload({
      ...settings,
      branding: { ...settings.branding, logoWidth: 500 },
    })).toThrow(/logoWidth/u);
  });

  test('requires version, nearbyStopsThreshold, and template enabled fields', () => {
    const settings = { ...defaultCustomerEmailSettings(), senderEmail: 'sender@example.com' };

    expect(() => validateCustomerEmailSettingsPayload({
      ...settings,
      version: undefined,
    })).toThrow(/version must be 2/u);
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

  test('normalizes missing settings, customer email v1, and legacy routeOpsUiSettings v1 safely', () => {
    const v1Settings = {
      nearbyStopsThreshold: 4,
      replyTo: 'reply@example.com',
      senderEmail: 'sender@example.com',
      senderName: 'Legacy Sender',
      templates: defaultCustomerEmailSettings().templates,
      version: 1,
    };

    expect(normalizeCustomerEmailSettings(null)).toEqual(defaultCustomerEmailSettings());
    expect(normalizeCustomerEmailSettings(v1Settings)).toMatchObject({
      branding: defaultCustomerEmailSettings().branding,
      nearbyStopsThreshold: 4,
      replyTo: 'reply@example.com',
      senderEmail: 'sender@example.com',
      senderName: 'Legacy Sender',
      version: 2,
    });
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
