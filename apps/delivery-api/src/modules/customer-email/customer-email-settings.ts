export const customerEmailSignals = [
  'DELIVERY_SCHEDULED',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'MISSED_DELIVERY',
  'DRIVER_NEARBY',
] as const;

export type CustomerEmailSignal = (typeof customerEmailSignals)[number];

export type CustomerEmailTemplate = {
  body: string;
  enabled: boolean;
  subject: string;
  version: number;
};

export type CustomerEmailFooter = {
  address: string;
  businessName: string;
  contactEmail: string | null;
  logoAltText: string;
  logoLinkUrl: string | null;
  logoMode: 'hidden' | 'image';
  logoUrl: string | null;
  logoWidth: number;
  note: string;
  phone: string;
  websiteUrl: string | null;
};

export type CustomerEmailBranding = CustomerEmailFooter & {
  accentColor: string;
  backgroundColor: string;
  footerText: string;
  logoAltText: string;
  logoLinkUrl: string | null;
  logoMode: 'hidden' | 'image';
  logoUrl: string | null;
  logoWidth: number;
  previewText: string;
  showPoweredByClever: boolean;
  surfaceColor: string;
  textColor: string;
};

export type CustomerEmailSettingsV1 = {
  nearbyStopsThreshold: number;
  replyTo: string | null;
  senderEmail: string;
  senderName: string;
  templates: Record<CustomerEmailSignal, Omit<CustomerEmailTemplate, 'version'> & { version?: number }>;
  version: 1;
};

export type CustomerEmailSettingsV2 = Omit<CustomerEmailSettingsV1, 'version'> & {
  branding: CustomerEmailBranding;
  version: 2;
};

export type CustomerEmailAutomaticSettings = {
  consent: {
    acceptedAt: string | null;
    acceptedBy: string | null;
    noticeVersion: string | null;
    settingsVersion: string | null;
  };
  enabled: boolean;
};

export type CustomerEmailSettings = {
  automatic: CustomerEmailAutomaticSettings;
  branding: CustomerEmailBranding;
  compatibility: {
    nearbyStopsThreshold: number;
  };
  globalVersion: number;
  replyTo: string | null;
  senderEmail: string;
  senderName: string;
  templates: Record<CustomerEmailSignal, CustomerEmailTemplate>;
  version: 3;
};

export const CUSTOMER_EMAIL_TEMPLATE_VARIABLES = [
  'customerName',
  'deliveryAddress',
  'deliveryDate',
  'deliveryWeekday',
  'eta',
  'inventoryList',
  'orderNumber',
  'routeName',
  'sequence',
  'shopName',
] as const;

const customerEmailSignalSet = new Set<string>(customerEmailSignals);
const customerEmailVariableSet = new Set<string>(CUSTOMER_EMAIL_TEMPLATE_VARIABLES);

export function defaultCustomerEmailSettings(): CustomerEmailSettings {
  return {
    branding: defaultCustomerEmailBranding(),
    automatic: defaultCustomerEmailAutomaticSettings(),
    compatibility: { nearbyStopsThreshold: 3 },
    globalVersion: 1,
    replyTo: null,
    senderEmail: '',
    senderName: 'CLEVER',
    templates: {
      DELIVERY_SCHEDULED: {
        body: 'Hello {{customerName}},\n\nYour order {{orderNumber}} is scheduled for delivery on {{deliveryDate}}.\n\nDelivery address:\n{{deliveryAddress}}',
        enabled: true,
        subject: 'Your delivery is scheduled',
        version: 1,
      },
      OUT_FOR_DELIVERY: {
        body: 'Hello {{customerName}},\n\nYour order {{orderNumber}} is out for delivery today. Estimated arrival: {{eta}}.',
        enabled: true,
        subject: 'Your order is out for delivery',
        version: 1,
      },
      DELIVERED: {
        body: 'Hello {{customerName}},\n\nYour order {{orderNumber}} has been delivered.',
        enabled: true,
        subject: 'Your order has been delivered',
        version: 1,
      },
      MISSED_DELIVERY: {
        body: 'Hello {{customerName}},\n\nWe could not complete delivery for order {{orderNumber}} today. Please contact {{shopName}} for next steps.',
        enabled: true,
        subject: 'We missed your delivery',
        version: 1,
      },
      DRIVER_NEARBY: {
        body: 'Hello {{customerName}},\n\nYour driver is nearby for order {{orderNumber}}. Estimated arrival: {{eta}}.',
        enabled: true,
        subject: 'Your driver is nearby',
        version: 1,
      },
    },
    version: 3,
  };
}

export function defaultCustomerEmailBranding(): CustomerEmailBranding {
  return {
    accentColor: '#1f6feb',
    backgroundColor: '#f6f8fa',
    footerText: '',
    address: '',
    businessName: '',
    contactEmail: null,
    logoAltText: 'CLEVER',
    logoLinkUrl: null,
    logoMode: 'hidden',
    logoUrl: null,
    logoWidth: 160,
    note: '',
    phone: '',
    previewText: '',
    showPoweredByClever: true,
    surfaceColor: '#ffffff',
    textColor: '#24292f',
    websiteUrl: null,
  };
}

export function defaultCustomerEmailAutomaticSettings(): CustomerEmailAutomaticSettings {
  return {
    consent: {
      acceptedAt: null,
      acceptedBy: null,
      noticeVersion: null,
      settingsVersion: null,
    },
    enabled: false,
  };
}

export function normalizeCustomerEmailSettings(value: unknown): CustomerEmailSettings {
  if (value === null || value === undefined) return defaultCustomerEmailSettings();
  if (isRecord(value) && value.version === 1) return migrateCustomerEmailSettingsV1(value);
  if (isRecord(value) && value.version === 2) return migrateCustomerEmailSettingsV2(value);
  return validateCustomerEmailSettingsPayload(value);
}

export function validateCustomerEmailSettingsPayload(value: unknown): CustomerEmailSettings {
  if (!isRecord(value)) throw new Error('Customer email settings must be an object.');
  if (value.version !== 3) throw new Error('Customer email settings version must be 3.');
  const senderName = readBoundedString(value.senderName, 'senderName', 1, 120);
  const senderEmail = readEmail(value.senderEmail, 'senderEmail', { allowEmpty: true });
  const replyTo = readNullableEmail(value.replyTo, 'replyTo');
  const templates = readTemplates(value.templates);
  return {
    automatic: readAutomaticSettings(value.automatic),
    branding: readBranding(value.branding),
    compatibility: { nearbyStopsThreshold: readCompatibilityNearbyStopsThreshold(value.compatibility) },
    globalVersion: readOptionalVersion(value.globalVersion, 'globalVersion'),
    replyTo,
    senderEmail,
    senderName,
    templates,
    version: 3,
  };
}

export function readCustomerEmailSignal(value: unknown): CustomerEmailSignal | null {
  return typeof value === 'string' && customerEmailSignalSet.has(value)
    ? value as CustomerEmailSignal
    : null;
}

function readTemplates(value: unknown): Record<CustomerEmailSignal, CustomerEmailTemplate> {
  if (!isRecord(value)) throw new Error('Customer email templates must be an object.');
  return Object.fromEntries(customerEmailSignals.map((signal) => {
    const raw = value[signal];
    if (!isRecord(raw)) throw new Error(`Customer email template ${signal} must be an object.`);
    if (typeof raw.enabled !== 'boolean') throw new Error(`Customer email template ${signal} enabled must be boolean.`);
    const subject = readBoundedString(raw.subject, `${signal}.subject`, 1, 200);
    const body = readBoundedString(raw.body, `${signal}.body`, 1, 10_000);
    assertAllowedTemplateTokens(subject);
    assertAllowedTemplateTokens(body);
    return [signal, {
      body,
      enabled: raw.enabled,
      subject,
      version: readOptionalTemplateVersion(raw.version),
    } satisfies CustomerEmailTemplate];
  })) as Record<CustomerEmailSignal, CustomerEmailTemplate>;
}

function migrateCustomerEmailSettingsV1(value: Record<string, unknown>): CustomerEmailSettings {
  const senderName = readBoundedString(value.senderName, 'senderName', 1, 120);
  const senderEmail = readEmail(value.senderEmail, 'senderEmail', { allowEmpty: true });
  const replyTo = readNullableEmail(value.replyTo, 'replyTo');
  const nearbyStopsThreshold = readIntegerInRange(
    value.nearbyStopsThreshold,
    1,
    25,
    'nearbyStopsThreshold',
  );
  const templates = readTemplates(value.templates);
  return {
    automatic: defaultCustomerEmailAutomaticSettings(),
    branding: defaultCustomerEmailBranding(),
    compatibility: { nearbyStopsThreshold },
    globalVersion: 1,
    replyTo,
    senderEmail,
    senderName,
    templates,
    version: 3,
  };
}

function migrateCustomerEmailSettingsV2(value: Record<string, unknown>): CustomerEmailSettings {
  const senderName = readBoundedString(value.senderName, 'senderName', 1, 120);
  const senderEmail = readEmail(value.senderEmail, 'senderEmail', { allowEmpty: true });
  const replyTo = readNullableEmail(value.replyTo, 'replyTo');
  const nearbyStopsThreshold = readIntegerInRange(
    value.nearbyStopsThreshold,
    1,
    25,
    'nearbyStopsThreshold',
  );
  const templates = readTemplates(value.templates);
  return {
    automatic: defaultCustomerEmailAutomaticSettings(),
    branding: readBranding(value.branding),
    compatibility: { nearbyStopsThreshold },
    globalVersion: 1,
    replyTo,
    senderEmail,
    senderName,
    templates,
    version: 3,
  };
}

function readBranding(value: unknown): CustomerEmailBranding {
  if (!isRecord(value)) throw new Error('Customer email branding must be an object.');
  const logoMode = readLogoMode(value.logoMode);
  const logoUrl = readNullableHttpsUrl(value.logoUrl, 'branding.logoUrl');
  if (logoMode === 'image' && logoUrl === null) {
    throw new Error('branding.logoUrl is required when logoMode is image.');
  }
  return {
    accentColor: readHexColor(value.accentColor, 'branding.accentColor'),
    address: readOptionalBoundedString(value.address, 'branding.address', 500),
    backgroundColor: readHexColor(value.backgroundColor, 'branding.backgroundColor'),
    businessName: readOptionalBoundedString(value.businessName, 'branding.businessName', 120),
    contactEmail: readNullableEmail(value.contactEmail, 'branding.contactEmail'),
    footerText: readOptionalBoundedString(value.footerText, 'branding.footerText', 500),
    logoAltText: readOptionalBoundedString(value.logoAltText, 'branding.logoAltText', 120),
    logoLinkUrl: readNullableHttpsUrl(value.logoLinkUrl, 'branding.logoLinkUrl'),
    logoMode,
    logoUrl,
    logoWidth: readIntegerInRange(value.logoWidth, 48, 320, 'branding.logoWidth'),
    note: readOptionalBoundedString(value.note ?? value.footerText, 'branding.note', 500),
    phone: readOptionalBoundedString(value.phone, 'branding.phone', 80),
    previewText: readOptionalBoundedString(value.previewText, 'branding.previewText', 200),
    showPoweredByClever: readBoolean(value.showPoweredByClever, 'branding.showPoweredByClever'),
    surfaceColor: readHexColor(value.surfaceColor, 'branding.surfaceColor'),
    textColor: readHexColor(value.textColor, 'branding.textColor'),
    websiteUrl: readNullableHttpsUrl(value.websiteUrl, 'branding.websiteUrl'),
  };
}

function readAutomaticSettings(value: unknown): CustomerEmailAutomaticSettings {
  if (value === undefined || value === null) return defaultCustomerEmailAutomaticSettings();
  if (!isRecord(value)) throw new Error('automatic must be an object.');
  const enabled = readBoolean(value.enabled, 'automatic.enabled');
  if (enabled) {
    throw new Error('automatic.enabled cannot be enabled through customer email settings.');
  }
  const consent = isRecord(value.consent) ? value.consent : {};
  return {
    consent: {
      acceptedAt: readNullableIsoDate(consent.acceptedAt, 'automatic.consent.acceptedAt'),
      acceptedBy: readNullableBoundedString(consent.acceptedBy, 'automatic.consent.acceptedBy', 200),
      noticeVersion: readNullableBoundedString(consent.noticeVersion, 'automatic.consent.noticeVersion', 80),
      settingsVersion: readNullableBoundedString(consent.settingsVersion, 'automatic.consent.settingsVersion', 80),
    },
    enabled,
  };
}

function readCompatibilityNearbyStopsThreshold(value: unknown): number {
  if (!isRecord(value) || value.nearbyStopsThreshold === undefined) return 3;
  return readIntegerInRange(value.nearbyStopsThreshold, 1, 25, 'compatibility.nearbyStopsThreshold');
}

function readOptionalTemplateVersion(value: unknown): number {
  if (value === undefined) return 1;
  return readOptionalVersion(value, 'template.version');
}

function readOptionalVersion(value: unknown, label: string): number {
  if (value === undefined) return 1;
  return readIntegerInRange(value, 1, 1_000_000, label);
}

function readNullableBoundedString(value: unknown, label: string, max: number): string | null {
  if (value === null || value === undefined || value === '') return null;
  return readBoundedString(value, label, 1, max);
}

function readNullableIsoDate(value: unknown, label: string): string | null {
  const normalized = readNullableBoundedString(value, label, 80);
  if (normalized === null) return null;
  if (Number.isNaN(Date.parse(normalized))) throw new Error(`${label} must be an ISO date.`);
  return normalized;
}

function readLogoMode(value: unknown): CustomerEmailBranding['logoMode'] {
  if (value === 'hidden' || value === 'image') return value;
  throw new Error('branding.logoMode must be hidden or image.');
}

function readHexColor(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a hex color.`);
  const normalized = value.trim().toLowerCase();
  if (!/^#[0-9a-f]{6}$/u.test(normalized)) throw new Error(`${label} must be a 6-digit hex color.`);
  return normalized;
}

function readBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean.`);
  return value;
}

function readOptionalBoundedString(value: unknown, label: string, max: number): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`);
  const normalized = value.trim();
  if (normalized.length > max) throw new Error(`${label} must be at most ${max} characters.`);
  return normalized;
}

function readNullableHttpsUrl(value: unknown, label: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new Error(`${label} must be an HTTPS URL.`);
  const normalized = value.trim();
  try {
    const url = new URL(normalized);
    if (url.protocol !== 'https:') throw new Error('not HTTPS');
    url.hash = '';
    return url.toString();
  } catch {
    throw new Error(`${label} must be an HTTPS URL.`);
  }
}

function assertAllowedTemplateTokens(value: string): void {
  for (const match of value.matchAll(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/gu)) {
    const token = match[1];
    if (token === undefined || !customerEmailVariableSet.has(token)) {
      throw new Error(`Unsupported customer email template variable: ${token ?? 'unknown'}.`);
    }
  }
}

function readIntegerInRange(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer from ${min} through ${max}.`);
  }
  return value;
}

function readBoundedString(value: unknown, label: string, min: number, max: number): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`);
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) {
    throw new Error(`${label} must be from ${min} through ${max} characters.`);
  }
  return normalized;
}

function readNullableEmail(value: unknown, label: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  return readEmail(value, label);
}

function readEmail(value: unknown, label: string, options: { allowEmpty?: boolean } = {}): string {
  if (typeof value !== 'string') throw new Error(`${label} must be an email address.`);
  const normalized = value.trim().toLowerCase();
  if (normalized === '' && options.allowEmpty === true) return '';
  if (!isEmail(normalized)) throw new Error(`${label} must be an email address.`);
  return normalized;
}

export function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
