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
        textContent: textContent(message),
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
  const footerLogo = renderLogo(branding, message.senderName);
  const footerDetails = renderFooterDetails(branding);
  const footer = footerLogo === '' && footerDetails === ''
    ? ''
    : `<hr style="border:0;border-top:1px solid #d0d7de;margin:28px 0" />
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%">
                  <tr>
                    <td class="email-footer" style="border:1px solid #d0d7de;border-radius:8px;padding:18px">
                      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%">
                        <tr>
                          ${footerLogo === '' ? '' : `<td valign="top" width="1" style="padding:0 16px 0 0">${footerLogo}</td>`}
                          <td valign="top" class="email-muted" style="color:#57606a">${footerDetails}</td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                </table>`;
  return `<!doctype html>
<html>
  <head>
    <meta name="color-scheme" content="light dark">
    <meta name="supported-color-schemes" content="light dark">
    <style>
      :root { color-scheme: light dark; supported-color-schemes: light dark; }
      @media (prefers-color-scheme: dark) {
        .email-page { background:#000000 !important;color:#ffffff !important; }
        .email-text { color:#ffffff !important; }
        .email-muted { color:#c9d1d9 !important; }
        .email-footer { border-color:#8b949e !important; }
      }
    </style>
  </head>
  <body class="email-page" style="margin:0;padding:0;background:#ffffff;color:#111111;font-family:Arial,sans-serif">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" class="email-page" style="border-collapse:collapse;background:#ffffff;color:#111111;margin:0;padding:0;width:100%">
      <tr>
        <td align="center" style="padding:28px 16px">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;max-width:640px;width:100%">
            <tr>
              <td style="padding:28px 0">
                <h1 class="email-text" style="color:#111111;font-size:28px;font-weight:700;line-height:1.2;margin:0 0 20px">${escapeHtml(message.subject)}</h1>
                <div class="email-text" style="color:#111111;font-size:16px;line-height:1.65;white-space:pre-wrap">${escapeHtml(message.body)}</div>
                ${footer}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function renderFooterDetails(branding: CustomerEmailBranding): string {
  const rows = [
    branding.businessName === '' ? '' : `<div style="color:#111111;font-size:14px;font-weight:700;line-height:1.4;margin:0 0 6px">${escapeHtml(branding.businessName)}</div>`,
    branding.address === '' ? '' : `<div style="font-size:13px;line-height:1.55;margin:0">${escapeHtml(branding.address)}</div>`,
    branding.phone === '' ? '' : `<div style="font-size:13px;line-height:1.55;margin:0">${escapeHtml(branding.phone)}</div>`,
    branding.contactEmail === null ? '' : `<div style="font-size:13px;line-height:1.55;margin:0"><a href="mailto:${escapeHtml(branding.contactEmail)}" style="color:#57606a;text-decoration:underline">${escapeHtml(branding.contactEmail)}</a></div>`,
    branding.websiteUrl === null ? '' : `<div style="font-size:13px;line-height:1.55;margin:0"><a href="${escapeHtml(branding.websiteUrl)}" style="color:#57606a;text-decoration:underline">${escapeHtml(branding.websiteUrl)}</a></div>`,
    branding.note === '' ? '' : `<div style="font-size:13px;line-height:1.55;margin:8px 0 0">${escapeHtml(branding.note)}</div>`,
  ].filter((row) => row !== '');
  return rows.join('');
}

function renderLogo(branding: CustomerEmailBranding, senderName: string): string {
  if (branding.logoMode !== 'image' || branding.logoUrl === null) return '';
  const image = `<img src="${escapeHtml(branding.logoUrl)}" width="${branding.logoWidth}" alt="${escapeHtml(deriveLogoAltText(senderName))}" style="border:0;display:block;height:auto;max-width:100%;width:${branding.logoWidth}px" />`;
  const content = branding.logoLinkUrl === null
    ? image
    : `<a href="${escapeHtml(branding.logoLinkUrl)}" style="display:inline-block;text-decoration:none">${image}</a>`;
  return content;
}

function deriveLogoAltText(senderName: string): string {
  const normalized = senderName.replace(/[<>]/gu, '').replace(/\s+/gu, ' ').trim();
  return normalized === '' ? 'Brand' : normalized;
}

function textContent(message: CustomerEmailTransportMessage): string {
  const branding = message.branding ?? defaultCustomerEmailBranding();
  const footerLines = [
    branding.businessName,
    branding.address,
    branding.phone,
    branding.contactEmail ?? '',
    branding.websiteUrl ?? '',
    branding.note,
  ].map((value) => value.trim()).filter((value) => value !== '');
  return footerLines.length === 0
    ? message.body
    : `${message.body}\n\n--\n${footerLines.join('\n')}`;
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
