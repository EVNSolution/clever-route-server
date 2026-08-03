export type DsvManualEmailConfig = {
  apiConfigured: boolean;
  configured: boolean;
  defaultRecipients: string[];
  defaultSubject: string;
  defaultTextContent: string;
  senderEmail: string | null;
  senderName: string;
};

export type DsvManualEmailInput = {
  commandId: string;
  recipients: string[];
  senderEmail: string;
  subject: string;
  textContent: string;
};

export type DsvManualEmailResult = {
  messageId: string | null;
  recipientCount: number;
  sentAt: string;
};

export type DsvManualEmailService = {
  getConfig(input: { senderEmail: string | null; subject: string; textContent: string }): DsvManualEmailConfig;
  send(input: DsvManualEmailInput): Promise<DsvManualEmailResult>;
};

export type DsvManualEmailRuntimeEnv = Partial<Record<
  | 'BREVO_API_KEY'
  | 'BREVO_SENDER_NAME'
  | 'DSV_MANUAL_EMAIL_DEFAULT_TO',
  string
>>;

type FetchLike = typeof fetch;

const brevoTransactionalEmailUrl = 'https://api.brevo.com/v3/smtp/email';

export class BrevoDsvManualEmailService implements DsvManualEmailService {
  private readonly apiKey: string | undefined;
  private readonly defaultRecipients: string[];
  private readonly senderName: string;

  constructor(
    config: {
      apiKey?: string;
      defaultRecipients?: string[];
      senderName: string;
    },
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.apiKey = config.apiKey;
    this.defaultRecipients = config.defaultRecipients ?? [];
    this.senderName = config.senderName;
  }

  getConfig(input: { senderEmail: string | null; subject: string; textContent: string }): DsvManualEmailConfig {
    return {
      apiConfigured: this.apiKey !== undefined,
      configured: this.apiKey !== undefined && input.senderEmail !== null,
      defaultRecipients: [...this.defaultRecipients],
      defaultSubject: input.subject,
      defaultTextContent: input.textContent,
      senderEmail: input.senderEmail,
      senderName: this.senderName,
    };
  }

  async send(input: DsvManualEmailInput): Promise<DsvManualEmailResult> {
    if (this.apiKey === undefined) {
      throw new DsvManualEmailConfigurationError();
    }
    const recipients = normalizeRecipients(input.recipients);
    const response = await this.fetchImpl(brevoTransactionalEmailUrl, {
      body: JSON.stringify({
        headers: {
          'Idempotency-Key': `dsv-manual-email:${input.commandId}`,
        },
        htmlContent: plainTextHtml(input.textContent),
        sender: {
          email: input.senderEmail,
          name: this.senderName,
        },
        subject: input.subject,
        tags: ['dsv-manual-test'],
        textContent: input.textContent,
        to: recipients.map((email) => ({ email })),
      }),
      headers: {
        accept: 'application/json',
        'api-key': this.apiKey,
        'content-type': 'application/json',
      },
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new DsvManualEmailSendError(response.status);
    }
    const responseBody = await readJsonObject(response);
    return {
      messageId: typeof responseBody?.messageId === 'string' ? responseBody.messageId : null,
      recipientCount: recipients.length,
      sentAt: new Date().toISOString(),
    };
  }
}

export function loadDsvManualEmailService(env: DsvManualEmailRuntimeEnv): DsvManualEmailService {
  const apiKey = readOptional(env.BREVO_API_KEY);
  const senderName = readOptional(env.BREVO_SENDER_NAME) ?? 'CLEVER DSV';
  const defaultRecipients = normalizeRecipients(readList(env.DSV_MANUAL_EMAIL_DEFAULT_TO));
  return new BrevoDsvManualEmailService({
    ...(apiKey === undefined ? {} : { apiKey }),
    defaultRecipients,
    senderName,
  });
}

export class DsvManualEmailConfigurationError extends Error {
  constructor() {
    super('Brevo manual email is not configured.');
  }
}

export class DsvManualEmailSendError extends Error {
  constructor(readonly statusCode: number) {
    super(`Brevo manual email failed with HTTP ${statusCode}.`);
  }
}

function normalizeRecipients(values: string[]): string[] {
  const recipients = [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))];
  if (recipients.length > 10 || recipients.some((email) => !isEmail(email))) {
    throw new Error('Manual email recipients are invalid.');
  }
  return recipients;
}

function readList(value: string | undefined): string[] {
  return value?.split(',') ?? [];
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
}

function readOptional(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  return value.trim();
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
