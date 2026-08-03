import type { CustomerEmailSignal } from './customer-email-settings.js';

export type CustomerEmailTransportMessage = {
  body: string;
  commandId: string;
  recipientEmail: string;
  replyTo: string | null;
  senderEmail: string;
  senderName: string;
  signal: CustomerEmailSignal | 'TEST';
  subject: string;
  tags: string[];
};

export type CustomerEmailTransportResult = {
  provider: string;
  providerMessageId: string | null;
};

export type CustomerEmailTransport = {
  readonly configured: boolean;
  readonly providerName: string;
  send(message: CustomerEmailTransportMessage): Promise<CustomerEmailTransportResult>;
};

export type CustomerEmailTransportEnv = Partial<Record<'BREVO_API_KEY' | 'BREVO_TIMEOUT_MS', string>>;

const brevoTransactionalEmailUrl = 'https://api.brevo.com/v3/smtp/email';

export class BrevoCustomerEmailTransport implements CustomerEmailTransport {
  readonly providerName = 'brevo';
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(input: {
    apiKey?: string | undefined;
    fetchImpl?: typeof fetch | undefined;
    timeoutMs?: number | undefined;
  }) {
    this.apiKey = input.apiKey;
    this.fetchImpl = input.fetchImpl ?? fetch;
    this.timeoutMs = input.timeoutMs ?? 10_000;
  }

  get configured(): boolean {
    return this.apiKey !== undefined;
  }

  async send(message: CustomerEmailTransportMessage): Promise<CustomerEmailTransportResult> {
    if (this.apiKey === undefined) {
      throw new CustomerEmailTransportConfigurationError();
    }
    const response = await this.fetchImpl(brevoTransactionalEmailUrl, {
      body: JSON.stringify({
        headers: {
          'Idempotency-Key': `customer-email:${message.commandId}`,
        },
        htmlContent: plainTextHtml(message.body),
        ...(message.replyTo === null ? {} : { replyTo: { email: message.replyTo } }),
        sender: {
          email: message.senderEmail,
          name: message.senderName,
        },
        subject: message.subject,
        tags: message.tags,
        textContent: message.body,
        to: [{ email: message.recipientEmail }],
      }),
      headers: {
        accept: 'application/json',
        'api-key': this.apiKey,
        'content-type': 'application/json',
      },
      method: 'POST',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new CustomerEmailTransportSendError(response.status);
    const body = await readJsonObject(response);
    return {
      provider: this.providerName,
      providerMessageId: typeof body?.messageId === 'string' ? body.messageId : null,
    };
  }
}

export function loadCustomerEmailTransport(env: CustomerEmailTransportEnv): CustomerEmailTransport {
  return new BrevoCustomerEmailTransport({
    apiKey: readOptional(env.BREVO_API_KEY),
    timeoutMs: readPositiveInteger(env.BREVO_TIMEOUT_MS) ?? 10_000,
  });
}

export class CustomerEmailTransportConfigurationError extends Error {
  constructor() {
    super('Customer email transport is not configured.');
    this.name = 'CustomerEmailTransportConfigurationError';
  }
}

export class CustomerEmailTransportSendError extends Error {
  constructor(readonly statusCode: number) {
    super(`Customer email transport failed with HTTP ${statusCode}.`);
    this.name = 'CustomerEmailTransportSendError';
  }
}

function readOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized === '' ? undefined : normalized;
}

function readPositiveInteger(value: string | undefined): number | undefined {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function plainTextHtml(value: string): string {
  return `<div style="font-family:Arial,sans-serif;color:#1d1d1f;line-height:1.6;white-space:pre-wrap">${escapeHtml(value)}</div>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({
    '"': '&quot;',
    '&': '&amp;',
    "'": '&#39;',
    '<': '&lt;',
    '>': '&gt;',
  })[character] ?? character);
}

async function readJsonObject(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await response.json();
    return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
