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

export type CustomerEmailSettings = {
  nearbyStopsThreshold: number;
  replyTo: string | null;
  senderEmail: string;
  senderName: string;
  templates: Record<CustomerEmailSignal, CustomerEmailTemplate>;
  version: 1;
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
    version: 1,
  };
}

export function normalizeCustomerEmailSettings(value: unknown): CustomerEmailSettings {
  if (value === null || value === undefined) return defaultCustomerEmailSettings();
  return validateCustomerEmailSettingsPayload(value);
}

export function validateCustomerEmailSettingsPayload(value: unknown): CustomerEmailSettings {
  if (!isRecord(value)) throw new Error('Customer email settings must be an object.');
  if (value.version !== 1) throw new Error('Customer email settings version must be 1.');
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
    nearbyStopsThreshold,
    replyTo,
    senderEmail,
    senderName,
    templates,
    version: 1,
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
