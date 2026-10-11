import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { resolveOrderPayment, type OrderPayment } from '../payments/order-payment.js';
import { KFOOD_DELIVERY_SHOP_DOMAIN } from '../route-plans/kfood-delivery-completion.js';
import type { RecordDriverEventInput, RecordDriverEventResult } from './driver-event.repository.js';

export type DriverStopCompletion = {
  id: string;
  eventId: string;
  deliveryStopId: string;
  routePlanId: string;
  driverId: string;
  assignmentGeneration: string;
  expectedRouteVersionId: string;
  method: OrderPayment['method'];
  payment: OrderPayment;
  expectedAmount: string | null;
  actualAmount: string | null;
  differenceAmount: string | null;
  currencyCode: string | null;
  occurredAt: string;
  recordedAt: string;
};

export class DriverCashCompletionError extends Error {
  constructor(
    readonly code: 'CASH_COMPLETION_INVALID' | 'CASH_RECEIVED_REQUIRED' | 'CASH_COMPLETION_CONFLICT',
    message: string,
    readonly statusCode: 400 | 409 = 400
  ) { super(message); }
}

type CompletionInput = { version: 1; cashReceived?: { amount: string; currency: string } };
type ReceiptClient = Pick<PrismaClient, 'driverStopCompletionReceipt'>;

export function readStoredDriverStopCompletion(result: unknown): DriverStopCompletion | null {
  const completion = object(result)?.completion;
  return object(completion) === null ? null : completion as DriverStopCompletion;
}

// The opt-in contract belongs to the existing event body, including its offline identity.
export function readDriverCompletion(input: RecordDriverEventInput): CompletionInput | null {
  const raw = object(input.payload)?.completion;
  if (raw === undefined) return null;
  const completion = object(raw);
  if (input.shopDomain !== KFOOD_DELIVERY_SHOP_DOMAIN || input.eventType !== 'STOP_DELIVERED'
    || input.driverContractVersion !== 2 || !input.clientEventId || !input.deliveryStopId
    || !input.routePlanId || !input.assignmentGeneration || !input.expectedRouteVersionId
    || completion?.version !== 1 || Object.keys(completion).some(key => !['version', 'cashReceived'].includes(key))) {
    throw invalid('Completion v1 requires a KFood STOP_DELIVERED event with ordered-v2 identity');
  }
  if (completion.cashReceived === undefined) return { version: 1 };
  const cash = object(completion.cashReceived);
  if (cash === null || Object.keys(cash).some(key => !['amount', 'currency'].includes(key))
    || typeof cash.amount !== 'string' || !/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/u.test(cash.amount)
    || typeof cash.currency !== 'string' || !/^[A-Z]{3}$/u.test(cash.currency)) {
    throw invalid('cashReceived requires a nonnegative decimal string and uppercase currency');
  }
  return { version: 1, cashReceived: { amount: new Prisma.Decimal(cash.amount).toFixed(2), currency: cash.currency } };
}

/** Never regenerate a committed result from current order, ETA, or publication data. */
export async function replayDriverCompletion(
  prisma: ReceiptClient, input: RecordDriverEventInput
): Promise<RecordDriverEventResult | null> {
  if (input.clientEventId === null || prisma.driverStopCompletionReceipt === undefined) return null;
  const receipt = await prisma.driverStopCompletionReceipt.findUnique({ where: { clientEventId: input.clientEventId } });
  if (receipt === null) return null;
  const completion = readDriverCompletion(input);
  if (completion === null || receipt.requestHash !== requestHash(input, completion)) {
    throw conflict('Completion identifier was already committed with another request');
  }
  return { ...(receipt.result as unknown as RecordDriverEventResult), duplicate: true };
}

export async function prepareDriverCompletion(
  prisma: Prisma.TransactionClient, input: RecordDriverEventInput
): Promise<{ completion: CompletionInput; payment: OrderPayment } | null> {
  const completion = readDriverCompletion(input);
  if (completion === null) return null;
  const stop = await prisma.deliveryStop.findFirst({
    where: { id: input.deliveryStopId!, shopId: input.shopId,
      routePlanStops: { some: { routePlanId: input.routePlanId!, routePlan: { driverId: input.driverId } } } },
    include: { order: true, stopCompletionReceipt: true }
  });
  if (stop === null) throw invalid('Completion stop is unavailable');
  if (stop.stopCompletionReceipt !== null || ['DELIVERED', 'FAILED', 'SKIPPED', 'CANCELLED'].includes(stop.status)) {
    throw conflict('A terminal stop cannot receive a new first completion or cash record');
  }
  // Serialize order refresh/manual-payment changes with the authoritative expected amount.
  await prisma.$queryRaw(Prisma.sql`SELECT id FROM orders WHERE id = ${stop.orderId}::uuid AND "shopId" = ${input.shopId}::uuid FOR SHARE`);
  const order = await prisma.order.findUniqueOrThrow({ where: { id: stop.orderId } });
  const payment = resolveOrderPayment(order);
  if (payment.requiresCashInput && completion.cashReceived === undefined) {
    throw new DriverCashCompletionError('CASH_RECEIVED_REQUIRED', 'Cash completion requires the actual received amount');
  }
  if (completion.cashReceived !== undefined && (payment.method !== 'CASH'
    || payment.currencyCode !== completion.cashReceived.currency
    || (!payment.requiresCashInput && completion.cashReceived.amount !== '0.00'))) {
    throw invalid('Cash amount or currency is incompatible with the server payment source');
  }
  return { completion, payment };
}

export async function saveDriverCompletion(
  prisma: Prisma.TransactionClient, input: RecordDriverEventInput,
  prepared: NonNullable<Awaited<ReturnType<typeof prepareDriverCompletion>>>,
  event: { id: string; createdAt: Date }, result: RecordDriverEventResult
): Promise<RecordDriverEventResult> {
  const { completion, payment } = prepared;
  const actualAmount = completion.cashReceived?.amount ?? null;
  const differenceAmount = actualAmount === null || payment.expectedAmount === null ? null
    : new Prisma.Decimal(actualAmount).minus(payment.expectedAmount).toFixed(2);
  const receipt: DriverStopCompletion = {
    id: randomUUID(), eventId: event.id, deliveryStopId: input.deliveryStopId!, routePlanId: input.routePlanId!,
    driverId: input.driverId, assignmentGeneration: input.assignmentGeneration!, expectedRouteVersionId: input.expectedRouteVersionId!,
    method: payment.method, payment, expectedAmount: payment.expectedAmount, actualAmount, differenceAmount,
    currencyCode: payment.currencyCode, occurredAt: input.occurredAt.toISOString(), recordedAt: event.createdAt.toISOString()
  };
  const saved = { ...result, completion: receipt };
  await prisma.driverStopCompletionReceipt.create({ data: {
    id: receipt.id, eventId: event.id, clientEventId: input.clientEventId!, shopId: input.shopId,
    driverId: input.driverId, routePlanId: input.routePlanId!, deliveryStopId: input.deliveryStopId!,
    assignmentGeneration: BigInt(input.assignmentGeneration!), expectedRouteVersionId: input.expectedRouteVersionId!,
    requestHash: requestHash(input, completion), payment, expectedAmount: payment.expectedAmount,
    actualAmount, differenceAmount, currencyCode: payment.currencyCode, occurredAt: input.occurredAt,
    recordedAt: event.createdAt, result: JSON.parse(JSON.stringify(saved)) as Prisma.InputJsonValue
  } });
  return saved;
}

function requestHash(input: RecordDriverEventInput, completion: CompletionInput): string {
  const identity = {
    shopId: input.shopId, shopDomain: input.shopDomain, driverId: input.driverId, routePlanId: input.routePlanId,
    deliveryStopId: input.deliveryStopId, clientEventId: input.clientEventId, eventType: input.eventType,
    assignmentGeneration: input.assignmentGeneration, expectedRouteVersionId: input.expectedRouteVersionId,
    driverContractVersion: input.driverContractVersion, occurredAt: input.occurredAt.toISOString(),
    latitude: input.latitude, longitude: input.longitude, payload: { ...object(input.payload), completion }
  };
  return createHash('sha256').update(JSON.stringify(canonical(identity))).digest('hex');
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  const record = object(value);
  return record === null ? value : Object.fromEntries(Object.keys(record).sort().map(key => [key, canonical(record[key])]));
}
function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function invalid(message: string): DriverCashCompletionError { return new DriverCashCompletionError('CASH_COMPLETION_INVALID', message); }
function conflict(message: string): DriverCashCompletionError { return new DriverCashCompletionError('CASH_COMPLETION_CONFLICT', message, 409); }
