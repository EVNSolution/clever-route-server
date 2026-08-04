import {
  defaultCustomerEmailBranding,
  type CustomerEmailBranding,
  type CustomerEmailSignal,
} from './customer-email-settings.js';

export type CustomerEmailTransportMessage = {
  branding?: CustomerEmailBranding | undefined;
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
        htmlContent: brandedHtml(message),
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

function brandedHtml(message: CustomerEmailTransportMessage): string {
  const branding = message.branding ?? defaultCustomerEmailBranding();
  const preview = branding.previewText === ''
    ? ''
    : `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${escapeHtml(branding.previewText)}</div>`;
  const footerLogo = renderLogo(branding);
  const footerText = branding.footerText === ''
    ? ''
    : `<div style="margin-top:24px;color:#6b7280;font-size:13px;line-height:1.5">${escapeHtml(branding.footerText)}</div>`;
  const poweredBy = branding.showPoweredByClever
    ? '<div style="margin-top:12px;color:#6b7280;font-size:12px;line-height:1.5">Powered by CLEVER</div>'
    : '';
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:${branding.backgroundColor};color:${branding.textColor};font-family:Arial,sans-serif">
    ${preview}
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;background:${branding.backgroundColor};margin:0;padding:0;width:100%">
      <tr>
        <td align="center" style="padding:28px 16px">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;max-width:640px;width:100%">
            <tr>
              <td style="background:${branding.surfaceColor};border-top:4px solid ${branding.accentColor};padding:28px">
                <div style="color:${branding.textColor};font-size:16px;line-height:1.65;white-space:pre-wrap">${escapeHtml(message.body)}</div>
                ${footerLogo}
                ${footerText}
                ${poweredBy}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function renderLogo(branding: CustomerEmailBranding): string {
  if (branding.logoMode !== 'image' || branding.logoUrl === null) return '';
  const image = `<img src="${escapeHtml(branding.logoUrl)}" width="${branding.logoWidth}" alt="${escapeHtml(branding.logoAltText)}" style="border:0;display:block;height:auto;max-width:100%;width:${branding.logoWidth}px" />`;
  const content = branding.logoLinkUrl === null
    ? image
    : `<a href="${escapeHtml(branding.logoLinkUrl)}" style="display:inline-block;text-decoration:none">${image}</a>`;
  return `<div style="margin-top:24px;text-align:left">${content}</div>`;
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
