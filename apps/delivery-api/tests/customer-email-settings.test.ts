import { describe, expect, test } from 'vitest';

import {
  customerEmailSignals,
  defaultCustomerEmailSettings,
  normalizeCustomerEmailSettings,
  validateCustomerEmailSettingsPayload,
} from '../src/modules/customer-email/customer-email-settings.js';
import { normalizeRouteOpsUiSettings } from '../src/modules/route-ops/route-ops-ui-settings.js';

describe('customer email settings', () => {
  test('defaults five enabled templates, automatic off, and compatibility nearby threshold', () => {
    const settings = defaultCustomerEmailSettings();

    expect(settings).not.toHaveProperty('nearbyStopsThreshold');
    expect(settings.automatic).toEqual({
      consent: {
        acceptedAt: null,
        acceptedBy: null,
        noticeVersion: null,
        settingsVersion: null,
      },
      enabled: false,
    });
    expect(settings.compatibility.nearbyStopsThreshold).toBe(3);
    expect(settings.globalVersion).toBe(1);
    expect(settings.version).toBe(3);
    expect(settings.branding).toMatchObject({
      address: '',
      businessName: '',
      contactEmail: null,
      logoMode: 'hidden',
      note: '',
      showPoweredByClever: true,
      websiteUrl: null,
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
          body: 'Hello {{customerName}} {{orderNumber}} {{deliveryWeekday}} {{inventoryList}}',
          enabled: true,
          subject: 'Scheduled {{deliveryDate}}',
          version: 7,
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
      templates: {
        DELIVERY_SCHEDULED: {
          version: 7,
        },
      },
      version: 3,
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

  test('requires version and template enabled fields while removing v3 nearbyStopsThreshold writes', () => {
    const settings = { ...defaultCustomerEmailSettings(), senderEmail: 'sender@example.com' };

    expect(() => validateCustomerEmailSettingsPayload({
      ...settings,
      version: undefined,
    })).toThrow(/version must be 3/u);
    expect(validateCustomerEmailSettingsPayload({
      ...settings,
      nearbyStopsThreshold: undefined,
    })).not.toHaveProperty('nearbyStopsThreshold');
    expect(() => validateCustomerEmailSettingsPayload({
      ...settings,
      automatic: {
        consent: {
          acceptedAt: null,
          acceptedBy: null,
          noticeVersion: null,
          settingsVersion: null,
        },
        enabled: true,
      },
    })).toThrow(/automatic\.enabled cannot be enabled/u);
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

  test('normalizes missing settings, customer email v1/v2, and legacy routeOpsUiSettings v1 safely', () => {
    const v1Settings = {
      nearbyStopsThreshold: 4,
      replyTo: 'reply@example.com',
      senderEmail: 'sender@example.com',
      senderName: 'Legacy Sender',
      templates: defaultCustomerEmailSettings().templates,
      version: 1,
    };
    const v2Settings = {
      ...defaultCustomerEmailSettings(),
      automatic: undefined,
      compatibility: undefined,
      nearbyStopsThreshold: 5,
      version: 2,
    };

    expect(normalizeCustomerEmailSettings(null)).toEqual(defaultCustomerEmailSettings());
    expect(normalizeCustomerEmailSettings(v1Settings)).toMatchObject({
      automatic: { enabled: false },
      branding: defaultCustomerEmailSettings().branding,
      compatibility: { nearbyStopsThreshold: 4 },
      globalVersion: 1,
      replyTo: 'reply@example.com',
      senderEmail: 'sender@example.com',
      senderName: 'Legacy Sender',
      version: 3,
    });
    expect(normalizeCustomerEmailSettings(v2Settings)).toMatchObject({
      automatic: { enabled: false },
      compatibility: { nearbyStopsThreshold: 5 },
      globalVersion: 1,
      version: 3,
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
