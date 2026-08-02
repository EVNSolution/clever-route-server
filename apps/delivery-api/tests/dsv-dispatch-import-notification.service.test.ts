import { describe, expect, test, vi } from 'vitest';

import {
  BrevoDsvDispatchImportNotificationService,
  loadDsvDispatchImportNotificationService,
} from '../src/modules/dsv/dsv-dispatch-import-notification.service.js';

const appliedNotification = {
  actor: 'operator',
  appliedAt: new Date('2026-07-31T01:20:00.000Z'),
  fileName: '고정차량배차리스트_260731.xlsx',
  importId: '019f0000-0000-7000-8000-000000000001',
  planDate: '2026-07-31',
  shopDomain: 'dsv-demo.local',
  summary: {
    appliedRows: 53,
    newRows: 50,
    noOpRows: 2,
    updatedRows: 1,
  },
};

describe('DSV dispatch import Brevo notification', () => {
  test('uses the transactional email contract without including delivery addresses', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(JSON.stringify({ messageId: 'message-a' }), { status: 201 })));
    const service = new BrevoDsvDispatchImportNotificationService({
      apiKey: 'brevo-key',
      recipients: ['ops@example.com', 'lead@example.com'],
      senderEmail: 'noreply@example.com',
      senderName: 'CLEVER DSV',
    }, fetchMock);

    await service.notifyApplied(appliedNotification);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://api.brevo.com/v3/smtp/email');
    expect(init).toMatchObject({
      headers: {
        'api-key': 'brevo-key',
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    expect(typeof init?.body).toBe('string');
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '') as Record<string, unknown>;
    expect(body).toMatchObject({
      headers: {
        'Idempotency-Key': `dsv-dispatch-import:${appliedNotification.importId}:applied`,
      },
      sender: { email: 'noreply@example.com', name: 'CLEVER DSV' },
      subject: '[CLEVER DSV] 배차 업로드 완료 - 2026-07-31',
      to: [{ email: 'ops@example.com' }, { email: 'lead@example.com' }],
    });
    expect(String(body.textContent)).toContain('전체 반영: 53건');
    expect(String(body.textContent)).not.toContain('배송지');
  });

  test('retries a quota response before succeeding', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ messageId: 'message-a' }), { status: 201 }));
    const sleep = vi.fn(() => Promise.resolve());
    const service = new BrevoDsvDispatchImportNotificationService({
      apiKey: 'brevo-key',
      recipients: ['ops@example.com'],
      senderEmail: 'noreply@example.com',
      senderName: 'CLEVER DSV',
    }, fetchMock, sleep);

    await service.notifyApplied(appliedNotification);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(250);
  });

  test('stays disabled when no email environment is configured and rejects partial configuration', () => {
    expect(loadDsvDispatchImportNotificationService({})).toBeUndefined();
    expect(() => loadDsvDispatchImportNotificationService({
      BREVO_API_KEY: 'brevo-key',
    })).toThrow(/requires BREVO_API_KEY/u);
  });
});
