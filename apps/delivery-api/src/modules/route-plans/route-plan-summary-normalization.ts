import { Prisma } from '@prisma/client';

export function normalizeRouteEtaRange(values: Array<Date | null>): { endAt: string; startAt: string } | null {
  const timestamps = values.flatMap((value) => value === null ? [] : [value.getTime()]);
  if (timestamps.length === 0) return null;
  return {
    endAt: new Date(Math.max(...timestamps)).toISOString(),
    startAt: new Date(Math.min(...timestamps)).toISOString()
  };
}

export function normalizeRouteTotalAmount(
  orders: Array<{ currencyCode?: string | null; id: string; totalPriceAmount?: unknown }>
): { amount: string; currencyCode: string } | null {
  const uniqueOrders = new Map(orders.map((order) => [order.id, order]));
  if (uniqueOrders.size === 0) return null;
  let currencyCode: string | null = null;
  let amount = new Prisma.Decimal(0);
  for (const order of uniqueOrders.values()) {
    const orderCurrency = order.currencyCode?.trim().toUpperCase() ?? '';
    const orderAmount = decimalAmount(order.totalPriceAmount);
    if (orderAmount === null || orderCurrency === '') return null;
    if (currencyCode !== null && currencyCode !== orderCurrency) return null;
    try {
      amount = amount.plus(new Prisma.Decimal(orderAmount));
    } catch {
      return null;
    }
    currencyCode = orderCurrency;
  }
  return currencyCode === null ? null : { amount: amount.toFixed(2), currencyCode };
}

function decimalAmount(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (value instanceof Prisma.Decimal) return value.toString();
  return null;
}
