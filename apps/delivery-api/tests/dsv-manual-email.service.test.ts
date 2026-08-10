import { describe, expect, test, vi } from 'vitest';

import {
  BrevoDsvManualEmailService,
  DsvManualEmailConfigurationError,
  DsvManualEmailSendError,
  loadDsvManualEmailService,
} from '../src/modules/dsv/dsv-manual-email.service.js';

describe('DSV manual Brevo email', () => {
  test('sends exactly once with a command-scoped idempotency key', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(JSON.stringify({ messageId: 'message-a' }), { status: 201 })));
    const service = new BrevoDsvManualEmailService({
      apiKey: 'brevo-key',
      defaultRecipients: ['ops@example.com'],
      senderName: 'CLEVER DSV',
    }, fetchMock);

    const result = await service.send({
      commandId: '11111111-1111-4111-8111-111111111111',
      recipients: ['ops@example.com'],
      senderEmail: 'noreply@example.com',
      subject: '수동 발송 테스트',
      textContent: '사용자가 확인한 본문입니다.',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://api.brevo.com/v3/smtp/email');
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '') as Record<string, unknown>;
    expect(body).toMatchObject({
      headers: { 'Idempotency-Key': 'dsv-manual-email:11111111-1111-4111-8111-111111111111' },
      sender: { email: 'noreply@example.com', name: 'CLEVER DSV' },
      subject: '수동 발송 테스트',
      tags: ['dsv-manual-test'],
      textContent: '사용자가 확인한 본문입니다.',
      to: [{ email: 'ops@example.com' }],
    });
    expect(result).toMatchObject({ messageId: 'message-a', recipientCount: 1 });
  });

  test('renders text line breaks explicitly in HTML for mail clients', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(JSON.stringify({ messageId: 'message-a' }), { status: 201 })));
    const service = new BrevoDsvManualEmailService({
      apiKey: 'brevo-key',
      senderName: 'CLEVER DSV',
    }, fetchMock);

    await service.send({
      commandId: '11111111-1111-4111-8111-111111111111',
      recipients: ['ops@example.com'],
      senderEmail: 'noreply@example.com',
      subject: '줄바꿈 테스트',
      textContent: '첫 줄\n\n둘째 문단\r\n&lt;링크>',
    });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '') as { htmlContent: string };
    expect(body.htmlContent).toContain('첫 줄<br><br>둘째 문단<br>&amp;lt;링크&gt;');
    expect(body.htmlContent).not.toContain('white-space:pre-wrap');
  });

  test('does not retry a quota response', async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 429 })));
    const service = new BrevoDsvManualEmailService({
      apiKey: 'brevo-key',
      senderName: 'CLEVER DSV',
    }, fetchMock);

    await expect(service.send({
      commandId: '11111111-1111-4111-8111-111111111111',
      recipients: ['ops@example.com'],
      senderEmail: 'noreply@example.com',
      subject: '수동 발송 테스트',
      textContent: '본문',
    })).rejects.toBeInstanceOf(DsvManualEmailSendError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('reports configuration without exposing the API key and blocks sending while incomplete', async () => {
    const service = loadDsvManualEmailService({
      BREVO_SENDER_NAME: 'CLEVER DSV',
      DSV_MANUAL_EMAIL_DEFAULT_TO: 'ops@example.com',
    });

    expect(service.getConfig({ senderEmail: null, subject: '제목', textContent: '본문' })).toEqual({
      apiConfigured: false,
      configured: false,
      defaultRecipients: ['ops@example.com'],
      defaultSubject: '제목',
      defaultTextContent: '본문',
      senderEmail: null,
      senderName: 'CLEVER DSV',
    });
    await expect(service.send({
      commandId: '11111111-1111-4111-8111-111111111111',
      recipients: ['ops@example.com'],
      senderEmail: 'noreply@example.com',
      subject: '수동 발송 테스트',
      textContent: '본문',
    })).rejects.toBeInstanceOf(DsvManualEmailConfigurationError);
  });
});
