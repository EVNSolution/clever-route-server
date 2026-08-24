import { Prisma, type PrismaClient } from '@prisma/client';
import { normalizeShopDomain } from '../commerce/commerce-connection.repository.js';
import { appScopedShopWhere } from '../shopify/shopify-app-scope.js';

export type OperationalAlertSeverity = 'CRITICAL' | 'WARNING';
export type OperationalAlertDto = {
  acknowledgedAt: string | null;
  id: string;
  lastObservedAt: string;
  openedAt: string;
  resolvedAt: string | null;
  routePlanId: string | null;
  severity: OperationalAlertSeverity;
  type: string;
};

export type OpenOperationalAlertInput = {
  body?: string | null;
  dedupeKey: string;
  href?: string | null;
  observedAt: Date;
  payload?: Prisma.InputJsonValue | null;
  routePlanId?: string | null;
  severity: OperationalAlertSeverity;
  shopId: string;
  title: string;
  type: string;
};

export class PrismaOperationalAlertRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly hooks: {
      beforeLegacyProjection?: () => Promise<void> | void;
      onDualWriteFailure?: (evidence: { errorCode: string; event: 'operational_alert_dual_write_failure'; routePlanId: string | null; shopId: string; type: string }) => void;
    } = {}
  ) {}

  async openOrObserve(input: OpenOperationalAlertInput): Promise<OperationalAlertDto> {
    let failure: unknown;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        return await this.prisma.$transaction((tx) => this.openOrObserveInTransaction(tx, input));
      } catch (error) {
        failure = error;
      }
    }
    const evidence = {
      errorCode: safeDatabaseErrorCode(failure),
      event: 'operational_alert_dual_write_failure' as const,
      routePlanId: input.routePlanId ?? null,
      shopId: input.shopId,
      type: input.type
    };
    if (this.hooks.onDualWriteFailure !== undefined) this.hooks.onDualWriteFailure(evidence);
    else process.stderr.write(`${JSON.stringify(evidence)}\n`);
    throw failure;
  }

  private async openOrObserveInTransaction(
    tx: Prisma.TransactionClient,
    input: OpenOperationalAlertInput
  ): Promise<OperationalAlertDto> {
    await lockAlertIdentity(tx, input.shopId, input.dedupeKey);
    const condition = await tx.alertCondition.upsert({
      create: {
        dedupeKey: input.dedupeKey,
        routePlanId: input.routePlanId ?? null,
        shopId: input.shopId,
        type: input.type
      },
      update: { routePlanId: input.routePlanId ?? null, type: input.type },
      where: { shopId_dedupeKey: { dedupeKey: input.dedupeKey, shopId: input.shopId } }
    });
    const active = await tx.alertCycle.findFirst({
      where: { conditionId: condition.id, resolvedAt: null }
    });
    await this.hooks.beforeLegacyProjection?.();
    const legacy = await tx.adminNotification.upsert({
      create: {
        body: input.body ?? null,
        dedupeKey: input.dedupeKey,
        href: input.href ?? null,
        ...(input.payload === undefined || input.payload === null ? {} : { payload: input.payload }),
        readAt: null,
        routePlanId: input.routePlanId ?? null,
        severity: input.severity === 'CRITICAL' ? 'critical' : 'warning',
        shopId: input.shopId,
        title: input.title,
        type: input.type
      },
      update: {
        body: input.body ?? null,
        href: input.href ?? null,
        ...(input.payload === undefined || input.payload === null ? {} : { payload: input.payload }),
        ...(active === null ? { readAt: null } : {}),
        routePlanId: input.routePlanId ?? null,
        severity: input.severity === 'CRITICAL' ? 'critical' : 'warning',
        title: input.title,
        type: input.type,
        updatedAt: input.observedAt
      },
      where: { shopId_dedupeKey: { dedupeKey: input.dedupeKey, shopId: input.shopId } }
    });
    const retainedUntil = new Date(input.observedAt.getTime() + 365 * 24 * 60 * 60 * 1000);
    const cycle = active === null
      ? await tx.alertCycle.create({
          data: {
            conditionId: condition.id,
            lastObservedAt: input.observedAt,
            legacyNotificationId: legacy.id,
            openedAt: input.observedAt,
            ...(input.payload === undefined || input.payload === null ? {} : { payload: input.payload }),
            retainedUntil,
            severity: input.severity
          }
        })
      : await tx.alertCycle.update({
          data: {
            lastObservedAt: input.observedAt,
            ...(input.payload === undefined || input.payload === null ? {} : { payload: input.payload }),
            retainedUntil,
            severity: moreSevere(active.severity, input.severity)
          },
          where: { id: active.id }
        });
    return toDto(cycle, condition.routePlanId, condition.type);
  }

  async acknowledge(input: { actor: string; alertId: string; shopDomain: string }): Promise<OperationalAlertDto | null> {
    const shop = await this.findShop(input.shopDomain);
    if (shop === null) return null;
    const current = await this.prisma.alertCycle.findFirst({
      include: { condition: true },
      where: { condition: { shopId: shop.id }, id: input.alertId, resolvedAt: null }
    });
    if (current === null) return null;
    const cycle = await this.prisma.alertCycle.update({
      data: { acknowledgedAt: current.acknowledgedAt ?? new Date(), acknowledgedBy: input.actor },
      where: { id: current.id }
    });
    return toDto(cycle, current.condition.routePlanId, current.condition.type);
  }

  async resolve(input: { alertId: string; resolutionCode: string; resolvedAt?: Date; shopId: string }): Promise<boolean> {
    const resolvedAt = input.resolvedAt ?? new Date();
    return await this.prisma.$transaction(async (tx) => {
      const current = await tx.alertCycle.findFirst({
        select: { condition: { select: { dedupeKey: true } } },
        where: { condition: { shopId: input.shopId }, id: input.alertId, resolvedAt: null }
      });
      if (current === null) return false;
      await lockAlertIdentity(tx, input.shopId, current.condition.dedupeKey);
      const result = await tx.alertCycle.updateMany({
        data: { resolutionCode: input.resolutionCode, resolvedAt },
        where: {
          condition: { shopId: input.shopId },
          id: input.alertId,
          lastObservedAt: { lte: resolvedAt },
          resolvedAt: null
        }
      });
      return result.count === 1;
    });
  }

  async resolveByDedupeKey(input: { dedupeKey: string; resolutionCode: string; resolvedAt?: Date; shopId: string }): Promise<boolean> {
    const resolvedAt = input.resolvedAt ?? new Date();
    return await this.prisma.$transaction(async (tx) => {
      await lockAlertIdentity(tx, input.shopId, input.dedupeKey);
      const result = await tx.alertCycle.updateMany({
        data: { resolutionCode: input.resolutionCode, resolvedAt },
        where: {
          condition: { dedupeKey: input.dedupeKey, shopId: input.shopId },
          lastObservedAt: { lte: resolvedAt },
          resolvedAt: null
        }
      });
      return result.count === 1;
    });
  }

  async listActiveForShopDomain(shopDomain: string): Promise<OperationalAlertDto[]> {
    const shop = await this.findShop(shopDomain);
    if (shop === null) return [];
    const cycles = await this.prisma.alertCycle.findMany({
      include: { condition: true },
      orderBy: [{ severity: 'desc' }, { openedAt: 'asc' }],
      where: { condition: { shopId: shop.id }, resolvedAt: null }
    });
    return cycles
      .map((cycle) => toDto(cycle, cycle.condition.routePlanId, cycle.condition.type))
      .sort(compareWorstAlertFirst);
  }

  async listActiveForRoutePlan(routePlanId: string): Promise<OperationalAlertDto[]> {
    return (await this.listActiveForRoutePlans([routePlanId])).get(routePlanId) ?? [];
  }

  async listActiveForRoutePlans(routePlanIds: string[]): Promise<Map<string, OperationalAlertDto[]>> {
    if (routePlanIds.length === 0) return new Map();
    const cycles = await this.prisma.alertCycle.findMany({
      include: { condition: true },
      orderBy: [{ severity: 'desc' }, { openedAt: 'asc' }],
      where: { condition: { routePlanId: { in: routePlanIds } }, resolvedAt: null }
    });
    const byRoutePlan = new Map<string, OperationalAlertDto[]>();
    for (const cycle of cycles) {
      const routePlanId = cycle.condition.routePlanId;
      if (routePlanId === null) continue;
      const alerts = byRoutePlan.get(routePlanId) ?? [];
      alerts.push(toDto(cycle, routePlanId, cycle.condition.type));
      byRoutePlan.set(routePlanId, alerts);
    }
    for (const alerts of byRoutePlan.values()) alerts.sort(compareWorstAlertFirst);
    return byRoutePlan;
  }

  private findShop(shopDomain: string): Promise<{ id: string } | null> {
    return this.prisma.shop.findUnique({
      select: { id: true },
      where: appScopedShopWhere({ shopDomain: normalizeShopDomain(shopDomain) })
    });
  }
}

async function lockAlertIdentity(tx: Prisma.TransactionClient, shopId: string, dedupeKey: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${`${shopId}:${dedupeKey}`}, 0))::text AS "lock"
  `);
}

function moreSevere(current: string, next: OperationalAlertSeverity): OperationalAlertSeverity {
  return current === 'CRITICAL' || next === 'CRITICAL' ? 'CRITICAL' : 'WARNING';
}

function compareWorstAlertFirst(left: OperationalAlertDto, right: OperationalAlertDto): number {
  const severity = (left.severity === 'CRITICAL' ? 0 : 1) - (right.severity === 'CRITICAL' ? 0 : 1);
  return severity !== 0 ? severity : left.openedAt.localeCompare(right.openedAt);
}

function toDto(
  cycle: { acknowledgedAt: Date | null; id: string; lastObservedAt: Date; openedAt: Date; resolvedAt: Date | null; severity: string },
  routePlanId: string | null,
  type: string
): OperationalAlertDto {
  return {
    acknowledgedAt: cycle.acknowledgedAt?.toISOString() ?? null,
    id: cycle.id,
    lastObservedAt: cycle.lastObservedAt.toISOString(),
    openedAt: cycle.openedAt.toISOString(),
    resolvedAt: cycle.resolvedAt?.toISOString() ?? null,
    routePlanId,
    severity: cycle.severity === 'CRITICAL' ? 'CRITICAL' : 'WARNING',
    type
  };
}

function safeDatabaseErrorCode(error: unknown): string {
  if (error instanceof Prisma.PrismaClientKnownRequestError && /^[A-Z0-9]{4,8}$/u.test(error.code)) return error.code;
  return 'OPERATIONAL_ALERT_DUAL_WRITE_FAILED';
}
