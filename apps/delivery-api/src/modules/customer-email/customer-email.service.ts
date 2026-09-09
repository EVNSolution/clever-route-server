import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';

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
import { isIanaTimezone } from '../driver/driver-route-timezone.js';

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
  previewToken?: string | undefined;
  resendConfirmed?: boolean | undefined;
};

export type CustomerEmailPreview = {
  counts: {
    eligible: number;
    missingEmail: number;
    rendered: number;
    selected: number;
    sendable: number;
    skipped: number;
    statusExcluded: number;
    totalStops: number;
  };
  example: {
    diagnostics: {
      body: CustomerEmailRenderDiagnostic[];
      subject: CustomerEmailRenderDiagnostic[];
    };
    rendered: {
      body: string;
      subject: string;
    };
  };
  exclusions: CustomerEmailStatusExclusion[];
  previewToken: string;
  recipients: CustomerEmailRenderedRecipient[];
  routeStatus: string;
  skipped: CustomerEmailSkippedRecipient[];
};

export type CustomerEmailStatusExclusion = {
  code: 'ROUTE_ALREADY_COMPLETED' | 'STOP_STATUS_INELIGIBLE';
  count: number;
  message: string;
  status: string;
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

export type CustomerEmailAutomaticSendResult =
  | { errorCode: string; errorMessage: string; status: 'SKIPPED' }
  | { provider: string; providerMessageId: string | null; status: 'SENT' };

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
  lastProviderEventAt: string | null;
  lastProviderStatus: string | null;
  lastSentAt: string | null;
  lastStatus: string | null;
  sendCount: number;
  uncertainCount: number;
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
  originalStatus?: 'FAILED' | 'PENDING' | 'SENT' | 'SKIPPED' | 'UNKNOWN';
  providerStatus?: string | null;
  providerEventAt?: string | null;
  sentAt?: string | null;
  status: 'DUPLICATE' | 'FAILED' | 'SENT' | 'SKIPPED' | 'UNKNOWN' | 'PENDING';
};

type CustomerEmailPrismaClient = Pick<
  PrismaClient,
  '$transaction' | 'customerEmailManualDispatch' | 'customerEmailManualDispatchRecipient' | 'routePlan' | 'shop'
>;

type CustomerEmailRoutePlanRow = {
  constraints: unknown;
  id: string;
  name: string;
  planDate: Date;
  status: string;
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
    commerceConnections: Array<{ timezone: string | null }>;
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
    const shop = await this.prisma.shop.findUnique({
      select: { customerEmailSettings: true, id: true, updatedAt: true },
      where: appScopedShopWhere({ appId: input.appId, shopDomain: normalizeShopDomain(input.shopDomain) }),
    });
    if (shop === null) return null;
    const current = normalizeCustomerEmailSettings(shop.customerEmailSettings);
    assertCompanySender(input.payload, current.senderEmail);
    const settings = normalizeCustomerEmailSettings({ ...input.payload, senderEmail: current.senderEmail });
    const updateResult = await this.prisma.shop.updateMany({
      data: { customerEmailSettings: settings },
      where: { id: shop.id, updatedAt: shop.updatedAt },
    });
    if (updateResult.count === 0) {
      throw new CustomerEmailVersionConflictError('SETTINGS_VERSION_CONFLICT', 'Customer email settings version conflict.');
    }
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
    assertCompanySender(payload, current.senderEmail);
    const next = validateCustomerEmailSettingsPayload({
      ...current,
      branding: {
        ...current.branding,
        ...payload.branding,
      },
      globalVersion: current.globalVersion + 1,
      replyTo: payload.replyTo,
      senderEmail: current.senderEmail,
      senderName: payload.senderName,
    }, { allowAutomaticEnabled: true });
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
    }, { allowAutomaticEnabled: true });
    const updateResult = await this.prisma.shop.updateMany({
      data: { customerEmailSettings: next },
      where: { id: shop.id, updatedAt: shop.updatedAt },
    });
    if (updateResult.count === 0) {
      throw new CustomerEmailVersionConflictError('TEMPLATE_VERSION_CONFLICT', 'Customer email template version conflict.');
    }
    return next;
  }

  async setAutomaticActivation(input: {
    acceptedBy: string;
    confirmed: boolean;
    enabled: boolean;
    noticeVersion?: string | undefined;
    shopDomain: string;
    appId?: string | undefined;
  }): Promise<CustomerEmailSettings['automatic'] | null> {
    if (input.enabled && !input.confirmed) {
      throw new CustomerEmailValidationError('Automatic customer email activation must be confirmed.');
    }
    const noticeVersion = input.noticeVersion?.trim() || 'customer-email-automatic-v1';
    const shop = await this.prisma.shop.findUnique({
      select: { customerEmailSettings: true, id: true, updatedAt: true },
      where: appScopedShopWhere({ appId: input.appId, shopDomain: normalizeShopDomain(input.shopDomain) })
    });
    if (shop === null) return null;
    const current = normalizeCustomerEmailSettings(shop.customerEmailSettings);
    const next = validateCustomerEmailSettingsPayload({
      ...current,
      automatic: input.enabled
        ? {
            consent: {
              acceptedAt: new Date().toISOString(),
              acceptedBy: input.acceptedBy,
              noticeVersion,
              settingsVersion: automaticSettingsVersion(current)
            },
            enabled: true
          }
        : { ...current.automatic, enabled: false }
    }, { allowAutomaticEnabled: true });
    const updateResult = await this.prisma.shop.updateMany({
      data: { customerEmailSettings: next },
      where: { id: shop.id, updatedAt: shop.updatedAt }
    });
    if (updateResult.count === 0) {
      throw new CustomerEmailVersionConflictError('SETTINGS_VERSION_CONFLICT', 'Customer email activation version conflict.');
    }
    return next.automatic;
  }

  async sendTest(input: {
    appId?: string | undefined;
    body?: string | undefined;
    confirmed: boolean;
    recipientEmail: string;
    shopDomain: string;
    signal?: CustomerEmailSignal | undefined;
    subject?: string | undefined;
  }): Promise<{ messageId: string | null; provider: string; recipientEmail: string; sentAt: string }> {
    if (input.confirmed !== true) {
      throw new CustomerEmailValidationError('Test customer email send must be confirmed.', 'CUSTOMER_EMAIL_TEST_CONFIRMATION_REQUIRED');
    }
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
    const history = await this.readManualHistory(routePlan.shop.id, input.signal, eligibleStopIds);
    return buildPreview(routePlan, settings, input, history);
  }

  async sendAutomatic(input: CustomerEmailPreviewInput & {
    idempotencyKey: string;
    recipientEmail: string;
  }): Promise<CustomerEmailAutomaticSendResult> {
    const routePlan = await this.findRoutePlan(input);
    if (routePlan === null) {
      return { errorCode: 'CUSTOMER_EMAIL_ROUTE_NOT_FOUND', errorMessage: 'Route plan is unavailable.', status: 'SKIPPED' };
    }
    const settings = normalizeCustomerEmailSettings(routePlan.shop.customerEmailSettings);
    if (!settings.automatic.enabled) {
      return { errorCode: 'CUSTOMER_EMAIL_AUTOMATIC_INACTIVE', errorMessage: 'Automatic customer email is inactive.', status: 'SKIPPED' };
    }
    const template = settings.templates[input.signal];
    if (!template.enabled) {
      return { errorCode: 'CUSTOMER_EMAIL_TEMPLATE_DISABLED', errorMessage: 'Automatic customer email template is disabled.', status: 'SKIPPED' };
    }
    const selectedStopId = input.deliveryStopIds?.[0];
    const stop = routePlan.routeStops.find((candidate) => candidate.deliveryStop.id === selectedStopId);
    if (stop === undefined) {
      return { errorCode: 'CUSTOMER_EMAIL_STOP_NOT_FOUND', errorMessage: 'Delivery stop is unavailable.', status: 'SKIPPED' };
    }
    const recipientEmail = input.recipientEmail.trim().toLowerCase();
    if (!isEmail(recipientEmail)) {
      return { errorCode: 'CUSTOMER_EMAIL_MISSING', errorMessage: 'Canonical order email is missing or invalid.', status: 'SKIPPED' };
    }
    try {
      assertConfigured(settings);
    } catch (error) {
      return {
        errorCode: 'CUSTOMER_EMAIL_SENDER_MISSING',
        errorMessage: error instanceof Error ? error.message : 'Customer email sender is not configured.',
        status: 'SKIPPED'
      };
    }
    const context = renderContext(routePlan, stop);
    const result = await this.transport.send({
      branding: settings.branding,
      body: renderTemplate(template.body, context).value,
      commandId: input.idempotencyKey,
      recipientEmail,
      replyTo: settings.replyTo,
      senderEmail: settings.senderEmail,
      senderName: settings.senderName,
      signal: input.signal,
      subject: renderTemplate(template.subject, context).value,
      tags: ['customer-delivery-email', 'automatic', input.signal.toLowerCase()]
    });
    return { provider: result.provider, providerMessageId: result.providerMessageId, status: 'SENT' };
  }

  async send(input: CustomerEmailSendInput): Promise<CustomerEmailDispatch | null> {
    if (!input.confirmed) throw new CustomerEmailValidationError('Manual customer email send must be confirmed.');
    if (input.commandId.trim() === '') throw new CustomerEmailValidationError('commandId is required.');

    const routePlan = await this.findRoutePlan(input);
    if (routePlan === null) return null;
    const existing = await this.prisma.customerEmailManualDispatch.findUnique({
      select: { id: true, request: true, routePlanId: true, signal: true },
      where: { shopId_commandId: { commandId: input.commandId, shopId: routePlan.shop.id } },
    });
    if (existing !== null) {
      assertCommandMatchesDispatch(existing, input);
      return this.readExistingDispatch(routePlan.shop.id, input.commandId, true);
    }
    const settings = normalizeCustomerEmailSettings(routePlan.shop.customerEmailSettings);
    assertConfigured(settings);
    const eligibleStopIds = selectEligibleStops(routePlan, input.signal, input.deliveryStopIds, routeOpsNearbyStopsThreshold(routePlan))
      .map((stop) => stop.deliveryStop.id);
    const history = await this.readManualHistory(routePlan.shop.id, input.signal, eligibleStopIds);
    const preview = buildPreview(routePlan, settings, input, history);
    if (input.previewToken !== undefined && input.previewToken !== preview.previewToken) {
      throw new CustomerEmailValidationError(
        'Customer email preview is stale or does not match this send request.',
        'CUSTOMER_EMAIL_PREVIEW_CONFLICT',
      );
    }
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
    if (previewHasUncertainOutcome(preview)) {
      throw new CustomerEmailValidationError(
        'A prior customer email outcome is still pending or unknown. Reconcile it before sending again.',
        'CUSTOMER_EMAIL_OUTCOME_UNCERTAIN',
      );
    }

    const created = await this.createDispatch({
      actor: input.actor,
      commandId: input.commandId,
      input,
      preview,
      routePlan,
      settings,
    });
    if (created.duplicate) {
      const competing = await this.prisma.customerEmailManualDispatch.findUniqueOrThrow({
        select: { request: true, routePlanId: true, signal: true },
        where: { shopId_commandId: { commandId: input.commandId, shopId: routePlan.shop.id } },
      });
      assertCommandMatchesDispatch(competing, input);
      return this.readExistingDispatch(routePlan.shop.id, input.commandId, true);
    }
    const sendPreview = created.preview;
    const sendRoutePlan = created.routePlan;
    const sendSettings = created.settings;

    const results: CustomerEmailDispatchResult[] = [];
    for (const skipped of sendPreview.skipped) {
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

    for (const recipient of sendPreview.recipients) {
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
            shopId: sendRoutePlan.shop.id,
            startedAt
          }));
      let sendResult: Awaited<ReturnType<CustomerEmailTransport['send']>>;
      try {
        sendResult = await this.transport.send({
          branding: sendSettings.branding,
          body: recipient.rendered.body,
          commandId: rowCommandId,
          recipientEmail: recipient.email,
          replyTo: sendSettings.replyTo,
          senderEmail: sendSettings.senderEmail,
          senderName: sendSettings.senderName,
          signal: input.signal,
          subject: recipient.rendered.subject,
          tags: [
            'customer-delivery-email',
            input.signal.toLowerCase(),
            ...(attempt === undefined ? [] : [`customer-email-correlation:${attempt.correlationId}`]),
          ],
        });
      } catch (error) {
        const status = error instanceof CustomerEmailTransportConfigurationError || error instanceof CustomerEmailTransportSendError
          ? 'FAILED' : 'UNKNOWN';
        const errorCode = error instanceof CustomerEmailTransportConfigurationError
          ? 'CUSTOMER_EMAIL_NOT_CONFIGURED'
          : error instanceof CustomerEmailTransportSendError
            ? 'CUSTOMER_EMAIL_SEND_FAILED'
            : 'CUSTOMER_EMAIL_OUTCOME_UNKNOWN';
        const errorMessage = error instanceof Error ? error.message : 'Customer email send failed.';
        await this.updateRecipient(created.dispatchId, recipient.deliveryStopId, {
          errorCode,
          errorMessage,
          status,
        });
        if (attempt !== undefined && status === 'FAILED') {
          try {
            await this.attempts?.settle({
              attemptId: attempt.attemptId,
              completedAt: new Date(),
              errorCode,
              outcome: 'TERMINAL_FAILURE'
            });
          } catch {
            // Keep the authoritative recipient result; reconcile the STARTED attempt later.
          }
        }
        results.push({
          deliveryStopId: recipient.deliveryStopId,
          email: recipient.email,
          errorCode,
          errorMessage,
          orderId: recipient.orderId,
          provider: null,
          providerMessageId: null,
          status,
        });
        continue;
      }

      const sentAt = new Date();
      let attemptSettlementError: unknown;
      if (attempt !== undefined) {
        try {
          await this.attempts?.settle({
            attemptId: attempt.attemptId,
            completedAt: sentAt,
            outcome: 'SENT',
            providerMessageId: sendResult.providerMessageId
          });
        } catch (error) {
          attemptSettlementError = error;
        }
      }
      try {
        await this.updateRecipient(created.dispatchId, recipient.deliveryStopId, {
          provider: sendResult.provider,
          providerMessageId: sendResult.providerMessageId,
          sentAt,
          status: 'SENT',
        });
        await this.recordAcceptedProviderEvidence(
          created.dispatchId,
          recipient.deliveryStopId,
          sentAt,
          sendResult.providerMessageId,
        );
      } catch (error) {
        if (attemptSettlementError !== undefined) {
          throw new AggregateError(
            [attemptSettlementError, error],
            'Customer email provider success evidence was not saved.',
            { cause: error },
          );
        }
        throw error;
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

  private async findRoutePlan(
    input: CustomerEmailPreviewInput,
    client: Pick<Prisma.TransactionClient, 'routePlan'> = this.prisma,
  ): Promise<CustomerEmailRoutePlanRow | null> {
    const routePlan = await client.routePlan.findFirst({
      select: {
        constraints: true,
        id: true,
        name: true,
        planDate: true,
        status: true,
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
        shop: {
          select: {
            commerceConnections: { select: { timezone: true }, where: { status: 'ACTIVE' } },
            customerEmailSettings: true,
            id: true,
            routeOpsUiSettings: true,
            shopDomain: true,
          },
        },
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
  }): Promise<{
    dispatchId: string;
    duplicate: boolean;
    preview: CustomerEmailPreview;
    routePlan: CustomerEmailRoutePlanRow;
    settings: CustomerEmailSettings;
  }> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const lockRoutePlan = await this.findRoutePlan(input.input, tx);
        if (lockRoutePlan === null) throw new CustomerEmailNotFoundError();
        const lockedStopIds = selectedStopIds(lockRoutePlan, input.input.deliveryStopIds);
        const lockKeys = lockedStopIds.map(
          (deliveryStopId) => `customer-email:${lockRoutePlan.shop.id}:${input.input.signal}:${deliveryStopId}`,
        );
        for (const key of lockKeys) {
          await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
        }
        const existing = await tx.customerEmailManualDispatch.findUnique({
          select: { id: true },
          where: {
            shopId_commandId: {
              commandId: input.commandId,
              shopId: input.routePlan.shop.id,
            },
          },
        });
        if (existing !== null) {
          return {
            dispatchId: existing.id,
            duplicate: true,
            preview: input.preview,
            routePlan: input.routePlan,
            settings: input.settings,
          };
        }

        const routePlan = await this.findRoutePlan(input.input, tx);
        if (routePlan === null) throw new CustomerEmailNotFoundError();
        if (JSON.stringify(selectedStopIds(routePlan, input.input.deliveryStopIds)) !== JSON.stringify(lockedStopIds)) {
          throw new CustomerEmailValidationError(
            'Customer email recipients changed while the send request was being prepared.',
            'CUSTOMER_EMAIL_PREVIEW_CONFLICT',
          );
        }
        const settings = normalizeCustomerEmailSettings(routePlan.shop.customerEmailSettings);
        assertConfigured(settings);
        const eligibleStopIds = selectEligibleStops(
          routePlan,
          input.input.signal,
          input.input.deliveryStopIds,
          routeOpsNearbyStopsThreshold(routePlan),
        ).map((stop) => stop.deliveryStop.id);
        const history = await this.readManualHistory(
          routePlan.shop.id,
          input.input.signal,
          eligibleStopIds,
          tx,
        );
        const preview = buildPreview(routePlan, settings, input.input, history);
        const template = settings.templates[input.input.signal];
        if (input.input.previewToken !== undefined && input.input.previewToken !== preview.previewToken) {
          throw new CustomerEmailValidationError(
            'Customer email preview is stale or does not match this send request.',
            'CUSTOMER_EMAIL_PREVIEW_CONFLICT',
          );
        }
        if (!template.enabled) throw new CustomerEmailValidationError('Selected customer email template is disabled.');
        if (previewHasMissingTemplateValues(preview) && input.input.missingValuesConfirmed !== true) {
          throw new CustomerEmailValidationError(
            'Missing customer email template values must be confirmed before sending.',
            'MISSING_TEMPLATE_VALUES_CONFIRMATION_REQUIRED',
          );
        }
        if (previewHasPriorSent(preview) && input.input.resendConfirmed !== true) {
          throw new CustomerEmailValidationError(
            'Prior customer email send must be confirmed before resending.',
            'RESEND_CONFIRMATION_REQUIRED',
          );
        }
        if (previewHasUncertainOutcome(preview)) {
          throw new CustomerEmailValidationError(
            'A prior customer email outcome is still pending or unknown. Reconcile it before sending again.',
            'CUSTOMER_EMAIL_OUTCOME_UNCERTAIN',
          );
        }

        const dispatch = await tx.customerEmailManualDispatch.create({
          data: {
            actor: input.actor,
            commandId: input.commandId,
            counts: countDispatchResults([]),
            request: {
              deliveryStopIds: input.input.deliveryStopIds ?? null,
              previewToken: input.input.previewToken ?? null,
              routePlanId: input.input.routePlanId,
              signal: input.input.signal,
            },
            routePlanId: input.input.routePlanId,
            shopId: routePlan.shop.id,
            signal: input.input.signal,
            template: {
              body: template.body,
              replyTo: settings.replyTo,
              senderEmail: settings.senderEmail,
              senderName: settings.senderName,
              subject: template.subject,
            },
            recipients: {
              create: [
                ...preview.skipped.map((skipped) => ({
                  deliveryStopId: skipped.deliveryStopId,
                  errorCode: skipped.code,
                  errorMessage: skipped.message,
                  orderId: skipped.orderId,
                  recipientEmail: null,
                  renderedBody: null,
                  renderedSubject: null,
                  routePlanId: input.input.routePlanId,
                  shopId: routePlan.shop.id,
                  status: 'SKIPPED',
                })),
                ...preview.recipients.map((recipient) => ({
                  deliveryStopId: recipient.deliveryStopId,
                  orderId: recipient.orderId,
                  recipientEmail: recipient.email,
                  renderedBody: recipient.rendered.body,
                  renderedSubject: recipient.rendered.subject,
                  routePlanId: input.input.routePlanId,
                  shopId: routePlan.shop.id,
                  status: 'PENDING',
                })),
              ],
            },
          },
          select: { id: true },
        });
        return { dispatchId: dispatch.id, duplicate: false, preview, routePlan, settings };
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        const existing = await this.prisma.customerEmailManualDispatch.findUnique({
          select: { id: true },
          where: { shopId_commandId: { commandId: input.commandId, shopId: input.routePlan.shop.id } },
        });
        if (existing !== null) {
          return {
            dispatchId: existing.id,
            duplicate: true,
            preview: input.preview,
            routePlan: input.routePlan,
            settings: input.settings,
          };
        }
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
            providerEventAt: true,
            providerMessageId: true,
            providerStatus: true,
            recipientEmail: true,
            sentAt: true,
            status: true,
            attempts: {
              orderBy: { completedAt: 'desc' },
              select: { completedAt: true, outcome: true, providerMessageId: true },
              take: 1,
              where: { outcome: 'SENT' },
            },
          },
        },
      },
      where: { shopId_commandId: { commandId, shopId } },
    });
    const results = dispatch.recipients.map((recipient) => {
      const successfulAttempt = recipient.attempts?.[0];
      const originalStatus = successfulAttempt === undefined
        ? toDispatchStatus(recipient.status)
        : 'SENT' as const;
      return ({
      deliveryStopId: recipient.deliveryStopId,
      email: recipient.recipientEmail,
      errorCode: recipient.errorCode,
      errorMessage: recipient.errorMessage,
      orderId: recipient.orderId,
      provider: recipient.provider,
      providerEventAt: recipient.providerEventAt?.toISOString() ?? null,
      providerMessageId: recipient.providerMessageId ?? successfulAttempt?.providerMessageId ?? null,
      providerStatus: recipient.providerStatus,
      sentAt: recipient.sentAt?.toISOString() ?? successfulAttempt?.completedAt?.toISOString() ?? null,
      originalStatus,
      status: duplicate ? 'DUPLICATE' as const : originalStatus,
    });
    });
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
      providerEventAt?: Date | null | undefined;
      providerMessageId?: string | null | undefined;
      providerStatus?: string | null | undefined;
      sentAt?: Date | null | undefined;
      status: 'FAILED' | 'SENT' | 'UNKNOWN';
    },
  ): Promise<void> {
    const updated = await this.prisma.customerEmailManualDispatchRecipient.updateMany({
      data: compactUpdateData(data),
      where: { deliveryStopId, dispatchId },
    });
    if (updated.count !== 1) throw new Error('Customer email recipient outcome was not saved.');
  }

  private async recordAcceptedProviderEvidence(
    dispatchId: string,
    deliveryStopId: string,
    occurredAt: Date,
    providerMessageId: string | null,
  ): Promise<void> {
    await this.prisma.customerEmailManualDispatchRecipient.updateMany({
      data: {
        providerEventAt: occurredAt,
        providerMessageId,
        providerStatus: 'ACCEPTED',
      },
      where: {
        deliveryStopId,
        dispatchId,
        OR: [
          { providerEventAt: null },
          { providerStatus: null },
          { providerStatus: 'UNKNOWN' },
        ],
      },
    });
  }

  private async readManualHistory(
    shopId: string,
    signal: CustomerEmailSignal,
    deliveryStopIds: string[],
    client: Pick<Prisma.TransactionClient, 'customerEmailManualDispatchRecipient'> = this.prisma,
  ): Promise<Map<string, CustomerEmailManualHistorySummary>> {
    if (deliveryStopIds.length === 0) return new Map();
    const rows = await client.customerEmailManualDispatchRecipient.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        attempts: {
          orderBy: { completedAt: 'desc' },
          select: { completedAt: true, outcome: true, providerMessageId: true },
          take: 1,
          where: { outcome: 'SENT' },
        },
        createdAt: true,
        deliveryStopId: true,
        providerEventAt: true,
        providerStatus: true,
        sentAt: true,
        status: true,
      },
      where: {
        deliveryStopId: { in: deliveryStopIds },
        dispatch: { signal },
        shopId,
      },
    });
    const summaries = new Map<string, CustomerEmailManualHistorySummary>();
    for (const row of rows) {
      if (row.deliveryStopId === null) continue;
      const successfulAttempt = row.attempts?.[0];
      const effectiveStatus = successfulAttempt === undefined ? row.status : 'SENT';
      const current = summaries.get(row.deliveryStopId);
      if (current === undefined) {
        summaries.set(row.deliveryStopId, {
          lastProviderEventAt: row.providerEventAt?.toISOString() ?? null,
          lastProviderStatus: row.providerStatus,
          lastSentAt: effectiveStatus === 'SENT'
            ? row.sentAt?.toISOString() ?? successfulAttempt?.completedAt?.toISOString() ?? null
            : null,
          lastStatus: effectiveStatus,
          sendCount: effectiveStatus === 'SENT' ? 1 : 0,
          uncertainCount: effectiveStatus === 'PENDING' || effectiveStatus === 'UNKNOWN' ? 1 : 0,
        });
      } else {
        if (effectiveStatus === 'SENT') {
          current.sendCount += 1;
          if (current.lastSentAt === null) {
            current.lastSentAt = row.sentAt?.toISOString() ?? successfulAttempt?.completedAt?.toISOString() ?? null;
          }
        }
        if (effectiveStatus === 'PENDING' || effectiveStatus === 'UNKNOWN') current.uncertainCount += 1;
      }
    }
    return summaries;
  }
}

export class CustomerEmailValidationError extends Error {
  readonly code: 'CUSTOMER_EMAIL_SENDER_MANAGED' | 'CUSTOMER_EMAIL_TEST_CONFIRMATION_REQUIRED' | 'CUSTOMER_EMAIL_BAD_REQUEST' | 'CUSTOMER_EMAIL_COMMAND_CONFLICT' | 'CUSTOMER_EMAIL_OUTCOME_UNCERTAIN' | 'CUSTOMER_EMAIL_PREVIEW_CONFLICT' | 'MISSING_TEMPLATE_VALUES_CONFIRMATION_REQUIRED' | 'RESEND_CONFIRMATION_REQUIRED';

  constructor(
    message: string,
    code: CustomerEmailValidationError['code'] = 'CUSTOMER_EMAIL_BAD_REQUEST',
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
  const selectedStops = selectStops(routePlan, input.deliveryStopIds);
  const eligibleStops = selectEligibleStops(routePlan, input.signal, input.deliveryStopIds, routeOpsNearbyStopsThreshold(routePlan));
  const eligibleStopIds = new Set(eligibleStops.map((stop) => stop.deliveryStop.id));
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
  const statusExclusions = selectedStops.filter((stop) => !eligibleStopIds.has(stop.deliveryStop.id));
  const exclusions = buildStatusExclusions(routePlan.status, input.signal, statusExclusions);
  const exampleBody = renderTemplate(template.body, testTemplateContext(settings));
  const exampleSubject = renderTemplate(template.subject, testTemplateContext(settings));
  const previewWithoutToken = {
    counts: {
      eligible: eligibleStops.length,
      missingEmail: skipped.length,
      rendered: recipients.length,
      selected: selectedStops.length,
      sendable: recipients.length,
      skipped: skipped.length,
      statusExcluded: statusExclusions.length,
      totalStops: routePlan.routeStops.length,
    },
    example: {
      diagnostics: { body: exampleBody.diagnostics, subject: exampleSubject.diagnostics },
      rendered: { body: exampleBody.value, subject: exampleSubject.value },
    },
    exclusions,
    recipients,
    routeStatus: routePlan.status,
    skipped,
  };
  return {
    ...previewWithoutToken,
    previewToken: customerEmailPreviewToken(routePlan, settings, input.signal, input.appId),
  };
}

function selectStops(
  routePlan: CustomerEmailRoutePlanRow,
  deliveryStopIds: string[] | undefined,
): CustomerEmailRoutePlanRow['routeStops'] {
  const selected = new Set((deliveryStopIds ?? []).filter(Boolean));
  return selected.size === 0
    ? routePlan.routeStops
    : routePlan.routeStops.filter((stop) => selected.has(stop.deliveryStop.id));
}

function selectedStopIds(routePlan: CustomerEmailRoutePlanRow, deliveryStopIds: string[] | undefined): string[] {
  return selectStops(routePlan, deliveryStopIds).map((stop) => stop.deliveryStop.id).sort();
}

function selectEligibleStops(
  routePlan: CustomerEmailRoutePlanRow,
  signal: CustomerEmailSignal,
  deliveryStopIds: string[] | undefined,
  nearbyStopsThreshold: number,
): CustomerEmailRoutePlanRow['routeStops'] {
  const stops = selectStops(routePlan, deliveryStopIds);
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

function buildStatusExclusions(
  routeStatus: string,
  signal: CustomerEmailSignal,
  stops: CustomerEmailRoutePlanRow['routeStops'],
): CustomerEmailStatusExclusion[] {
  const counts = new Map<string, number>();
  for (const stop of stops) {
    counts.set(stop.deliveryStop.status, (counts.get(stop.deliveryStop.status) ?? 0) + 1);
  }
  return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([status, count]) => ({
    code: routeStatus === 'COMPLETED' ? 'ROUTE_ALREADY_COMPLETED' as const : 'STOP_STATUS_INELIGIBLE' as const,
    count,
    message: routeStatus === 'COMPLETED'
      ? `The route is completed and the selected stops are ${status}, so ${signal} does not apply to them.`
      : `Stops with status ${status} are not eligible for this notification.`,
    status,
  }));
}

function customerEmailPreviewToken(
  routePlan: CustomerEmailRoutePlanRow,
  settings: CustomerEmailSettings,
  signal: CustomerEmailSignal,
  appId: string | undefined,
): string {
  const template = settings.templates[signal];
  const snapshot = {
    appId: appId ?? DEFAULT_SHOPIFY_APP_ID,
    branding: settings.branding,
    nearbyStopsThreshold: routeOpsNearbyStopsThreshold(routePlan),
    replyTo: settings.replyTo,
    route: {
      id: routePlan.id,
      name: routePlan.name,
      planDate: routePlan.planDate.toISOString(),
      status: routePlan.status,
      stops: routePlan.routeStops.map((stop) => ({
        deliveryStop: stop.deliveryStop,
        estimatedArrivalAt: stop.estimatedArrivalAt?.toISOString() ?? null,
        sequence: stop.sequence,
      })),
      timezone: resolveCustomerEmailTimezone(routePlan),
    },
    senderEmail: settings.senderEmail,
    senderName: settings.senderName,
    shop: { id: routePlan.shop.id, shopDomain: routePlan.shop.shopDomain },
    signal,
    template,
  };
  const digest = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  return `v1:${digest}`;
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
  const timezone = resolveCustomerEmailTimezone(routePlan);
  return {
    customerName: stop.deliveryStop.recipientName ?? '',
    deliveryAddress: formatAddress(stop.deliveryStop),
    deliveryDate: formatDate(stop.deliveryStop.deliveryDate ?? routePlan.planDate),
    deliveryWeekday: stop.deliveryStop.order.deliveryFacts[0]?.deliveryWeekday ?? '',
    eta: stop.estimatedArrivalAt === null ? '' : stop.estimatedArrivalAt.toISOString(),
    etaWindow: stop.estimatedArrivalAt === null || timezone === null
      ? ''
      : formatEtaWindow(stop.estimatedArrivalAt, timezone),
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
    etaWindow: 'Aug 4, 2026, 9:30 AM EDT - Aug 4, 2026, 10:30 AM EDT',
    inventoryList: '',
    orderNumber: '#1001',
    routeName: 'Test route',
    sequence: '1',
    shopName: settings.senderName,
  };
}

function resolveCustomerEmailTimezone(routePlan: CustomerEmailRoutePlanRow): string | null {
  const constraints = isRecord(routePlan.constraints) ? routePlan.constraints : null;
  const routeScope = constraints !== null && isRecord(constraints.routeScope) ? constraints.routeScope : null;
  const routeTimezone = [
    readNonEmptyString(constraints?.timezone),
    readNonEmptyString(routeScope?.timezone),
    readNonEmptyString(constraints?.scheduledStartTimeZone),
  ].find((value): value is string => value !== null && isIanaTimezone(value));
  if (routeTimezone !== undefined) return routeTimezone;

  const connectionTimezones = [...new Set(routePlan.shop.commerceConnections
    .map((connection) => connection.timezone?.trim() ?? '')
    .filter((value) => value !== '' && isIanaTimezone(value)))];
  return connectionTimezones.length === 1 ? connectionTimezones[0] ?? null : null;
}

function formatEtaWindow(eta: Date, timezone: string): string {
  const formatter = new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    hour: 'numeric',
    hour12: true,
    minute: '2-digit',
    month: 'short',
    timeZone: timezone,
    timeZoneName: 'short',
    year: 'numeric',
  });
  const halfWindowMs = 30 * 60 * 1000;
  return `${formatter.format(new Date(eta.getTime() - halfWindowMs))} - ${formatter.format(new Date(eta.getTime() + halfWindowMs))}`;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
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

function previewHasUncertainOutcome(preview: CustomerEmailPreview): boolean {
  return preview.recipients.some((recipient) => recipient.history.uncertainCount > 0);
}

function emptyManualHistorySummary(): CustomerEmailManualHistorySummary {
  return { lastProviderEventAt: null, lastProviderStatus: null, lastSentAt: null, lastStatus: null, sendCount: 0, uncertainCount: 0 };
}

function assertCommandMatchesDispatch(
  dispatch: { request: unknown; routePlanId: string; signal: string },
  input: CustomerEmailSendInput,
): void {
  const request = isRecord(dispatch.request) ? dispatch.request : {};
  const storedIds = normalizeStopIds(Array.isArray(request.deliveryStopIds) ? request.deliveryStopIds : undefined);
  const incomingIds = normalizeStopIds(input.deliveryStopIds);
  if (
    dispatch.routePlanId !== input.routePlanId
    || dispatch.signal !== input.signal
    || JSON.stringify(storedIds) !== JSON.stringify(incomingIds)
    || (
      typeof input.previewToken === 'string'
      && typeof request.previewToken === 'string'
      && request.previewToken !== input.previewToken
    )
  ) {
    throw new CustomerEmailValidationError(
      'commandId is already bound to a different customer email request.',
      'CUSTOMER_EMAIL_COMMAND_CONFLICT',
    );
  }
}

function normalizeStopIds(value: unknown[] | undefined): string[] {
  return [...new Set((value ?? []).filter((item): item is string => typeof item === 'string' && item.trim() !== ''))].sort();
}

function countDispatchResults(results: CustomerEmailDispatchResult[]): CustomerEmailDispatch['counts'] {
  return {
    duplicate: results.filter((result) => result.status === 'DUPLICATE').length,
    failed: results.filter((result) => result.status === 'FAILED').length,
    sent: results.filter((result) => result.status === 'SENT').length,
    skipped: results.filter((result) => result.status === 'SKIPPED').length,
  };
}

function toDispatchStatus(value: string): NonNullable<CustomerEmailDispatchResult['originalStatus']> {
  if (value === 'SENT' || value === 'FAILED' || value === 'SKIPPED' || value === 'PENDING') return value;
  return 'UNKNOWN';
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
  providerEventAt?: Date | null | undefined;
  providerMessageId?: string | null | undefined;
  providerStatus?: string | null | undefined;
  sentAt?: Date | null | undefined;
  status: 'FAILED' | 'SENT' | 'UNKNOWN';
}): Prisma.CustomerEmailManualDispatchRecipientUpdateManyMutationInput {
  return {
    ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
    ...(input.errorMessage === undefined ? {} : { errorMessage: input.errorMessage }),
    ...(input.provider === undefined ? {} : { provider: input.provider }),
    ...(input.providerEventAt === undefined ? {} : { providerEventAt: input.providerEventAt }),
    ...(input.providerMessageId === undefined ? {} : { providerMessageId: input.providerMessageId }),
    ...(input.providerStatus === undefined ? {} : { providerStatus: input.providerStatus }),
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

function automaticSettingsVersion(settings: CustomerEmailSettings): string {
  const templateVersions = customerEmailSignals.map((signal) => settings.templates[signal].version).join('-');
  return `v3:g${settings.globalVersion}:t${templateVersions}`;
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
  senderEmail?: string;
  senderName: string;
} | null {
  if (!isRecord(value) || !hasOnlyKeys({ senderEmail: '', ...value }, ['branding', 'expectedVersion', 'replyTo', 'senderEmail', 'senderName'])) return null;
  if (typeof value.expectedVersion !== 'number' || !Number.isInteger(value.expectedVersion)) return null;
  if (!isRecord(value.branding)) return null;
  try {
    const current = defaultCustomerEmailSettings();
    const settings = validateCustomerEmailSettingsPayload({
      ...current,
      replyTo: value.replyTo,
      senderEmail: 'senderEmail' in value ? value.senderEmail : '',
      senderName: value.senderName,
    });
    return {
      branding: value.branding,
      expectedVersion: value.expectedVersion,
      replyTo: settings.replyTo,
      ...('senderEmail' in value ? { senderEmail: settings.senderEmail } : {}),
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
  previewToken?: string | undefined;
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
  if (value.previewToken !== undefined && (typeof value.previewToken !== 'string' || !/^v1:[a-f0-9]{64}$/u.test(value.previewToken))) {
    return null;
  }
  return {
    ...(typeof value.commandId === 'string' ? { commandId: value.commandId } : {}),
    ...(typeof value.confirmed === 'boolean' ? { confirmed: value.confirmed } : {}),
    ...(Array.isArray(deliveryStopIds) ? { deliveryStopIds } : {}),
    ...(typeof value.missingValuesConfirmed === 'boolean' ? { missingValuesConfirmed: value.missingValuesConfirmed } : {}),
    ...(typeof value.previewToken === 'string' ? { previewToken: value.previewToken } : {}),
    ...(typeof value.resendConfirmed === 'boolean' ? { resendConfirmed: value.resendConfirmed } : {}),
    signal,
  };
}

export function readCustomerEmailTestPayload(value: unknown): {
  body?: string | undefined;
  confirmed: true;
  recipientEmail: string;
  signal?: CustomerEmailSignal | undefined;
  subject?: string | undefined;
} | null {
  if (!isRecord(value) || value.confirmed !== true || typeof value.recipientEmail !== 'string') return null;
  if (typeof value.subject === 'string' && value.subject.length > 200) return null;
  if (typeof value.body === 'string' && value.body.length > 10_000) return null;
  const signal = value.signal === undefined ? undefined : readCustomerEmailSignal(value.signal);
  if (value.signal !== undefined && signal === null) return null;
  return {
    ...(typeof value.body === 'string' ? { body: value.body } : {}),
    confirmed: true,
    recipientEmail: value.recipientEmail,
    ...(signal === undefined || signal === null ? {} : { signal }),
    ...(typeof value.subject === 'string' ? { subject: value.subject } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertCompanySender(payload: object, senderEmail: string): void {
  if ('senderEmail' in payload && (typeof payload.senderEmail !== 'string' || payload.senderEmail.trim().toLowerCase() !== senderEmail)) {
    throw new CustomerEmailValidationError('The sender email address is managed by CLEVER.', 'CUSTOMER_EMAIL_SENDER_MANAGED');
  }
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key)) && allowedKeys.every((key) => key in value);
}

export { customerEmailSignals, defaultCustomerEmailSettings };
