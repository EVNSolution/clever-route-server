export type DsvDispatchImportAppliedNotification = {
  actor: string;
  appliedAt: Date;
  fileName: string;
  importId: string;
  planDate: string;
  shopDomain: string;
  summary: {
    appliedRows: number;
    newRows: number;
    noOpRows: number;
    updatedRows: number;
  };
};

export type DsvDispatchImportNotificationService = {
  notifyApplied(input: DsvDispatchImportAppliedNotification): Promise<void>;
};

export type DsvDispatchImportNotificationRuntimeEnv = Partial<Record<
  | 'BREVO_API_KEY'
  | 'BREVO_SENDER_EMAIL'
  | 'BREVO_SENDER_NAME'
  | 'DSV_DISPATCH_UPLOAD_NOTIFICATION_TO',
  string
>>;

type FetchLike = typeof fetch;

const brevoTransactionalEmailUrl = 'https://api.brevo.com/v3/smtp/email';
const sendRetryDelaysMs = [250, 1_000] as const;

export class BrevoDsvDispatchImportNotificationService implements DsvDispatchImportNotificationService {
  constructor(
    private readonly config: {
      apiKey: string;
      recipients: string[];
      senderEmail: string;
      senderName: string;
    },
    private readonly fetchImpl: FetchLike = fetch,
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
  ) {}

  async notifyApplied(input: DsvDispatchImportAppliedNotification): Promise<void> {
    const responseBody = emailBody(input);
    for (let attempt = 0; attempt <= sendRetryDelaysMs.length; attempt += 1) {
      try {
        const response = await this.fetchImpl(brevoTransactionalEmailUrl, {
          body: JSON.stringify({
            headers: {
              'Idempotency-Key': `dsv-dispatch-import:${input.importId}:applied`,
            },
            htmlContent: responseBody.html,
            sender: {
              email: this.config.senderEmail,
              name: this.config.senderName,
            },
            subject: `[CLEVER DSV] 배차 업로드 완료 - ${input.planDate}`,
            tags: ['dsv-dispatch-import'],
            textContent: responseBody.text,
            to: this.config.recipients.map((email) => ({ email })),
          }),
          headers: {
            accept: 'application/json',
            'api-key': this.config.apiKey,
            'content-type': 'application/json',
          },
          method: 'POST',
          signal: AbortSignal.timeout(5_000),
        });
        if (response.ok) return;
        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable || attempt === sendRetryDelaysMs.length) {
          throw new NonRetryableNotificationError(
            `Brevo dispatch upload notification failed with HTTP ${response.status}.`,
          );
        }
      } catch (error) {
        if (error instanceof NonRetryableNotificationError || attempt === sendRetryDelaysMs.length) throw error;
      }
      await this.sleep(sendRetryDelaysMs[attempt] ?? 0);
    }
  }
}

export function loadDsvDispatchImportNotificationService(
  env: DsvDispatchImportNotificationRuntimeEnv,
): DsvDispatchImportNotificationService | undefined {
  const recipients = readRecipients(env.DSV_DISPATCH_UPLOAD_NOTIFICATION_TO);
  const apiKey = readOptional(env.BREVO_API_KEY);
  const senderEmail = readOptional(env.BREVO_SENDER_EMAIL);
  const senderName = readOptional(env.BREVO_SENDER_NAME) ?? 'CLEVER DSV';
  const configured = recipients.length > 0 || apiKey !== undefined || senderEmail !== undefined;
  if (!configured) return undefined;
  if (recipients.length === 0 || apiKey === undefined || senderEmail === undefined) {
    throw new Error(
      'Dispatch upload email requires BREVO_API_KEY, BREVO_SENDER_EMAIL, and DSV_DISPATCH_UPLOAD_NOTIFICATION_TO.',
    );
  }
  if (!isEmail(senderEmail)) throw new Error('BREVO_SENDER_EMAIL must be a valid email address.');
  return new BrevoDsvDispatchImportNotificationService({
    apiKey,
    recipients,
    senderEmail,
    senderName,
  });
}

function emailBody(input: DsvDispatchImportAppliedNotification): { html: string; text: string } {
  const rows = [
    ['배차일', input.planDate],
    ['파일', input.fileName],
    ['전체 반영', `${input.summary.appliedRows}건`],
    ['신규', `${input.summary.newRows}건`],
    ['수정', `${input.summary.updatedRows}건`],
    ['변경 없음', `${input.summary.noOpRows}건`],
    ['처리자', input.actor],
    ['처리 시각', formatKoreanDateTime(input.appliedAt)],
  ] as const;
  const text = [
    'CLEVER DSV 배차 업로드가 완료되었습니다.',
    '',
    ...rows.map(([label, value]) => `${label}: ${value}`),
  ].join('\n');
  const htmlRows = rows.map(([label, value]) =>
    `<tr><th style="padding:8px 12px;text-align:left;background:#f5f5f7;border-bottom:1px solid #e5e5ea">${escapeHtml(label)}</th>`
    + `<td style="padding:8px 12px;border-bottom:1px solid #e5e5ea">${escapeHtml(value)}</td></tr>`).join('');
  return {
    html: `<div style="font-family:Arial,sans-serif;color:#1d1d1f;line-height:1.5">`
      + `<h2 style="margin:0 0 8px">배차 업로드 완료</h2>`
      + `<p style="margin:0 0 18px;color:#6e6e73">CLEVER DSV에 배차 정보가 반영되었습니다.</p>`
      + `<table style="border-collapse:collapse;width:100%;max-width:620px;border:1px solid #e5e5ea">${htmlRows}</table>`
      + `<p style="margin:18px 0 0;color:#8e8e93;font-size:12px">배송지 주소와 개인정보는 메일에 포함하지 않습니다.</p>`
      + `</div>`,
    text,
  };
}

function readRecipients(value: string | undefined): string[] {
  if (value === undefined) return [];
  const recipients = [...new Set(value.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean))];
  if (recipients.some((email) => !isEmail(email))) {
    throw new Error('DSV_DISPATCH_UPLOAD_NOTIFICATION_TO contains an invalid email address.');
  }
  return recipients;
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
}

function readOptional(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  return value.trim();
}

function formatKoreanDateTime(value: Date): string {
  return new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Seoul',
  }).format(value);
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

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

class NonRetryableNotificationError extends Error {}
