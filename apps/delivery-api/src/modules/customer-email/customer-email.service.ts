import type { Prisma, PrismaClient } from '@prisma/client';

import {
  customerEmailSignals,
  defaultCustomerEmailSettings,
  isEmail,
  normalizeCustomerEmailSettings,
  readCustomerEmailSignal,
  validateCustomerEmailSettingsPayload,
  type CustomerEmailSettings,
  type CustomerEmailSignal,
} from './customer-email-settings.js';
import {
  CustomerEmailTransportConfigurationError,
  CustomerEmailTransportSendError,
  type CustomerEmailTransport,
} from './customer-email-transport.js';
import { DEFAULT_SHOPIFY_APP_ID, appScopedShopWhere } from '../shopify/shopify-app-scope.js';

export type CustomerEmailPreviewInput = {
  appId?: string | undefined;
  deliveryStopIds?: string[] | undefined;
  routePlanId: string;
  shopDomain: string;
  signal: CustomerEmailSignal;
};

export type CustomerEmailSendInput = CustomerEmailPreviewInput & {
  actor: string;
  commandId: string;
  confirmed: boolean;
};

export type CustomerEmailPreview = {
  counts: {
    eligible: number;
    rendered: number;
    skipped: number;
    totalStops: number;
  };
  recipients: CustomerEmailRenderedRecipient[];
  skipped: CustomerEmailSkippedRecipient[];
};

export type CustomerEmailDispatch = {
  commandId: string;
  counts: {
    duplicate: number;
    failed: number;
    sent: number;
    skipped: number;
  };
  duplicate: boolean;
  dispatchId: string;
  results: CustomerEmailDispatchResult[];
};

export type CustomerEmailRenderedRecipient = {
  deliveryStopId: string;
  email: string;
  orderId: string;
  orderNumber: string;
  rendered: {
    body: string;
    subject: string;
  };
  sequence: number;
};

export type CustomerEmailSkippedRecipient = {
  code: string;
  deliveryStopId: string;
  message: string;
  orderId: string;
  orderNumber: string;
  sequence: number;
};

export type CustomerEmailDispatchResult = {
  deliveryStopId: string | null;
  email: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  orderId: string | null;
  provider: string | null;
  providerMessageId: string | null;
  status: 'DUPLICATE' | 'FAILED' | 'SENT' | 'SKIPPED';
};

type CustomerEmailPrismaClient = Pick<
  PrismaClient,
  '$transaction' | 'customerEmailManualDispatch' | 'customerEmailManualDispatchRecipient' | 'routePlan' | 'shop'
>;

type CustomerEmailRoutePlanRow = {
  id: string;
  name: string;
  planDate: Date;
  routeStops: Array<{
    deliveryStop: {
      address1: string | null;
      address2: string | null;
      city: string | null;
      countryCode: string | null;
      deliveryDate: Date | null;
      id: string;
      order: {
        email: string | null;
        id: string;
        name: string;
      };
      orderId: string;
      postalCode: string | null;
      province: string | null;
      recipientName: string | null;
      status: string;
    };
    estimatedArrivalAt: Date | null;
    sequence: number;
  }>;
  shop: {
    customerEmailSettings: unknown;
    id: string;
    shopDomain: string;
  };
};

export class CustomerEmailService {
  constructor(
    private readonly prisma: CustomerEmailPrismaClient,
    private readonly transport: CustomerEmailTransport,
  ) {}

  async getSettings(input: { appId?: string | undefined; shopDomain: string }): Promise<CustomerEmailSettings | null> {
    const shop = await this.prisma.shop.findUnique({
      select: { customerEmailSettings: true },
      where: appScopedShopWhere({ appId: input.appId, shopDomain: normalizeShopDomain(input.shopDomain) }),
    });
    return shop === null ? null : normalizeCustomerEmailSettings(shop.customerEmailSettings);
  }

  async saveSettings(input: {
    appId?: string | undefined;
    payload: unknown;
    shopDomain: string;
  }): Promise<CustomerEmailSettings | null> {
    if (input.payload === null || typeof input.payload !== 'object' || Array.isArray(input.payload)) {
      throw new Error('Customer email settings must be an object.');
    }
    const settings = normalizeCustomerEmailSettings(input.payload);
    const shop = await this.prisma.shop.findUnique({
      select: { id: true },
      where: appScopedShopWhere({ appId: input.appId, shopDomain: normalizeShopDomain(input.shopDomain) }),
    });
    if (shop === null) return null;
    await this.prisma.shop.update({
      data: { customerEmailSettings: settings },
      where: { id: shop.id },
    });
    return settings;
  }

  async sendTest(input: {
    appId?: string | undefined;
    body?: string | undefined;
    recipientEmail: string;
    shopDomain: string;
    signal?: CustomerEmailSignal | undefined;
    subject?: string | undefined;
  }): Promise<{ messageId: string | null; provider: string; recipientEmail: string; sentAt: string }> {
    const settings = await this.getSettings(input);
    if (settings === null) throw new CustomerEmailNotFoundError();
    assertConfigured(settings);
    if (!isEmail(input.recipientEmail.trim().toLowerCase())) throw new CustomerEmailValidationError('Test recipient email is invalid.');
    const signal = input.signal ?? 'DELIVERY_SCHEDULED';
    const template = settings.templates[signal];
    const result = await this.transport.send({
      branding: settings.branding,
      body: input.body?.trim() || renderTemplate(template.body, testTemplateContext(settings)),
      commandId: `test:${cryptoRandomId()}`,
      recipientEmail: input.recipientEmail.trim().toLowerCase(),
      replyTo: settings.replyTo,
      senderEmail: settings.senderEmail,
      senderName: settings.senderName,
      signal: 'TEST',
      subject: input.subject?.trim() || renderTemplate(template.subject, testTemplateContext(settings)),
      tags: ['customer-delivery-email', 'test'],
    });
    return {
      messageId: result.providerMessageId,
      provider: result.provider,
      recipientEmail: input.recipientEmail.trim().toLowerCase(),
      sentAt: new Date().toISOString(),
    };
  }

  async preview(input: CustomerEmailPreviewInput): Promise<CustomerEmailPreview | null> {
    const routePlan = await this.findRoutePlan(input);
    if (routePlan === null) return null;
    const settings = normalizeCustomerEmailSettings(routePlan.shop.customerEmailSettings);
    return buildPreview(routePlan, settings, input);
  }

  async send(input: CustomerEmailSendInput): Promise<CustomerEmailDispatch | null> {
    if (!input.confirmed) throw new CustomerEmailValidationError('Manual customer email send must be confirmed.');
    if (input.commandId.trim() === '') throw new CustomerEmailValidationError('commandId is required.');

    const routePlan = await this.findRoutePlan(input);
    if (routePlan === null) return null;
    const settings = normalizeCustomerEmailSettings(routePlan.shop.customerEmailSettings);
    assertConfigured(settings);
    const preview = buildPreview(routePlan, settings, input);
    const template = settings.templates[input.signal];
    if (!template.enabled) throw new CustomerEmailValidationError('Selected customer email template is disabled.');

    const created = await this.createDispatch({
      actor: input.actor,
      commandId: input.commandId,
      input,
      preview,
      routePlan,
      settings,
      template,
    });
    if (created.duplicate) return this.readExistingDispatch(routePlan.shop.id, input.commandId, true);

    const results: CustomerEmailDispatchResult[] = [];
    for (const skipped of preview.skipped) {
      results.push({
        deliveryStopId: skipped.deliveryStopId,
        email: null,
        errorCode: skipped.code,
        errorMessage: skipped.message,
        orderId: skipped.orderId,
        provider: null,
        providerMessageId: null,
        status: 'SKIPPED',
      });
    }

    for (const recipient of preview.recipients) {
      const rowCommandId = `${input.commandId}:${recipient.deliveryStopId}`;
      try {
        const result = await this.transport.send({
          branding: settings.branding,
          body: recipient.rendered.body,
          commandId: rowCommandId,
          recipientEmail: recipient.email,
          replyTo: settings.replyTo,
          senderEmail: settings.senderEmail,
          senderName: settings.senderName,
          signal: input.signal,
          subject: recipient.rendered.subject,
          tags: ['customer-delivery-email', input.signal.toLowerCase()],
        });
        await this.updateRecipient(created.dispatchId, recipient.deliveryStopId, {
          provider: result.provider,
          providerMessageId: result.providerMessageId,
          sentAt: new Date(),
          status: 'SENT',
        });
        results.push({
          deliveryStopId: recipient.deliveryStopId,
          email: recipient.email,
          errorCode: null,
          errorMessage: null,
          orderId: recipient.orderId,
          provider: result.provider,
          providerMessageId: result.providerMessageId,
          status: 'SENT',
        });
      } catch (error) {
        const errorCode = error instanceof CustomerEmailTransportConfigurationError
          ? 'CUSTOMER_EMAIL_NOT_CONFIGURED'
          : error instanceof CustomerEmailTransportSendError
            ? 'CUSTOMER_EMAIL_SEND_FAILED'
            : 'CUSTOMER_EMAIL_SEND_ERROR';
        const errorMessage = error instanceof Error ? error.message : 'Customer email send failed.';
        await this.updateRecipient(created.dispatchId, recipient.deliveryStopId, {
          errorCode,
          errorMessage,
          status: 'FAILED',
        });
        results.push({
          deliveryStopId: recipient.deliveryStopId,
          email: recipient.email,
          errorCode,
          errorMessage,
          orderId: recipient.orderId,
          provider: null,
          providerMessageId: null,
          status: 'FAILED',
        });
      }
    }

    const counts = countDispatchResults(results);
    await this.prisma.customerEmailManualDispatch.update({
      data: { counts: counts },
      where: { id: created.dispatchId },
    });

    return {
      commandId: input.commandId,
      counts,
      dispatchId: created.dispatchId,
      duplicate: false,
      results,
    };
  }

  private async findRoutePlan(input: CustomerEmailPreviewInput): Promise<CustomerEmailRoutePlanRow | null> {
    const routePlan = await this.prisma.routePlan.findFirst({
      select: {
        id: true,
        name: true,
        planDate: true,
        routeStops: {
          orderBy: { sequence: 'asc' },
          select: {
            deliveryStop: {
              select: {
                address1: true,
                address2: true,
                city: true,
                countryCode: true,
                deliveryDate: true,
                id: true,
                order: { select: { email: true, id: true, name: true } },
                orderId: true,
                postalCode: true,
                province: true,
                recipientName: true,
                status: true,
              },
            },
            estimatedArrivalAt: true,
            sequence: true,
          },
        },
        shop: { select: { customerEmailSettings: true, id: true, shopDomain: true } },
      },
      where: {
        id: input.routePlanId,
        shop: { is: shopWhereInput(input) },
      },
    });
    return routePlan;
  }

  private async createDispatch(input: {
    actor: string;
    commandId: string;
    input: CustomerEmailSendInput;
    preview: CustomerEmailPreview;
    routePlan: CustomerEmailRoutePlanRow;
    settings: CustomerEmailSettings;
    template: { body: string; enabled: boolean; subject: string };
  }): Promise<{ dispatchId: string; duplicate: boolean }> {
    try {
      const dispatch = await this.prisma.customerEmailManualDispatch.create({
        data: {
          actor: input.actor,
          commandId: input.commandId,
          counts: countDispatchResults([]),
          request: {
            deliveryStopIds: input.input.deliveryStopIds ?? null,
            routePlanId: input.input.routePlanId,
            signal: input.input.signal,
          },
          routePlanId: input.input.routePlanId,
          shopId: input.routePlan.shop.id,
          signal: input.input.signal,
          template: {
            body: input.template.body,
            replyTo: input.settings.replyTo,
            senderEmail: input.settings.senderEmail,
            senderName: input.settings.senderName,
            subject: input.template.subject,
          },
          recipients: {
            create: [
              ...input.preview.skipped.map((skipped) => ({
                deliveryStopId: skipped.deliveryStopId,
                errorCode: skipped.code,
                errorMessage: skipped.message,
                orderId: skipped.orderId,
                recipientEmail: null,
                renderedBody: null,
                renderedSubject: null,
                routePlanId: input.input.routePlanId,
                shopId: input.routePlan.shop.id,
                status: 'SKIPPED',
              })),
              ...input.preview.recipients.map((recipient) => ({
                deliveryStopId: recipient.deliveryStopId,
                orderId: recipient.orderId,
                recipientEmail: recipient.email,
                renderedBody: recipient.rendered.body,
                renderedSubject: recipient.rendered.subject,
                routePlanId: input.input.routePlanId,
                shopId: input.routePlan.shop.id,
                status: 'PENDING',
              })),
            ],
          },
        },
        select: { id: true },
      });
      return { dispatchId: dispatch.id, duplicate: false };
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        const existing = await this.prisma.customerEmailManualDispatch.findUnique({
          select: { id: true },
          where: { shopId_commandId: { commandId: input.commandId, shopId: input.routePlan.shop.id } },
        });
        if (existing !== null) return { dispatchId: existing.id, duplicate: true };
      }
      throw error;
    }
  }

  private async readExistingDispatch(shopId: string, commandId: string, duplicate: boolean): Promise<CustomerEmailDispatch> {
    const dispatch = await this.prisma.customerEmailManualDispatch.findUniqueOrThrow({
      select: {
        id: true,
        commandId: true,
        recipients: {
          orderBy: { createdAt: 'asc' },
          select: {
            deliveryStopId: true,
            errorCode: true,
            errorMessage: true,
            orderId: true,
            provider: true,
            providerMessageId: true,
            recipientEmail: true,
            status: true,
          },
        },
      },
      where: { shopId_commandId: { commandId, shopId } },
    });
    const results = dispatch.recipients.map((recipient) => ({
      deliveryStopId: recipient.deliveryStopId,
      email: recipient.recipientEmail,
      errorCode: recipient.errorCode,
      errorMessage: recipient.errorMessage,
      orderId: recipient.orderId,
      provider: recipient.provider,
      providerMessageId: recipient.providerMessageId,
      status: duplicate ? 'DUPLICATE' as const : toDispatchStatus(recipient.status),
    }));
    return {
      commandId: dispatch.commandId,
      counts: duplicate
        ? { duplicate: results.length, failed: 0, sent: 0, skipped: 0 }
        : countDispatchResults(results),
      dispatchId: dispatch.id,
      duplicate,
      results,
    };
  }

  private async updateRecipient(
    dispatchId: string,
    deliveryStopId: string,
    data: {
      errorCode?: string | null | undefined;
      errorMessage?: string | null | undefined;
      provider?: string | null | undefined;
      providerMessageId?: string | null | undefined;
      sentAt?: Date | null | undefined;
      status: 'FAILED' | 'SENT';
    },
  ): Promise<void> {
    await this.prisma.customerEmailManualDispatchRecipient.updateMany({
      data: compactUpdateData(data),
      where: { deliveryStopId, dispatchId },
    });
  }
}

export class CustomerEmailValidationError extends Error {
  readonly code = 'CUSTOMER_EMAIL_BAD_REQUEST';

  constructor(message: string) {
    super(message);
    this.name = 'CustomerEmailValidationError';
  }
}

export class CustomerEmailNotFoundError extends Error {
  readonly code = 'CUSTOMER_EMAIL_NOT_FOUND';

  constructor() {
    super('Customer email resource not found.');
    this.name = 'CustomerEmailNotFoundError';
  }
}

function buildPreview(
  routePlan: CustomerEmailRoutePlanRow,
  settings: CustomerEmailSettings,
  input: CustomerEmailPreviewInput,
): CustomerEmailPreview {
  const template = settings.templates[input.signal];
  const eligibleStops = selectEligibleStops(routePlan, input.signal, input.deliveryStopIds, settings.nearbyStopsThreshold);
  const recipients: CustomerEmailRenderedRecipient[] = [];
  const skipped: CustomerEmailSkippedRecipient[] = [];
  for (const stop of eligibleStops) {
    const email = stop.deliveryStop.order.email?.trim().toLowerCase() ?? '';
    if (email === '' || !isEmail(email)) {
      skipped.push({
        code: 'CUSTOMER_EMAIL_MISSING',
        deliveryStopId: stop.deliveryStop.id,
        message: 'Canonical order email is missing or invalid.',
        orderId: stop.deliveryStop.order.id,
        orderNumber: stop.deliveryStop.order.name,
        sequence: stop.sequence,
      });
      continue;
    }
    const context = renderContext(routePlan, stop);
    recipients.push({
      deliveryStopId: stop.deliveryStop.id,
      email,
      orderId: stop.deliveryStop.order.id,
      orderNumber: stop.deliveryStop.order.name,
      rendered: {
        body: renderTemplate(template.body, context),
        subject: renderTemplate(template.subject, context),
      },
      sequence: stop.sequence,
    });
  }
  return {
    counts: {
      eligible: eligibleStops.length,
      rendered: recipients.length,
      skipped: skipped.length,
      totalStops: routePlan.routeStops.length,
    },
    recipients,
    skipped,
  };
}

function selectEligibleStops(
  routePlan: CustomerEmailRoutePlanRow,
  signal: CustomerEmailSignal,
  deliveryStopIds: string[] | undefined,
  nearbyStopsThreshold: number,
): CustomerEmailRoutePlanRow['routeStops'] {
  const selected = new Set((deliveryStopIds ?? []).filter(Boolean));
  const stops = selected.size === 0
    ? routePlan.routeStops
    : routePlan.routeStops.filter((stop) => selected.has(stop.deliveryStop.id));
  switch (signal) {
    case 'DELIVERY_SCHEDULED':
      return stops.filter((stop) => ['ASSIGNED', 'PENDING'].includes(stop.deliveryStop.status));
    case 'OUT_FOR_DELIVERY':
      return stops.filter((stop) => ['ARRIVED', 'ASSIGNED', 'EN_ROUTE', 'PENDING'].includes(stop.deliveryStop.status));
    case 'DELIVERED':
      return stops.filter((stop) => stop.deliveryStop.status === 'DELIVERED');
    case 'MISSED_DELIVERY':
      return stops.filter((stop) => stop.deliveryStop.status === 'FAILED');
    case 'DRIVER_NEARBY': {
      const currentSequence = computeCurrentProgressSequence(routePlan.routeStops);
      const targetSequence = currentSequence + nearbyStopsThreshold;
      return stops.filter((stop) =>
        stop.sequence === targetSequence
        && ['ARRIVED', 'ASSIGNED', 'EN_ROUTE', 'PENDING'].includes(stop.deliveryStop.status));
    }
  }
}

function computeCurrentProgressSequence(stops: CustomerEmailRoutePlanRow['routeStops']): number {
  const active = stops.find((stop) => ['ARRIVED', 'EN_ROUTE'].includes(stop.deliveryStop.status));
  if (active !== undefined) return active.sequence;
  const completed = stops
    .filter((stop) => ['CANCELLED', 'DELIVERED', 'FAILED', 'SKIPPED'].includes(stop.deliveryStop.status))
    .map((stop) => stop.sequence);
  return completed.length === 0 ? 0 : Math.max(...completed);
}

function renderContext(routePlan: CustomerEmailRoutePlanRow, stop: CustomerEmailRoutePlanRow['routeStops'][number]): Record<string, string> {
  return {
    customerName: stop.deliveryStop.recipientName ?? 'Customer',
    deliveryAddress: formatAddress(stop.deliveryStop),
    deliveryDate: formatDate(stop.deliveryStop.deliveryDate ?? routePlan.planDate),
    eta: stop.estimatedArrivalAt === null ? 'TBD' : stop.estimatedArrivalAt.toISOString(),
    orderNumber: stop.deliveryStop.order.name,
    routeName: routePlan.name,
    sequence: String(stop.sequence),
    shopName: routePlan.shop.shopDomain,
  };
}

function testTemplateContext(settings: CustomerEmailSettings): Record<string, string> {
  return {
    customerName: 'Customer',
    deliveryAddress: '123 Delivery St',
    deliveryDate: formatDate(new Date()),
    eta: 'TBD',
    orderNumber: '#1001',
    routeName: 'Test route',
    sequence: '1',
    shopName: settings.senderName,
  };
}

function renderTemplate(template: string, context: Record<string, string>): string {
  return template.replace(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/gu, (_match, token: string) => context[token] ?? '');
}

function formatAddress(stop: CustomerEmailRoutePlanRow['routeStops'][number]['deliveryStop']): string {
  return [
    stop.address1,
    stop.address2,
    stop.city,
    stop.province,
    stop.postalCode,
    stop.countryCode,
  ].filter((value): value is string => typeof value === 'string' && value.trim() !== '').join(', ');
}

function formatDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function assertConfigured(settings: CustomerEmailSettings): void {
  if (settings.senderEmail === '') throw new CustomerEmailValidationError('Customer email senderEmail is required.');
}

function countDispatchResults(results: CustomerEmailDispatchResult[]): CustomerEmailDispatch['counts'] {
  return {
    duplicate: results.filter((result) => result.status === 'DUPLICATE').length,
    failed: results.filter((result) => result.status === 'FAILED').length,
    sent: results.filter((result) => result.status === 'SENT').length,
    skipped: results.filter((result) => result.status === 'SKIPPED').length,
  };
}

function toDispatchStatus(value: string): CustomerEmailDispatchResult['status'] {
  if (value === 'SENT' || value === 'FAILED' || value === 'SKIPPED') return value;
  return 'FAILED';
}

function normalizeShopDomain(value: string): string {
  return value.trim().toLowerCase();
}

function shopWhereInput(input: { appId?: string | undefined; shopDomain: string }): { appId: string; shopDomain: string } {
  return {
    appId: input.appId ?? DEFAULT_SHOPIFY_APP_ID,
    shopDomain: normalizeShopDomain(input.shopDomain),
  };
}

function compactUpdateData(input: {
  errorCode?: string | null | undefined;
  errorMessage?: string | null | undefined;
  provider?: string | null | undefined;
  providerMessageId?: string | null | undefined;
  sentAt?: Date | null | undefined;
  status: 'FAILED' | 'SENT';
}): Prisma.CustomerEmailManualDispatchRecipientUpdateManyMutationInput {
  return {
    ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
    ...(input.errorMessage === undefined ? {} : { errorMessage: input.errorMessage }),
    ...(input.provider === undefined ? {} : { provider: input.provider }),
    ...(input.providerMessageId === undefined ? {} : { providerMessageId: input.providerMessageId }),
    ...(input.sentAt === undefined ? {} : { sentAt: input.sentAt }),
    status: input.status,
  };
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

function cryptoRandomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

export function readCustomerEmailSettingsPayload(value: unknown): CustomerEmailSettings | null {
  try {
    return validateCustomerEmailSettingsPayload(value);
  } catch {
    return null;
  }
}

export function readCustomerEmailCommandPayload(value: unknown): {
  commandId?: string | undefined;
  confirmed?: boolean | undefined;
  deliveryStopIds?: string[] | undefined;
  signal: CustomerEmailSignal;
} | null {
  if (!isRecord(value)) return null;
  const signal = readCustomerEmailSignal(value.signal);
  if (signal === null) return null;
  const deliveryStopIds = value.deliveryStopIds;
  if (deliveryStopIds !== undefined && (!Array.isArray(deliveryStopIds) || !deliveryStopIds.every((id) => typeof id === 'string'))) {
    return null;
  }
  return {
    ...(typeof value.commandId === 'string' ? { commandId: value.commandId } : {}),
    ...(typeof value.confirmed === 'boolean' ? { confirmed: value.confirmed } : {}),
    ...(Array.isArray(deliveryStopIds) ? { deliveryStopIds } : {}),
    signal,
  };
}

export function readCustomerEmailTestPayload(value: unknown): {
  body?: string | undefined;
  recipientEmail: string;
  signal?: CustomerEmailSignal | undefined;
  subject?: string | undefined;
} | null {
  if (!isRecord(value) || typeof value.recipientEmail !== 'string') return null;
  const signal = value.signal === undefined ? undefined : readCustomerEmailSignal(value.signal);
  if (value.signal !== undefined && signal === null) return null;
  return {
    ...(typeof value.body === 'string' ? { body: value.body } : {}),
    recipientEmail: value.recipientEmail,
    ...(signal === undefined || signal === null ? {} : { signal }),
    ...(typeof value.subject === 'string' ? { subject: value.subject } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export { customerEmailSignals, defaultCustomerEmailSettings };
