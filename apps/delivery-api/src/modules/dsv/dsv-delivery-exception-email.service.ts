import type { Prisma, PrismaClient } from '@prisma/client';

import type { DsvManualEmailService } from './dsv-manual-email.service.js';

export type DsvDeliveryExceptionEmailSnapshot = {
  destination: string;
  driver: string;
  reason: string;
  reportedAt: string;
  serviceDate: string;
  subject: string;
  textContent: string;
};

export function createDsvDeliveryExceptionEmailSnapshot(input: {
  destination: string;
  driver: string;
  reason: string;
  reportedAt: Date;
  serviceDate: Date;
}): DsvDeliveryExceptionEmailSnapshot {
  const serviceDate = input.serviceDate.toISOString().slice(0, 10);
  const reportedAt = input.reportedAt.toISOString();
  const reportedAtSeoul = new Date(input.reportedAt.getTime() + 9 * 60 * 60 * 1_000)
    .toISOString().slice(0, 19).replace('T', ' ') + ' (Asia/Seoul)';
  return {
    destination: input.destination,
    driver: input.driver,
    reason: input.reason,
    reportedAt,
    serviceDate,
    subject: `[CLEVER DSV] ${serviceDate} 미배송 보고`,
    textContent: [
      `배차일: ${serviceDate}`,
      `기사: ${input.driver}`,
      `배송지: ${input.destination}`,
      `보고 시각: ${reportedAtSeoul}`,
      `사유: ${input.reason}`,
    ].join('\n'),
  };
}

type ReportEmailPrisma = Pick<PrismaClient, 'dsvDeliveryException'>;

/**
 * Explicit injection seam only. There is no runtime registration, timer, or
 * provider configuration. The existing report is its one durable email job.
 * An injected provider must honor the stable report ID as its idempotency key.
 */
export class PrismaDsvDeliveryExceptionEmailService {
  constructor(
    private readonly prisma: ReportEmailPrisma,
    private readonly configuration?: { recipient: string; senderEmail: string },
    private readonly sender?: Pick<DsvManualEmailService, 'send'>,
  ) {}

  async sendPrepared(input: { reportId: string; shopId: string }): Promise<{ emailStatus: string }> {
    const report = await this.prisma.dsvDeliveryException.findFirstOrThrow({
      where: { id: input.reportId, shopId: input.shopId },
    });
    if (report.emailStatus !== 'PREPARED' || this.configuration === undefined || this.sender === undefined) {
      return { emailStatus: report.emailStatus };
    }
    if (!isEmail(this.configuration.recipient) || !isEmail(this.configuration.senderEmail)) {
      throw new Error('A valid DSV report recipient and sender are required');
    }
    const snapshot = readSnapshot(report.emailSnapshot);
    const claimed = await this.prisma.dsvDeliveryException.updateMany({
      data: {
        emailRecipient: this.configuration.recipient,
        emailSender: this.configuration.senderEmail,
        emailStatus: 'SENDING',
      },
      where: { emailStatus: 'PREPARED', id: report.id, shopId: input.shopId },
    });
    if (claimed.count !== 1) {
      const current = await this.prisma.dsvDeliveryException.findFirstOrThrow({
        where: { id: report.id, shopId: input.shopId },
      });
      return { emailStatus: current.emailStatus };
    }
    try {
      const sent = await this.sender.send({
        commandId: report.id,
        recipients: [this.configuration.recipient],
        senderEmail: this.configuration.senderEmail,
        subject: snapshot.subject,
        textContent: snapshot.textContent,
      });
      const sentAt = new Date(sent.sentAt);
      if (!Number.isFinite(sentAt.getTime()) || sent.recipientCount !== 1) {
        throw new Error('The email sender returned an invalid receipt');
      }
      await this.prisma.dsvDeliveryException.updateMany({
        data: { emailMessageId: sent.messageId, emailSentAt: sentAt, emailStatus: 'SENT' },
        where: { emailStatus: 'SENDING', id: report.id, shopId: input.shopId },
      });
      return { emailStatus: 'SENT' };
    } catch {
      // A transport error can follow provider acceptance. Do not resend unknown
      // outcomes. A process crash also leaves SENDING closed to automatic retry.
      await this.prisma.dsvDeliveryException.updateMany({
        data: { emailStatus: 'UNKNOWN' },
        where: { emailStatus: 'SENDING', id: report.id, shopId: input.shopId },
      });
      return { emailStatus: 'UNKNOWN' };
    }
  }
}

function isEmail(value: string): boolean {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
}

function readSnapshot(value: Prisma.JsonValue): DsvDeliveryExceptionEmailSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || ['destination', 'driver', 'reason', 'reportedAt', 'serviceDate', 'subject', 'textContent']
      .some((field) => typeof value[field] !== 'string')) {
    throw new Error('The DSV report email snapshot is missing');
  }
  return value as DsvDeliveryExceptionEmailSnapshot;
}
