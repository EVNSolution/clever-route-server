export type CustomerDeliveryStatusNotificationMessage = {
  deliveryStopId: string;
  idempotencyKey: string;
  orderId: string;
  recipientEmail: string;
  routePlanId: string;
  shopDomain: string;
  status: 'COMPLETED' | 'IN_PROGRESS' | 'READY';
};

export type CustomerMessageNotificationMessage = {
  body: string;
  idempotencyKey: string;
  kind: 'CUSTOMER_MESSAGE';
  orderId: string;
  orderMessageId: string;
  recipientEmail: string;
  shopDomain: string;
};

export type CustomerDeliveryNotificationMessage =
  | CustomerDeliveryStatusNotificationMessage
  | CustomerMessageNotificationMessage;

export type CustomerDeliveryNotificationSendResult = {
  errorCode?: string | null;
  errorMessage?: string | null;
  provider: string;
  providerMessageId?: string | null;
  retryable?: boolean | undefined;
  status: 'FAILED' | 'SENT';
};

export type CustomerDeliveryNotificationSender = {
  readonly providerName: string;
  send(message: CustomerDeliveryNotificationMessage): Promise<CustomerDeliveryNotificationSendResult>;
};

export type CustomerDeliveryNotificationRuntimeEnv = Partial<Record<
  | 'CUSTOMER_DELIVERY_NOTIFICATION_BEARER_TOKEN'
  | 'CUSTOMER_DELIVERY_NOTIFICATION_TIMEOUT_MS'
  | 'CUSTOMER_DELIVERY_NOTIFICATION_URL'
  | 'CUSTOMER_DELIVERY_NOTIFICATION_WORKER_ENABLED',
  string
>>;

export class HttpCustomerDeliveryNotificationSender implements CustomerDeliveryNotificationSender {
  readonly providerName = 'http';
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;

  constructor(private readonly options: {
    bearerToken?: string | undefined;
    fetchImpl?: typeof fetch | undefined;
    sleep?: ((ms: number) => Promise<void>) | undefined;
    timeoutMs?: number | undefined;
    url: string;
  }) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? sleep;
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  async send(message: CustomerDeliveryNotificationMessage): Promise<CustomerDeliveryNotificationSendResult> {
    for (let attempt = 0; attempt < maxNotificationSendAttempts; attempt += 1) {
      const abortController = new AbortController();
      const timeout = setTimeout(() => abortController.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(this.options.url, {
          body: JSON.stringify(toRequestBody(message)),
          headers: {
            'Content-Type': 'application/json',
            ...(this.options.bearerToken === undefined ? {} : { Authorization: `Bearer ${this.options.bearerToken}` })
          },
          method: 'POST',
          signal: abortController.signal
        });
        if (!response.ok) {
          const result = {
            errorCode: 'HTTP_CUSTOMER_NOTIFICATION_FAILED',
            errorMessage: `Customer notification sender returned HTTP ${response.status}.`,
            provider: this.providerName,
            retryable: shouldRetryHttpStatus(response.status),
            status: 'FAILED'
          } satisfies CustomerDeliveryNotificationSendResult;
          if (!shouldRetryHttpStatus(response.status) || attempt === maxNotificationSendAttempts - 1) return result;
          await this.sleep(notificationSendRetryDelaysMs[attempt] ?? notificationSendRetryDelaysMs.at(-1) ?? 0);
          continue;
        }
        const providerMessageId = readProviderMessageId(await readJsonSafely(response));
        return {
          ...(providerMessageId === null ? {} : { providerMessageId }),
          provider: this.providerName,
          status: 'SENT'
        };
      } catch (error) {
        const result = {
          errorCode: isAbortError(error)
            ? 'HTTP_CUSTOMER_NOTIFICATION_TIMEOUT'
            : 'HTTP_CUSTOMER_NOTIFICATION_ERROR',
          errorMessage: error instanceof Error ? error.message : 'Customer notification sender failed.',
          provider: this.providerName,
          retryable: true,
          status: 'FAILED'
        } satisfies CustomerDeliveryNotificationSendResult;
        if (attempt === maxNotificationSendAttempts - 1) return result;
        await this.sleep(notificationSendRetryDelaysMs[attempt] ?? notificationSendRetryDelaysMs.at(-1) ?? 0);
      } finally {
        clearTimeout(timeout);
      }
    }

    return {
      errorCode: 'HTTP_CUSTOMER_NOTIFICATION_ERROR',
      errorMessage: 'Customer notification sender failed.',
      provider: this.providerName,
      retryable: true,
      status: 'FAILED'
    };
  }
}

const maxNotificationSendAttempts = 3;
const notificationSendRetryDelaysMs = [100, 200] as const;

function toRequestBody(message: CustomerDeliveryNotificationMessage): Record<string, string> {
  if (isCustomerMessageNotification(message)) {
    return {
      body: message.body,
      idempotencyKey: message.idempotencyKey,
      kind: message.kind,
      orderId: message.orderId,
      orderMessageId: message.orderMessageId,
      recipientEmail: message.recipientEmail,
      shopDomain: message.shopDomain
    };
  }
  return {
    deliveryStopId: message.deliveryStopId,
    idempotencyKey: message.idempotencyKey,
    orderId: message.orderId,
    recipientEmail: message.recipientEmail,
    routePlanId: message.routePlanId,
    shopDomain: message.shopDomain,
    status: message.status
  };
}

function isCustomerMessageNotification(message: CustomerDeliveryNotificationMessage): message is CustomerMessageNotificationMessage {
  return 'kind' in message && message.kind === 'CUSTOMER_MESSAGE';
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetryHttpStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export function loadCustomerDeliveryNotificationSender(
  env: CustomerDeliveryNotificationRuntimeEnv
): CustomerDeliveryNotificationSender | undefined {
  const url = readOptional(env.CUSTOMER_DELIVERY_NOTIFICATION_URL);
  if (url === undefined) return undefined;
  assertAllowedSenderUrl(url);
  return new HttpCustomerDeliveryNotificationSender({
    bearerToken: readOptional(env.CUSTOMER_DELIVERY_NOTIFICATION_BEARER_TOKEN),
    timeoutMs: readPositiveInteger(env.CUSTOMER_DELIVERY_NOTIFICATION_TIMEOUT_MS) ?? 5000,
    url
  });
}

function assertAllowedSenderUrl(value: string): void {
  const url = new URL(value);
  if (url.protocol === 'https:') return;
  if (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) return;
  throw new Error('CUSTOMER_DELIVERY_NOTIFICATION_URL must use HTTPS except localhost smoke targets.');
}

function readOptional(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  return value.trim();
}

function readPositiveInteger(value: string | undefined): number | undefined {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

async function readJsonSafely(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function readProviderMessageId(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || !('providerMessageId' in value)) return null;
  const raw = (value as { providerMessageId?: unknown }).providerMessageId;
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
}
