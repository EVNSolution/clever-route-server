import { describe, expect, test, vi } from 'vitest';

import {
  createDsvDeliveryExceptionEmailSnapshot,
  PrismaDsvDeliveryExceptionEmailService,
} from '../src/modules/dsv/dsv-delivery-exception-email.service.js';

const snapshot = createDsvDeliveryExceptionEmailSnapshot({
  destination: '고객사 물류센터 서울시 강서구 공항대로 100',
  driver: '홍길동',
  reason: '진입로가 폐쇄되었습니다.\n담당자가 다음 날 배송을 요청했습니다.',
  reportedAt: new Date('2026-10-08T01:20:30.123Z'),
  serviceDate: new Date('2026-10-08T00:00:00.000Z'),
});

function harness() {
  const report = { emailSnapshot: snapshot, emailStatus: 'PREPARED', id: 'report-a', shopId: 'shop-a' };
  const prisma = { dsvDeliveryException: {
    findFirstOrThrow: vi.fn().mockImplementation(() => Promise.resolve({ ...report })),
    updateMany: vi.fn().mockImplementation((input: {
      data: { emailStatus: string }; where: { emailStatus: string };
    }) => {
      if (report.emailStatus !== input.where.emailStatus) return Promise.resolve({ count: 0 });
      Object.assign(report, input.data);
      return Promise.resolve({ count: 1 });
    }),
  } };
  const sender = { send: vi.fn().mockResolvedValue({
    messageId: 'isolated-message', recipientCount: 1, sentAt: '2026-10-08T01:21:00.000Z',
  }) };
  const service = new PrismaDsvDeliveryExceptionEmailService(prisma as never, {
    recipient: 'operations@example.test', senderEmail: 'reports@example.test',
  }, sender);
  return { prisma, report, sender, service };
}

const input = { reportId: 'report-a', shopId: 'shop-a' };

describe('DSV delivery exception prepared email', () => {
  test('snapshots all required content, multiline reason and Asia/Seoul report time', () => {
    expect(snapshot).toMatchObject({ reportedAt: '2026-10-08T01:20:30.123Z', serviceDate: '2026-10-08' });
    expect(snapshot.textContent).toBe([
      '배차일: 2026-10-08',
      '기사: 홍길동',
      '배송지: 고객사 물류센터 서울시 강서구 공항대로 100',
      '보고 시각: 2026-10-08 10:20:30 (Asia/Seoul)',
      '사유: 진입로가 폐쇄되었습니다.\n담당자가 다음 날 배송을 요청했습니다.',
    ].join('\n'));
  });

  test('leaves the accepted report prepared without both explicit configuration and sender', async () => {
    const { prisma, sender } = harness();
    expect(await new PrismaDsvDeliveryExceptionEmailService(prisma as never).sendPrepared(input))
      .toEqual({ emailStatus: 'PREPARED' });
    expect(await new PrismaDsvDeliveryExceptionEmailService(prisma as never, undefined, sender).sendPrepared(input))
      .toEqual({ emailStatus: 'PREPARED' });
    expect(sender.send).not.toHaveBeenCalled();
    expect(prisma.dsvDeliveryException.updateMany).not.toHaveBeenCalled();
  });

  test('uses one stable provider key and one report row for concurrent and later retries', async () => {
    const { report, sender, service } = harness();
    await Promise.all([service.sendPrepared(input), service.sendPrepared(input)]);
    expect(await service.sendPrepared(input)).toEqual({ emailStatus: 'SENT' });
    expect(sender.send).toHaveBeenCalledOnce();
    expect(sender.send).toHaveBeenCalledWith({
      commandId: 'report-a', recipients: ['operations@example.test'], senderEmail: 'reports@example.test',
      subject: snapshot.subject, textContent: snapshot.textContent,
    });
    expect(report).toMatchObject({
      emailMessageId: 'isolated-message', emailRecipient: 'operations@example.test',
      emailSender: 'reports@example.test', emailSentAt: new Date('2026-10-08T01:21:00.000Z'), emailStatus: 'SENT',
    });
  });

  test('does not resend an unknown transport outcome', async () => {
    const { report, sender, service } = harness();
    sender.send.mockRejectedValueOnce(new Error('connection lost after acceptance'));
    expect(await service.sendPrepared(input)).toEqual({ emailStatus: 'UNKNOWN' });
    expect(await service.sendPrepared(input)).toEqual({ emailStatus: 'UNKNOWN' });
    expect(report.emailStatus).toBe('UNKNOWN');
    expect(sender.send).toHaveBeenCalledOnce();
  });

  test('does not resend an interrupted in-flight attempt or retroactively queue a historical report', async () => {
    const { report, sender, service } = harness();
    for (const emailStatus of ['SENDING', 'NOT_PREPARED']) {
      report.emailStatus = emailStatus;
      expect(await service.sendPrepared(input)).toEqual({ emailStatus });
    }
    expect(sender.send).not.toHaveBeenCalled();
  });

  test('keeps a report prepared when email configuration is invalid', async () => {
    const { prisma, sender } = harness();
    const service = new PrismaDsvDeliveryExceptionEmailService(prisma as never, {
      recipient: 'invalid', senderEmail: 'reports@example.test',
    }, sender);
    await expect(service.sendPrepared(input)).rejects.toThrow('valid DSV report recipient');
    expect(prisma.dsvDeliveryException.updateMany).not.toHaveBeenCalled();
    expect(sender.send).not.toHaveBeenCalled();
  });
});
