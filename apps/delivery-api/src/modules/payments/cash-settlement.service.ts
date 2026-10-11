import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient, type DriverCashSettlement } from '@prisma/client';
import { appScopedShopWhere } from '../shopify/shopify-app-scope.js';
import { readStoredDriverStopCompletion } from '../driver/driver-completion.js';
import { KFOOD_DELIVERY_APP_ID, KFOOD_DELIVERY_SHOP_DOMAIN } from '../route-plans/kfood-delivery-completion.js';

type Scope = { appId: string; shopDomain: string; routePlanId: string };
export type CashSettlementCommand = { commandId: string; receiptId: string; expectedRevision: number; confirmedAmount: string; currency: string; reason: string | null };
export class CashSettlementError extends Error {
  constructor(readonly code: 'SETTLEMENT_INVALID' | 'SETTLEMENT_CONFLICT' | 'NOT_FOUND', message: string, readonly statusCode: 400 | 404 | 409) { super(message); }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export function readCashSettlementCommand(value: unknown): CashSettlementCommand {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(key => !['commandId', 'receiptId', 'expectedRevision', 'confirmedAmount', 'currency', 'reason'].includes(key))
    || typeof body.commandId !== 'string' || !uuid.test(body.commandId) || typeof body.receiptId !== 'string' || !uuid.test(body.receiptId)
    || !Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 0
    || typeof body.confirmedAmount !== 'string' || !/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/u.test(body.confirmedAmount)
    || typeof body.currency !== 'string' || !/^[A-Z]{3}$/u.test(body.currency)
    || (body.reason != null && (typeof body.reason !== 'string' || body.reason.trim().length > 1000))) throw invalid();
  const reason = typeof body.reason === 'string' ? body.reason.trim() || null : null;
  if ((body.expectedRevision as number) > 0 && reason === null) throw invalid();
  return { commandId: body.commandId.toLowerCase(), receiptId: body.receiptId.toLowerCase(), expectedRevision: body.expectedRevision as number,
    confirmedAmount: new Prisma.Decimal(body.confirmedAmount).toFixed(2), currency: body.currency, reason };
}
export class PrismaCashSettlementService {
  constructor(private readonly prisma: PrismaClient) {}
  private async shopId(input: Scope): Promise<string> {
    if (!uuid.test(input.routePlanId) || input.appId !== KFOOD_DELIVERY_APP_ID || input.shopDomain.trim().toLowerCase() !== KFOOD_DELIVERY_SHOP_DOMAIN) throw notFound();
    const shop = await this.prisma.shop.findUnique({ where: appScopedShopWhere(input), select: { id: true } });
    if (shop === null) throw notFound();
    return shop.id;
  }
  async list(input: Scope) {
    const shopId = await this.shopId(input);
    const route = await this.prisma.routePlan.findFirst({ where: { id: input.routePlanId, shopId }, select: { id: true } });
    if (route === null) throw notFound();
    const receipts = await this.prisma.driverStopCompletionReceipt.findMany({ where: { shopId, routePlanId: input.routePlanId },
      include: { settlements: { orderBy: { revision: 'desc' } } }, orderBy: { recordedAt: 'asc' } });
    return { routePlanId: input.routePlanId, receipts: receipts.flatMap(receipt => {
      const completion = readStoredDriverStopCompletion(receipt.result);
      if (completion?.method !== 'CASH' || receipt.actualAmount === null || receipt.currencyCode === null) return [];
      const history = receipt.settlements.map(serialize);
      return [{ completion, revision: history[0]?.revision ?? 0, settlement: history[0] ?? null, history }];
    }) };
  }
  async confirm(input: Scope & { actor: string; command: CashSettlementCommand }) {
    const shopId = await this.shopId(input);
    const command = readCashSettlementCommand(input.command);
    const requestHash = createHash('sha256').update(JSON.stringify({ ...command, routePlanId: input.routePlanId, actor: input.actor })).digest('hex');
    try { return await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM route_plans WHERE id = ${input.routePlanId}::uuid AND "shopId" = ${shopId}::uuid FOR UPDATE`;
      const route = await tx.routePlan.findFirst({ where: { id: input.routePlanId, shopId }, select: { id: true } });
      if (route === null) throw notFound();
      const original = await tx.driverCashSettlement.findUnique({ where: { shopId_commandId: { shopId, commandId: command.commandId } } });
      if (original !== null) {
        if (original.requestHash !== requestHash) throw conflict();
        return { settlement: serialize(original), duplicate: true };
      }
      const receipt = await tx.driverStopCompletionReceipt.findFirst({ where: { id: command.receiptId, shopId, routePlanId: input.routePlanId } });
      if (receipt === null) throw notFound();
      if (readStoredDriverStopCompletion(receipt.result)?.method !== 'CASH' || receipt.actualAmount === null || receipt.currencyCode !== command.currency) throw invalid();
      const latest = await tx.driverCashSettlement.findFirst({ where: { receiptId: receipt.id, shopId }, orderBy: { revision: 'desc' } });
      if ((latest?.revision ?? 0) !== command.expectedRevision) throw conflict();
      const amount = new Prisma.Decimal(command.confirmedAmount);
      const record = await tx.driverCashSettlement.create({ data: {
        shopId, routePlanId: input.routePlanId, receiptId: receipt.id, commandId: command.commandId, revision: command.expectedRevision + 1,
        requestHash, confirmedAmount: amount, currency: command.currency, reason: command.reason, actor: input.actor,
        differenceFromActual: amount.minus(receipt.actualAmount), differenceFromExpected: receipt.expectedAmount === null ? null : amount.minus(receipt.expectedAmount)
      } });
      return { settlement: serialize(record), duplicate: false };
    }); } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw conflict();
      throw error;
    }
  }
}
function serialize(row: DriverCashSettlement) {
  return { id: row.id, commandId: row.commandId, receiptId: row.receiptId, revision: row.revision, confirmedAmount: row.confirmedAmount.toFixed(2),
    currency: row.currency, differenceFromActual: row.differenceFromActual.toFixed(2), differenceFromExpected: row.differenceFromExpected?.toFixed(2) ?? null,
    reason: row.reason, actor: row.actor, recordedAt: row.recordedAt.toISOString() };
}
function invalid() { return new CashSettlementError('SETTLEMENT_INVALID', 'Use an exact nonnegative amount, matching currency and a reason for corrections', 400); }
function conflict() { return new CashSettlementError('SETTLEMENT_CONFLICT', 'Settlement changed or command identity was reused; refresh before confirming', 409); }
function notFound() { return new CashSettlementError('NOT_FOUND', 'Route or Cash receipt not found', 404); }
