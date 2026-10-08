import { Prisma } from '@prisma/client';

export type OrderPayment = {
  method: 'CASH' | 'ETRANSFER' | 'OTHER' | 'UNKNOWN';
  methodTitle: string | null;
  gatewayNames: string[];
  financialStatus: string | null;
  expectedAmount: string | null;
  currencyCode: string | null;
  expectedAmountSource: 'SHOPIFY_OUTSTANDING' | 'UNPAID_ORDER_TOTAL' | 'PAID' | 'UNKNOWN';
  requiresCashInput: boolean;
};

/** Shared OFFICE/DRIVER projection. Order totals are not evidence of an unpaid balance. */
export function resolveOrderPayment(input: {
  rawPayload: unknown;
  financialStatus: unknown;
  currencyCode: unknown;
  totalPriceAmount: unknown;
}): OrderPayment {
  const raw = record(input.rawPayload);
  const gatewayNames = strings(raw?.paymentGatewayNames ?? raw?.payment_gateway_names);
  const manualMethod = manualPaymentMethod(raw?.cleverManualPaymentMethod)
    ?? manualPaymentMethod(raw?.cleverManualPaymentStatus);
  const legacyTitle = string(raw?.paymentMethodTitle) ?? string(raw?.payment_method_title)
    ?? string(raw?.paymentMethod) ?? string(raw?.payment_method);
  // A generic "manual" gateway supplies no method. An explicit manual method/title can refine it.
  const namedGateways = gatewayNames.filter((name) => compact(name) !== 'manual');
  const titles = namedGateways.length > 0 ? namedGateways.map(formatGateway)
    : manualMethod !== null ? [formatGateway(manualMethod)]
      : legacyTitle !== null ? [legacyTitle] : gatewayNames.map(formatGateway);
  const methods = [...new Set(titles.map(classifyMethod))];
  const method = methods.length === 1 ? methods[0]! : 'UNKNOWN';
  // Office edits also replace the order column. Retain the commerce snapshot when
  // deciding whether the order total can safely stand in for an unpaid balance.
  const sourceFinancialStatus = string(raw?.displayFinancialStatus)?.toUpperCase()
    ?? string(raw?.financial_status)?.toUpperCase()
    ?? string(input.financialStatus)?.toUpperCase() ?? null;
  const financialStatus = manualFinancialStatus(raw?.cleverManualPaymentStatus)
    ?? string(input.financialStatus)?.toUpperCase() ?? sourceFinancialStatus;
  const currencyCode = currency(input.currencyCode) ?? currency(raw?.currency);
  const result: OrderPayment = {
    method,
    methodTitle: titles.length === 0 ? null : [...new Set(titles)].join(' / '),
    gatewayNames,
    financialStatus,
    expectedAmount: null,
    currencyCode,
    expectedAmountSource: 'UNKNOWN',
    requiresCashInput: false
  };

  if (financialStatus === 'PAID' || (financialStatus === null && raw?.normalizedPaymentStatus === 'PAID_CONFIRMED')) {
    result.expectedAmount = '0.00';
    result.expectedAmountSource = 'PAID';
  } else if (raw?.totalOutstandingSet !== undefined && raw.totalOutstandingSet !== null) {
    const outstanding = record(record(raw.totalOutstandingSet)?.shopMoney);
    const outstandingCurrency = currency(outstanding?.currencyCode);
    const amount = exactMoney(outstanding?.amount);
    // Conflicting currencies or malformed explicit balances must not fall back to the total.
    if (amount !== null && outstandingCurrency !== null && (currencyCode === null || currencyCode === outstandingCurrency)) {
      result.expectedAmount = amount;
      result.currencyCode = outstandingCurrency;
      result.expectedAmountSource = 'SHOPIFY_OUTSTANDING';
    }
  } else if ((financialStatus === 'PENDING' || financialStatus === 'UNPAID') && currencyCode !== null
    && (sourceFinancialStatus === null || sourceFinancialStatus === 'PENDING' || sourceFinancialStatus === 'UNPAID')) {
    const amount = exactMoney(input.totalPriceAmount);
    if (amount !== null && !amount.startsWith('-')) {
      result.expectedAmount = amount;
      result.expectedAmountSource = 'UNPAID_ORDER_TOTAL';
    }
  }

  const exception = ['EXPIRED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'VOIDED'].includes(financialStatus ?? '');
  result.requiresCashInput = method === 'CASH' && !exception
    && (result.expectedAmount === null || (!result.expectedAmount.startsWith('-') && result.expectedAmount !== '0.00'));
  return result;
}

/** Decimal(18,2), without binary floating-point conversion or silent rounding. */
function exactMoney(value: unknown): string | null {
  const text = value instanceof Prisma.Decimal ? value.toFixed() : string(value);
  if (text === null || !/^-?\d{1,16}(?:\.\d{1,2})?$/u.test(text)) return null;
  const negative = text.startsWith('-');
  const [whole = '', fraction = ''] = (negative ? text.slice(1) : text).split('.');
  const normalized = `${whole.replace(/^0+(?=\d)/u, '')}.${fraction.padEnd(2, '0')}`;
  return negative && normalized !== '0.00' ? `-${normalized}` : normalized;
}

function classifyMethod(title: string): OrderPayment['method'] {
  const name = compact(title);
  if (['cash', 'cod', 'cashondelivery', 'cashondeliverycod', '현금'].includes(name)) return 'CASH';
  if (['etransfer', 'emailtransfer', 'emailmoneytransfer', 'moneytransfer', 'interac', 'interacetransfer'].includes(name)) return 'ETRANSFER';
  if (['manual', 'unknown', 'unknownpaymentmethod'].includes(name)) return 'UNKNOWN';
  return 'OTHER';
}

function formatGateway(title: string): string {
  const method = classifyMethod(title);
  if (method === 'CASH') return 'Cash';
  if (method === 'ETRANSFER') return 'e-Transfer';
  if (compact(title) === 'shopifypayments') return 'Shopify Payments';
  if (compact(title) === 'shopifystorecredit') return 'Shopify Store Credit';
  if (compact(title) === 'manual') return 'Manual';
  return title;
}

function manualPaymentMethod(value: unknown): string | null {
  return value === 'CASH' || value === 'ETRANSFER' ? value : null;
}

function manualFinancialStatus(value: unknown): string | null {
  return value === 'PAID' || value === 'PENDING' || value === 'UNKNOWN' ? value : null;
}

function compact(value: string): string {
  return value.toLowerCase().replace(/[\s_()-]+/gu, '');
}

function currency(value: unknown): string | null {
  const text = string(value)?.toUpperCase() ?? null;
  return text !== null && /^[A-Z]{3}$/u.test(text) ? text : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function string(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.flatMap((entry) => string(entry) === null ? [] : [string(entry)!]))] : [];
}
