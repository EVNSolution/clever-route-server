import type { Prisma, PrismaClient } from '@prisma/client';

import {
  customerEmailSignals,
  defaultCustomerEmailSettings,
  isEmail,
  normalizeCustomerEmailSettings,
  readCustomerEmailSignal,
  validateCustomerEmailSettingsPayload,
  type CustomerEmailBranding,
  type CustomerEmailSettings,
  type CustomerEmailSignal,
} from './customer-email-settings.js';
import {
  CustomerEmailTransportConfigurationError,
  CustomerEmailTransportSendError,
  type CustomerEmailTransport,
} from './customer-email-transport.js';
import { normalizeRouteOpsUiSettings } from '../route-ops/route-ops-ui-settings.js';
import { DEFAULT_SHOPIFY_APP_ID, appScopedShopWhere } from '../shopify/shopify-app-scope.js';
import type { PrismaCustomerDeliveryNotificationAttemptRepository } from './customer-delivery-notification-attempt.repository.js';

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
  missingValuesConfirmed?: boolean | undefined;
  resendConfirmed?: boolean | undefined;
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
  diagnostics: {
    body: CustomerEmailRenderDiagnostic[];
    subject: CustomerEmailRenderDiagnostic[];
  };
  deliveryStopId: string;
  email: string;
  orderId: string;
  orderNumber: string;
  history: CustomerEmailManualHistorySummary;
  rendered: {
    body: string;
    subject: string;
  };
  sequence: number;
};

export type CustomerEmailRenderDiagnostic = {
  code: 'MISSING_TEMPLATE_VALUE';
  key: string;
};

export type CustomerEmailManualHistorySummary = {
  lastSentAt: string | null;
  lastStatus: string | null;
  sendCount: number;
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
        deliveryFacts: Array<{
          deliveryWeekday: string | null;
        }>;
        email: string | null;
        id: string;
        name: string;
        orderItems: Array<{
          lineIndex: number;
          name: string;
          options: unknown;
          quantity: number;
        }>;
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
    routeOpsUiSettings: unknown;
    shopDomain: string;
  };
};

export class CustomerEmailService {
  constructor(
    private readonly prisma: CustomerEmailPrismaClient,
    private readonly transport: CustomerEmailTransport,
    private readonly attempts?: PrismaCustomerDeliveryNotificationAttemptRepository,
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
    if (isRecord(input.payload) && input.payload.version === 3) {
      throw new CustomerEmailValidationError('Customer email V3 full settings writes are not allowed. Use scoped global or template settings endpoints.');
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

  async saveGlobalSettings(input: {
    appId?: string | undefined;
    payload: unknown;
    shopDomain: string;
  }): Promise<CustomerEmailSettings | null> {
    const payload = readCustomerEmailGlobalSettingsPayload(input.payload);
    if (payload === null) throw new CustomerEmailValidationError('Invalid customer email global settings payload.');
    const shop = await this.prisma.shop.findUnique({
      select: { customerEmailSettings: true, id: true, updatedAt: true },
      where: appScopedShopWhere({ appId: input.appId, shopDomain: normalizeShopDomain(input.shopDomain) }),
    });
    if (shop === null) return null;
    const current = normalizeCustomerEmailSettings(shop.customerEmailSettings);
    if (payload.expectedVersion !== current.globalVersion) {
      throw new CustomerEmailVersionConflictError('SETTINGS_VERSION_CONFLICT', 'Customer email global settings version conflict.');
    }
    const next = validateCustomerEmailSettingsPayload({
      ...current,
      branding: {
        ...current.branding,
        ...payload.branding,
      },
      globalVersion: current.globalVersion + 1,
      replyTo: payload.replyTo,
      senderEmail: payload.senderEmail,
      senderName: payload.senderName,
    });
    const updateResult = await this.prisma.shop.updateMany({
      data: { customerEmailSettings: next },
      where: { id: shop.id, updatedAt: shop.updatedAt },
    });
    if (updateResult.count === 0) {
      throw new CustomerEmailVersionConflictError('SETTINGS_VERSION_CONFLICT', 'Customer email global settings version conflict.');
    }
    return next;
  }

  async saveTemplateSettings(input: {
    appId?: string | undefined;
    payload: unknown;
    shopDomain: string;
    signal: CustomerEmailSignal;
  }): Promise<CustomerEmailSettings | null> {
    const payload = readCustomerEmailTemplateSettingsPayload(input.payload);
    if (payload === null) throw new CustomerEmailValidationError('Invalid customer email template settings payload.');
    const shop = await this.prisma.shop.findUnique({
      select: { customerEmailSettings: true, id: true, updatedAt: true },
      where: appScopedShopWhere({ appId: input.appId, shopDomain: normalizeShopDomain(input.shopDomain) }),
    });
    if (shop === null) return null;
    const current = normalizeCustomerEmailSettings(shop.customerEmailSettings);
    const currentTemplate = current.templates[input.signal];
    if (payload.expectedVersion !== currentTemplate.version) {
      throw new CustomerEmailVersionConflictError('TEMPLATE_VERSION_CONFLICT', 'Customer email template version conflict.');
    }
    const next = validateCustomerEmailSettingsPayload({
      ...current,
      templates: {
        ...current.templates,
        [input.signal]: {
          body: payload.body,
          enabled: payload.enabled,
          subject: payload.subject,
          version: currentTemplate.version + 1,
        },
      },
    });
    const updateResult = await this.prisma.shop.updateMany({
      data: { customerEmailSettings: next },
      where: { id: shop.id, updatedAt: shop.updatedAt },
    });
    if (updateResult.count === 0) {
      throw new CustomerEmailVersionConflictError('TEMPLATE_VERSION_CONFLICT', 'Customer email template version conflict.');
    }
    return next;
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
    const testContext = testTemplateContext(settings);
    const result = await this.transport.send({
      branding: settings.branding,
      body: input.body?.trim() || renderTemplate(template.body, testContext).value,
      commandId: `test:${cryptoRandomId()}`,
      recipientEmail: input.recipientEmail.trim().toLowerCase(),
      replyTo: settings.replyTo,
      senderEmail: settings.senderEmail,
      senderName: settings.senderName,
      signal: 'TEST',
      subject: input.subject?.trim() || renderTemplate(template.subject, testContext).value,
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
    const eligibleStopIds = selectEligibleStops(routePlan, input.signal, input.deliveryStopIds, routeOpsNearbyStopsThreshold(routePlan))
      .map((stop) => stop.deliveryStop.id);
    const history = await this.readManualHistory(routePlan.shop.id, input.routePlanId, input.signal, eligibleStopIds);
    return buildPreview(routePlan, settings, input, history);
  }

  async send(input: CustomerEmailSendInput): Promise<CustomerEmailDispatch | null> {
    if (!input.confirmed) throw new CustomerEmailValidationError('Manual customer email send must be confirmed.');
    if (input.commandId.trim() === '') throw new CustomerEmailValidationError('commandId is required.');

    const routePlan = await this.findRoutePlan(input);
    if (routePlan === null) return null;
    const settings = normalizeCustomerEmailSettings(routePlan.shop.customerEmailSettings);
    assertConfigured(settings);
    const eligibleStopIds = selectEligibleStops(routePlan, input.signal, input.deliveryStopIds, routeOpsNearbyStopsThreshold(routePlan))
      .map((stop) => stop.deliveryStop.id);
    const history = await this.readManualHistory(routePlan.shop.id, input.routePlanId, input.signal, eligibleStopIds);
    const preview = buildPreview(routePlan, settings, input, history);
    const template = settings.templates[input.signal];
    if (!template.enabled) throw new CustomerEmailValidationError('Selected customer email template is disabled.');
    if (previewHasMissingTemplateValues(preview) && input.missingValuesConfirmed !== true) {
      throw new CustomerEmailValidationError(
        'Missing customer email template values must be confirmed before sending.',
        'MISSING_TEMPLATE_VALUES_CONFIRMATION_REQUIRED',
      );
    }
    if (previewHasPriorSent(preview) && input.resendConfirmed !== true) {
      throw new CustomerEmailValidationError(
        'Prior customer email send must be confirmed before resending.',
        'RESEND_CONFIRMATION_REQUIRED',
      );
    }

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
      const startedAt = new Date();
      const attempt = this.attempts === undefined
        ? undefined
        : await this.prisma.customerEmailManualDispatchRecipient.findFirstOrThrow({
            select: { id: true },
            where: { deliveryStopId: recipient.deliveryStopId, dispatchId: created.dispatchId }
          }).then(({ id }) => this.attempts!.startManual({
            manualDispatchRecipientId: id,
            provider: this.transport.providerName,
            shopId: routePlan.shop.id,
            startedAt
          }));
      let sendResult: Awaited<ReturnType<CustomerEmailTransport['send']>>;
      try {
        sendResult = await this.transport.send({
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
        if (attempt !== undefined) await this.attempts?.settle({
          attemptId: attempt.attemptId,
          completedAt: new Date(),
          errorCode,
          outcome: 'TERMINAL_FAILURE'
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
        continue;
      }

      await this.updateRecipient(created.dispatchId, recipient.deliveryStopId, {
        provider: sendResult.provider,
        providerMessageId: sendResult.providerMessageId,
        sentAt: new Date(),
        status: 'SENT',
      });
      if (attempt !== undefined) {
        try {
          await this.attempts?.settle({
            attemptId: attempt.attemptId,
            completedAt: new Date(),
            outcome: 'SENT',
            providerMessageId: sendResult.providerMessageId
          });
        } catch {
          // The durable STARTED attempt is deliberately retained for reconciliation.
          // Provider success and the authoritative recipient SENT state must never regress.
        }
      }
      results.push({
        deliveryStopId: recipient.deliveryStopId,
        email: recipient.email,
        errorCode: null,
        errorMessage: null,
        orderId: recipient.orderId,
        provider: sendResult.provider,
        providerMessageId: sendResult.providerMessageId,
        status: 'SENT',
      });
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
                order: {
                  select: {
                    deliveryFacts: {
                      orderBy: { computedAt: 'desc' },
                      select: { deliveryWeekday: true },
                      take: 1,
                    },
                    email: true,
                    id: true,
                    name: true,
                    orderItems: {
                      orderBy: { lineIndex: 'asc' },
                      select: {
                        lineIndex: true,
                        name: true,
                        options: true,
                        quantity: true,
                      },
                    },
                  },
                },
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
        shop: { select: { customerEmailSettings: true, id: true, routeOpsUiSettings: true, shopDomain: true } },
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

  private async readManualHistory(
    shopId: string,
    routePlanId: string,
    signal: CustomerEmailSignal,
    deliveryStopIds: string[],
  ): Promise<Map<string, CustomerEmailManualHistorySummary>> {
    if (deliveryStopIds.length === 0) return new Map();
    const rows = await this.prisma.customerEmailManualDispatchRecipient.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        createdAt: true,
        deliveryStopId: true,
        sentAt: true,
        status: true,
      },
      where: {
        deliveryStopId: { in: deliveryStopIds },
        dispatch: { signal },
        routePlanId,
        shopId,
      },
    });
    const summaries = new Map<string, CustomerEmailManualHistorySummary>();
    for (const row of rows) {
      if (row.deliveryStopId === null) continue;
      const current = summaries.get(row.deliveryStopId);
      if (current === undefined) {
        summaries.set(row.deliveryStopId, {
          lastSentAt: row.status === 'SENT' ? row.sentAt?.toISOString() ?? null : null,
          lastStatus: row.status,
          sendCount: row.status === 'SENT' ? 1 : 0,
        });
      } else if (row.status === 'SENT') {
        current.sendCount += 1;
        if (current.lastSentAt === null) current.lastSentAt = row.sentAt?.toISOString() ?? null;
      }
    }
    return summaries;
  }
}

export class CustomerEmailValidationError extends Error {
  readonly code: 'CUSTOMER_EMAIL_BAD_REQUEST' | 'MISSING_TEMPLATE_VALUES_CONFIRMATION_REQUIRED' | 'RESEND_CONFIRMATION_REQUIRED';

  constructor(
    message: string,
    code: 'CUSTOMER_EMAIL_BAD_REQUEST' | 'MISSING_TEMPLATE_VALUES_CONFIRMATION_REQUIRED' | 'RESEND_CONFIRMATION_REQUIRED' = 'CUSTOMER_EMAIL_BAD_REQUEST',
  ) {
    super(message);
    this.code = code;
    this.name = 'CustomerEmailValidationError';
  }
}

export class CustomerEmailVersionConflictError extends Error {
  constructor(readonly code: 'SETTINGS_VERSION_CONFLICT' | 'TEMPLATE_VERSION_CONFLICT', message: string) {
    super(message);
    this.name = 'CustomerEmailVersionConflictError';
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
  history: Map<string, CustomerEmailManualHistorySummary> = new Map(),
): CustomerEmailPreview {
  const template = settings.templates[input.signal];
  const eligibleStops = selectEligibleStops(routePlan, input.signal, input.deliveryStopIds, routeOpsNearbyStopsThreshold(routePlan));
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
    const renderedBody = renderTemplate(template.body, context);
    const renderedSubject = renderTemplate(template.subject, context);
    recipients.push({
      diagnostics: {
        body: renderedBody.diagnostics,
        subject: renderedSubject.diagnostics,
      },
      deliveryStopId: stop.deliveryStop.id,
      email,
      history: history.get(stop.deliveryStop.id) ?? emptyManualHistorySummary(),
      orderId: stop.deliveryStop.order.id,
      orderNumber: stop.deliveryStop.order.name,
      rendered: {
        body: renderedBody.value,
        subject: renderedSubject.value,
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

function routeOpsNearbyStopsThreshold(routePlan: CustomerEmailRoutePlanRow): number {
  return normalizeRouteOpsUiSettings(routePlan.shop.routeOpsUiSettings).nearbyStopsThreshold;
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
    customerName: stop.deliveryStop.recipientName ?? '',
    deliveryAddress: formatAddress(stop.deliveryStop),
    deliveryDate: formatDate(stop.deliveryStop.deliveryDate ?? routePlan.planDate),
    deliveryWeekday: stop.deliveryStop.order.deliveryFacts[0]?.deliveryWeekday ?? '',
    eta: stop.estimatedArrivalAt === null ? '' : stop.estimatedArrivalAt.toISOString(),
    inventoryList: formatInventoryList(stop.deliveryStop.order.orderItems),
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
    deliveryWeekday: '',
    eta: 'TBD',
    inventoryList: '',
    orderNumber: '#1001',
    routeName: 'Test route',
    sequence: '1',
    shopName: settings.senderName,
  };
}

function renderTemplate(template: string, context: Record<string, string>): { diagnostics: CustomerEmailRenderDiagnostic[]; value: string } {
  const diagnostics: CustomerEmailRenderDiagnostic[] = [];
  const missingKeys = new Set<string>();
  const value = template.replace(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/gu, (_match, token: string) => {
    const rendered = context[token] ?? '';
    if (rendered === '' && !missingKeys.has(token)) {
      missingKeys.add(token);
      diagnostics.push({ code: 'MISSING_TEMPLATE_VALUE', key: token });
    }
    return rendered;
  });
  return { diagnostics, value };
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

function formatInventoryList(items: CustomerEmailRoutePlanRow['routeStops'][number]['deliveryStop']['order']['orderItems']): string {
  return items.map((item) => {
    const options = formatItemOptions(item.options);
    const name = options === '' ? item.name : `${item.name} (${options})`;
    return `${item.quantity} x ${name}`;
  }).join('\n');
}

function formatItemOptions(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value.map((option) => {
    if (typeof option === 'string') return option.trim();
    if (option !== null && typeof option === 'object') {
      const record = option as Record<string, unknown>;
      const name = typeof record.name === 'string' ? record.name.trim() : '';
      const optionValue = typeof record.value === 'string' ? record.value.trim() : '';
      if (name !== '' && optionValue !== '') return `${name}: ${optionValue}`;
      if (optionValue !== '') return optionValue;
      if (name !== '') return name;
    }
    return '';
  }).filter((option) => option !== '').join(', ');
}

function formatDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function assertConfigured(settings: CustomerEmailSettings): void {
  if (settings.senderEmail === '') throw new CustomerEmailValidationError('Customer email senderEmail is required.');
}

function previewHasMissingTemplateValues(preview: CustomerEmailPreview): boolean {
  return preview.recipients.some((recipient) =>
    recipient.diagnostics.body.length > 0 || recipient.diagnostics.subject.length > 0);
}

function previewHasPriorSent(preview: CustomerEmailPreview): boolean {
  return preview.recipients.some((recipient) => recipient.history.lastStatus === 'SENT' || recipient.history.sendCount > 0);
}

function emptyManualHistorySummary(): CustomerEmailManualHistorySummary {
  return { lastSentAt: null, lastStatus: null, sendCount: 0 };
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

export function readCustomerEmailGlobalSettingsPayload(value: unknown): {
  branding: Partial<CustomerEmailBranding>;
  expectedVersion: number;
  replyTo: string | null;
  senderEmail: string;
  senderName: string;
} | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['branding', 'expectedVersion', 'replyTo', 'senderEmail', 'senderName'])) return null;
  if (typeof value.expectedVersion !== 'number' || !Number.isInteger(value.expectedVersion)) return null;
  if (!isRecord(value.branding)) return null;
  try {
    const current = defaultCustomerEmailSettings();
    const settings = validateCustomerEmailSettingsPayload({
      ...current,
      replyTo: value.replyTo,
      senderEmail: value.senderEmail,
      senderName: value.senderName,
    });
    return {
      branding: value.branding,
      expectedVersion: value.expectedVersion,
      replyTo: settings.replyTo,
      senderEmail: settings.senderEmail,
      senderName: settings.senderName,
    };
  } catch {
    return null;
  }
}

export function readCustomerEmailTemplateSettingsPayload(value: unknown): {
  body: string;
  enabled: boolean;
  expectedVersion: number;
  subject: string;
} | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['body', 'enabled', 'expectedVersion', 'subject'])) return null;
  if (typeof value.expectedVersion !== 'number' || !Number.isInteger(value.expectedVersion)) return null;
  try {
    const current = defaultCustomerEmailSettings();
    const settings = validateCustomerEmailSettingsPayload({
      ...current,
      templates: {
        ...current.templates,
        DELIVERY_SCHEDULED: {
          body: value.body,
          enabled: value.enabled,
          subject: value.subject,
          version: current.templates.DELIVERY_SCHEDULED.version,
        },
      },
    });
    const template = settings.templates.DELIVERY_SCHEDULED;
    return {
      body: template.body,
      enabled: template.enabled,
      expectedVersion: value.expectedVersion,
      subject: template.subject,
    };
  } catch {
    return null;
  }
}

export function readCustomerEmailCommandPayload(value: unknown): {
  commandId?: string | undefined;
  confirmed?: boolean | undefined;
  deliveryStopIds?: string[] | undefined;
  missingValuesConfirmed?: boolean | undefined;
  resendConfirmed?: boolean | undefined;
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
    ...(typeof value.missingValuesConfirmed === 'boolean' ? { missingValuesConfirmed: value.missingValuesConfirmed } : {}),
    ...(typeof value.resendConfirmed === 'boolean' ? { resendConfirmed: value.resendConfirmed } : {}),
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
  if (typeof value.subject === 'string' && value.subject.length > 200) return null;
  if (typeof value.body === 'string' && value.body.length > 10_000) return null;
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

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key)) && allowedKeys.every((key) => key in value);
}

export { customerEmailSignals, defaultCustomerEmailSettings };
