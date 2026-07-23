export type CustomerDeliveryNotificationMessage = {
  deliveryStopId: string;
  idempotencyKey: string;
  orderId: string;
  recipientEmail: string;
  routePlanId: string;
  shopDomain: string;
  status: 'COMPLETED' | 'IN_PROGRESS' | 'READY';
};

export type CustomerDeliveryNotificationSendResult = {
  errorCode?: string | null;
  errorMessage?: string | null;
  provider: string;
  providerMessageId?: string | null;
  status: 'FAILED' | 'SENT';
};

export type CustomerDeliveryNotificationSender = {
  readonly providerName: string;
  send(message: CustomerDeliveryNotificationMessage): Promise<CustomerDeliveryNotificationSendResult>;
};

export type CustomerDeliveryNotificationRuntimeEnv = Partial<Record<
  | 'CUSTOMER_DELIVERY_NOTIFICATION_BEARER_TOKEN'
  | 'CUSTOMER_DELIVERY_NOTIFICATION_TIMEOUT_MS'
  | 'CUSTOMER_DELIVERY_NOTIFICATION_URL',
  string
>>;

export class HttpCustomerDeliveryNotificationSender implements CustomerDeliveryNotificationSender {
  readonly providerName = 'http';
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: {
    bearerToken?: string | undefined;
    fetchImpl?: typeof fetch | undefined;
    timeoutMs?: number | undefined;
    url: string;
  }) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  async send(message: CustomerDeliveryNotificationMessage): Promise<CustomerDeliveryNotificationSendResult> {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.options.url, {
        body: JSON.stringify({
          deliveryStopId: message.deliveryStopId,
          idempotencyKey: message.idempotencyKey,
          orderId: message.orderId,
          recipientEmail: message.recipientEmail,
          routePlanId: message.routePlanId,
          shopDomain: message.shopDomain,
          status: message.status
        }),
        headers: {
          'Content-Type': 'application/json',
          ...(this.options.bearerToken === undefined ? {} : { Authorization: `Bearer ${this.options.bearerToken}` })
        },
        method: 'POST',
        signal: abortController.signal
      });
      if (!response.ok) {
        return {
          errorCode: 'HTTP_CUSTOMER_NOTIFICATION_FAILED',
          errorMessage: `Customer notification sender returned HTTP ${response.status}.`,
          provider: this.providerName,
          status: 'FAILED'
        };
      }
      const providerMessageId = readProviderMessageId(await readJsonSafely(response));
      return {
        ...(providerMessageId === null ? {} : { providerMessageId }),
        provider: this.providerName,
        status: 'SENT'
      };
    } catch (error) {
      return {
        errorCode: error instanceof DOMException && error.name === 'AbortError'
          ? 'HTTP_CUSTOMER_NOTIFICATION_TIMEOUT'
          : 'HTTP_CUSTOMER_NOTIFICATION_ERROR',
        errorMessage: error instanceof Error ? error.message : 'Customer notification sender failed.',
        provider: this.providerName,
        status: 'FAILED'
      };
    } finally {
      clearTimeout(timeout);
    }
  }
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
