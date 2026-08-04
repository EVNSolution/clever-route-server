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
};

export type CustomerEmailBranding = {
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
  templates: Record<CustomerEmailSignal, CustomerEmailTemplate>;
  version: 1;
};

export type CustomerEmailSettings = Omit<CustomerEmailSettingsV1, 'version'> & {
  branding: CustomerEmailBranding;
  version: 2;
};

export const CUSTOMER_EMAIL_TEMPLATE_VARIABLES = [
  'customerName',
  'deliveryAddress',
  'deliveryDate',
  'eta',
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
    nearbyStopsThreshold: 3,
    replyTo: null,
    senderEmail: '',
    senderName: 'CLEVER',
    templates: {
      DELIVERY_SCHEDULED: {
        body: 'Hello {{customerName}},\n\nYour order {{orderNumber}} is scheduled for delivery on {{deliveryDate}}.\n\nDelivery address:\n{{deliveryAddress}}',
        enabled: true,
        subject: 'Your delivery is scheduled',
      },
      OUT_FOR_DELIVERY: {
        body: 'Hello {{customerName}},\n\nYour order {{orderNumber}} is out for delivery today. Estimated arrival: {{eta}}.',
        enabled: true,
        subject: 'Your order is out for delivery',
      },
      DELIVERED: {
        body: 'Hello {{customerName}},\n\nYour order {{orderNumber}} has been delivered.',
        enabled: true,
        subject: 'Your order has been delivered',
      },
      MISSED_DELIVERY: {
        body: 'Hello {{customerName}},\n\nWe could not complete delivery for order {{orderNumber}} today. Please contact {{shopName}} for next steps.',
        enabled: true,
        subject: 'We missed your delivery',
      },
      DRIVER_NEARBY: {
        body: 'Hello {{customerName}},\n\nYour driver is nearby for order {{orderNumber}}. Estimated arrival: {{eta}}.',
        enabled: true,
        subject: 'Your driver is nearby',
      },
    },
    version: 2,
  };
}

export function defaultCustomerEmailBranding(): CustomerEmailBranding {
  return {
    accentColor: '#1f6feb',
    backgroundColor: '#f6f8fa',
    footerText: '',
    logoAltText: 'CLEVER',
    logoLinkUrl: null,
    logoMode: 'hidden',
    logoUrl: null,
    logoWidth: 160,
    previewText: '',
    showPoweredByClever: true,
    surfaceColor: '#ffffff',
    textColor: '#24292f',
  };
}

export function normalizeCustomerEmailSettings(value: unknown): CustomerEmailSettings {
  if (value === null || value === undefined) return defaultCustomerEmailSettings();
  if (isRecord(value) && value.version === 1) return migrateCustomerEmailSettingsV1(value);
  return validateCustomerEmailSettingsPayload(value);
}

export function validateCustomerEmailSettingsPayload(value: unknown): CustomerEmailSettings {
  if (!isRecord(value)) throw new Error('Customer email settings must be an object.');
  if (value.version !== 2) throw new Error('Customer email settings version must be 2.');
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
    branding: readBranding(value.branding),
    nearbyStopsThreshold,
    replyTo,
    senderEmail,
    senderName,
    templates,
    version: 2,
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
    branding: defaultCustomerEmailBranding(),
    nearbyStopsThreshold,
    replyTo,
    senderEmail,
    senderName,
    templates,
    version: 2,
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
    backgroundColor: readHexColor(value.backgroundColor, 'branding.backgroundColor'),
    footerText: readOptionalBoundedString(value.footerText, 'branding.footerText', 500),
    logoAltText: readOptionalBoundedString(value.logoAltText, 'branding.logoAltText', 120),
    logoLinkUrl: readNullableHttpsUrl(value.logoLinkUrl, 'branding.logoLinkUrl'),
    logoMode,
    logoUrl,
    logoWidth: readIntegerInRange(value.logoWidth, 48, 320, 'branding.logoWidth'),
    previewText: readOptionalBoundedString(value.previewText, 'branding.previewText', 200),
    showPoweredByClever: readBoolean(value.showPoweredByClever, 'branding.showPoweredByClever'),
    surfaceColor: readHexColor(value.surfaceColor, 'branding.surfaceColor'),
    textColor: readHexColor(value.textColor, 'branding.textColor'),
  };
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
