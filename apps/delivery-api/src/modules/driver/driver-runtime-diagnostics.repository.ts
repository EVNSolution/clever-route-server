import { createHash, randomBytes } from 'node:crypto';

import { Prisma, type DriverEventAttempt, type DriverRuntimeDiagnosticRecord as StoredDiagnosticRecord, type PrismaClient } from '@prisma/client';

import type {
  DriverDiagnosticContext,
  DriverDiagnosticEnvelope,
  DriverDiagnosticRecord,
  DriverDiagnosticSnapshot,
} from './driver-runtime-diagnostics.contract.js';
import { parseDriverDiagnosticSnapshot } from './driver-runtime-diagnostics.contract.js';

const credentialTtlMs = 24 * 60 * 60 * 1_000;
const retentionMs = 30 * 24 * 60 * 60 * 1_000;
const futureEvidenceToleranceMs = 30_000;
const shopDeviceLimit = 100;
const shopRecordLimit = 25;
const shopAttemptLimit = 100;

export type DriverRuntimeDiagnosticCredential = {
  accountId: string;
  deviceId: string;
  deviceInstanceHash: string;
  expiresAt: Date;
  id: string;
};

export type DriverRuntimeDiagnosticRejectionCode =
  | 'DEVICE_MISMATCH'
  | 'DIAGNOSTIC_ID_CONFLICT'
  | 'ROUTE_ACCESS_REVOKED';

export type DriverRuntimeDiagnosticIngestResult = {
  acceptedDiagnosticIds: string[];
  rejectedDiagnostics: Array<{ code: DriverRuntimeDiagnosticRejectionCode; diagnosticId: string }>;
  serverReceivedAt: Date;
};

export type DriverRuntimeDiagnosticAttempt = {
  clientEventId: string | null;
  clientRequestId: string | null;
  errorCode: string | null;
  id: string;
  receivedAt: Date;
  requestId: string | null;
  status: 'APPLIED' | 'DUPLICATE' | 'FAILED' | 'REJECTED';
};

export type DriverRuntimeDiagnosticShopDevice = {
  deviceInstanceHash: string;
  driverId: string;
  lastScopedContactAt: Date | null;
  lastIngestionFailureAt: Date | null;
  lastIngestionFailureCode: string | null;
  latestSnapshot: {
    context: DriverDiagnosticContext;
    discardedRecordCount: number;
    firstObservedAt: Date;
    receivedAt: Date;
    snapshot: DriverDiagnosticSnapshot;
    snapshotObservedAt: Date;
  } | null;
  records: Array<{
    batchId: string;
    context: DriverDiagnosticContext;
    diagnosticId: string;
    identifiers: { clientEventId?: string; requestId?: string } | null;
    isHistoricalReplay: boolean;
    kind: string;
    observedAt: Date;
    receivedAt: Date;
    snapshot: DriverDiagnosticSnapshot;
  }>;
  attemptsTruncated: boolean;
  recordsTruncated: boolean;
  routePlanId: string;
  attempts: DriverRuntimeDiagnosticAttempt[];
};

export type DriverRuntimeDiagnosticShopView = {
  devices: DriverRuntimeDiagnosticShopDevice[];
  shopId: string;
  truncated: boolean;
};

type RouteScope = {
  driverId: string;
  routePlanId: string;
  shopId: string;
};

type DiagnosticSnapshotAnchor = {
  context: Prisma.JsonValue;
  deviceId: string;
  deviceInstanceHash: string;
  discardedRecordCount: number;
  driverId: string;
  firstObservedAt: Date;
  id: string;
  lastIngestionFailureAt: Date | null;
  lastIngestionFailureCode: string | null;
  lastScopedContactAt: Date;
  routeLastIngestionFailureAt: Date | null;
  routeLastIngestionFailureCode: string | null;
  routeLastScopedContactAt: Date;
  receivedAt: Date;
  routePlanId: string;
  snapshot: Prisma.JsonValue;
  snapshotObservedAt: Date;
  snapshotTimeValid: boolean;
};

type DiagnosticRecordAnchor = StoredDiagnosticRecord & {
  deviceInstanceHash: string;
  driverId: string;
  routePlanId: string;
};

type ScopedDriverEventAttempt = DriverEventAttempt & {
  diagnosticDeviceId: string;
};

type RepositoryOptions = {
  now?: () => Date;
  token?: () => string;
};

export class DriverRuntimeDiagnosticsError extends Error {
  constructor(
    readonly code: 'DEVICE_MISMATCH' | 'DRIVER_SCOPE_REJECTED' | 'FUTURE_SNAPSHOT',
    message: string,
  ) {
    super(message);
    this.name = 'DriverRuntimeDiagnosticsError';
  }
}

export class PrismaDriverRuntimeDiagnosticsRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly options: RepositoryOptions = {},
  ) {}

  async register(input: {
    accountId: string;
    deviceInstanceHash: string;
    tokenVersion: number;
  }): Promise<{ expiresAt: Date; token: string } | null> {
    const now = this.now();
    const expiresAt = new Date(now.getTime() + credentialTtlMs);
    const token = this.options.token?.() ?? randomBytes(32).toString('base64url');
    const tokenHash = hashToken(token);

    const credentialId = await this.prisma.$transaction(async (tx) => {
      const account = await tx.driverAccount.findFirst({
        select: { id: true },
        where: { id: input.accountId, status: 'ACTIVE', tokenVersion: input.tokenVersion },
      });
      if (account === null) return null;

      const device = await tx.driverRuntimeDiagnosticDevice.upsert({
        create: {
          accountId: input.accountId,
          deviceInstanceHash: input.deviceInstanceHash,
        },
        update: {},
        where: {
          accountId_deviceInstanceHash: {
            accountId: input.accountId,
            deviceInstanceHash: input.deviceInstanceHash,
          },
        },
      });
      const credential = await tx.driverRuntimeDiagnosticCredential.create({
        data: {
          accountTokenVersion: input.tokenVersion,
          createdAt: now,
          deviceId: device.id,
          expiresAt,
          tokenHash,
        },
        select: { id: true },
      });
      return credential.id;
    });

    return credentialId === null ? null : { expiresAt, token };
  }

  async authenticate(tokenValue: string): Promise<DriverRuntimeDiagnosticCredential | null> {
    const token = normalizeToken(tokenValue);
    if (token === null) return null;
    const now = this.now();
    const credential = await this.prisma.driverRuntimeDiagnosticCredential.findUnique({
      include: {
        device: {
          include: { account: { select: { status: true, tokenVersion: true } } },
        },
      },
      where: { tokenHash: hashToken(token) },
    });
    if (
      credential === null
      || credential.revokedAt !== null
      || credential.expiresAt.getTime() <= now.getTime()
      || credential.device.account.status !== 'ACTIVE'
      || credential.device.account.tokenVersion !== credential.accountTokenVersion
    ) return null;

    await this.prisma.driverRuntimeDiagnosticCredential.updateMany({
      data: { lastAuthenticatedAt: now },
      where: { id: credential.id, revokedAt: null },
    });
    return {
      accountId: credential.device.accountId,
      deviceId: credential.deviceId,
      deviceInstanceHash: credential.device.deviceInstanceHash,
      expiresAt: credential.expiresAt,
      id: credential.id,
    };
  }

  async recordContact(credential: DriverRuntimeDiagnosticCredential): Promise<void> {
    const now = this.now();
    await this.prisma.driverRuntimeDiagnosticDevice.updateMany({
      data: { lastContactAt: now },
      where: { accountId: credential.accountId, id: credential.deviceId },
    });
  }

  async recordFailure(
    credential: DriverRuntimeDiagnosticCredential,
    code: string,
    envelope?: DriverDiagnosticEnvelope,
  ): Promise<void> {
    const now = this.now();
    await this.prisma.$transaction(async (tx) => {
      await tx.driverRuntimeDiagnosticDevice.updateMany({
        data: { lastContactAt: now, lastFailureAt: now, lastFailureCode: code },
        where: { accountId: credential.accountId, id: credential.deviceId },
      });
      if (
        envelope === undefined
        || envelope.liveContext.deviceInstanceHash !== credential.deviceInstanceHash
        || envelope.liveContext.routePlanId === null
      ) return;
      const routeScope = await tx.routePlan.findFirst({
        select: { driverId: true, id: true, shopId: true },
        where: {
          driver: { is: { accountId: credential.accountId } },
          id: envelope.liveContext.routePlanId,
        },
      });
      if (routeScope?.driverId == null) return;
      await tx.driverRuntimeDiagnosticSnapshot.updateMany({
        data: {
          lastIngestionFailureAt: now,
          lastIngestionFailureCode: code,
          lastScopedContactAt: now,
        },
        where: {
          deviceId: credential.deviceId,
          driverId: routeScope.driverId,
          expiresAt: { gt: now },
          routePlanId: routeScope.id,
          scopeKey: diagnosticScopeKey(envelope),
          shopId: routeScope.shopId,
        },
      });
    });
  }

  async revoke(input: {
    accountId: string;
    deviceInstanceHash: string;
    tokenVersion: number;
  }): Promise<{ revokedCount: number } | null> {
    const now = this.now();
    return this.prisma.$transaction(async (tx) => {
      const account = await tx.driverAccount.findFirst({
        select: { id: true },
        where: { id: input.accountId, status: 'ACTIVE', tokenVersion: input.tokenVersion },
      });
      if (account === null) return null;
      const device = await tx.driverRuntimeDiagnosticDevice.findUnique({
        select: { id: true },
        where: {
          accountId_deviceInstanceHash: {
            accountId: input.accountId,
            deviceInstanceHash: input.deviceInstanceHash,
          },
        },
      });
      if (device === null) return { revokedCount: 0 };
      const result = await tx.driverRuntimeDiagnosticCredential.updateMany({
        data: { revokedAt: now },
        where: { deviceId: device.id, expiresAt: { gt: now }, revokedAt: null },
      });
      return { revokedCount: result.count };
    });
  }

  async ingest(
    credential: DriverRuntimeDiagnosticCredential,
    envelope: DriverDiagnosticEnvelope,
  ): Promise<DriverRuntimeDiagnosticIngestResult> {
    const serverReceivedAt = this.now();
    const expiresAt = new Date(serverReceivedAt.getTime() + retentionMs);
    if (envelope.liveContext.deviceInstanceHash !== credential.deviceInstanceHash) {
      throw new DriverRuntimeDiagnosticsError('DEVICE_MISMATCH', 'Diagnostic device identity does not match credential');
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const routeScopeCache = new Map<string, RouteScope | null>();
      const resolveRouteScope = async (routePlanId: string | null): Promise<RouteScope | null> => {
        if (routePlanId === null) return null;
        const cached = routeScopeCache.get(routePlanId);
        if (cached !== undefined) return cached;
        const routePlan = await tx.routePlan.findFirst({
          select: { driverId: true, id: true, shopId: true },
          where: {
            driver: { is: { accountId: credential.accountId } },
            id: routePlanId,
          },
        });
        const scope = routePlan?.driverId === null || routePlan?.driverId === undefined
          ? null
          : { driverId: routePlan.driverId, routePlanId: routePlan.id, shopId: routePlan.shopId };
        routeScopeCache.set(routePlanId, scope);
        return scope;
      };
      const resolveHistoricalRouteScope = async (
        routePlanId: string,
        observedAt: Date,
      ): Promise<RouteScope | null> => {
        const matchingSnapshots = await tx.driverRuntimeDiagnosticSnapshot.findMany({
          orderBy: [{ snapshotObservedAt: 'desc' }, { id: 'desc' }],
          take: 20,
          select: {
            driverId: true,
            firstObservedAt: true,
            routePlanId: true,
            shopId: true,
            snapshotObservedAt: true,
          },
          where: {
            deviceId: credential.deviceId,
            driverId: { not: null },
            expiresAt: { gt: serverReceivedAt },
            firstObservedAt: { lte: new Date(observedAt.getTime() + futureEvidenceToleranceMs) },
            routePlanId,
            shopId: { not: null },
            snapshotObservedAt: { gte: new Date(observedAt.getTime() - futureEvidenceToleranceMs) },
            snapshotTimeValid: true,
          },
        });
        const latestSnapshot = matchingSnapshots[0];
        if (
          latestSnapshot?.driverId != null
          && latestSnapshot.routePlanId !== null
          && latestSnapshot.shopId !== null
        ) {
          return {
            driverId: latestSnapshot.driverId,
            routePlanId: latestSnapshot.routePlanId,
            shopId: latestSnapshot.shopId,
          };
        }
        const syncSession = await tx.driverSyncSession.findFirst({
          orderBy: [{ lastObservedAt: 'desc' }, { id: 'desc' }],
          select: { driverId: true, firstObservedAt: true, lastObservedAt: true, routePlanId: true, shopId: true },
          where: {
            deviceInstanceHash: credential.deviceInstanceHash,
            driver: { is: { accountId: credential.accountId } },
            firstObservedAt: { lte: new Date(observedAt.getTime() + futureEvidenceToleranceMs) },
            lastObservedAt: { gte: new Date(observedAt.getTime() - futureEvidenceToleranceMs) },
            routePlanId,
          },
        });
        if (
          syncSession !== null
        ) {
          return {
            driverId: syncSession.driverId,
            routePlanId: syncSession.routePlanId,
            shopId: syncSession.shopId,
          };
        }
        return null;
      };

      const liveRouteScope = await resolveRouteScope(envelope.liveContext.routePlanId);
      const liveRouteAuthorized = envelope.liveContext.routePlanId === null || liveRouteScope !== null;
      if (!liveRouteAuthorized) {
        throw new DriverRuntimeDiagnosticsError('DRIVER_SCOPE_REJECTED', 'Diagnostic route is not owned by this account');
      }
      const snapshotObservedAt = new Date(envelope.liveSnapshot.snapshotObservedAt);
      const futureSnapshot = snapshotObservedAt.getTime() > serverReceivedAt.getTime() + futureEvidenceToleranceMs;
      await upsertLiveSnapshot(tx, {
        context: envelope.liveContext,
        deviceId: credential.deviceId,
        envelope,
        expiresAt,
        routeScope: liveRouteScope,
        serverReceivedAt,
        snapshotObservedAt,
        futureSnapshot,
      });

      const acceptedDiagnosticIds: string[] = [];
      const rejectedDiagnostics: DriverRuntimeDiagnosticIngestResult['rejectedDiagnostics'] = [];
      for (const record of envelope.records) {
        if (record.context.deviceInstanceHash !== credential.deviceInstanceHash) {
          rejectedDiagnostics.push({ code: 'DEVICE_MISMATCH', diagnosticId: record.diagnosticId });
          continue;
        }
        const currentRouteScope = await resolveRouteScope(record.context.routePlanId);
        const historicalRouteScope = record.context.routePlanId === null || currentRouteScope !== null
          ? null
          : await resolveHistoricalRouteScope(record.context.routePlanId, new Date(record.observedAt));
        const routeScope = currentRouteScope ?? historicalRouteScope;
        if (record.context.routePlanId !== null && routeScope === null) {
          rejectedDiagnostics.push({ code: 'ROUTE_ACCESS_REVOKED', diagnosticId: record.diagnosticId });
          continue;
        }
        const payloadHash = hashPayload(record);
        const inserted = await insertRecord(tx, {
          batchId: envelope.batchId,
          deviceId: credential.deviceId,
          envelope,
          expiresAt,
          payloadHash,
          record,
          routeScope,
          isHistoricalReplay: historicalRouteScope !== null,
          serverReceivedAt,
        });
        const stored = await tx.driverRuntimeDiagnosticRecord.findUniqueOrThrow({
          select: { payloadHash: true },
          where: {
            deviceId_diagnosticId: {
              deviceId: credential.deviceId,
              diagnosticId: record.diagnosticId,
            },
          },
        });
        if (inserted || stored.payloadHash === payloadHash) {
          acceptedDiagnosticIds.push(record.diagnosticId);
        } else {
          rejectedDiagnostics.push({ code: 'DIAGNOSTIC_ID_CONFLICT', diagnosticId: record.diagnosticId });
        }
      }
      return { acceptedDiagnosticIds, rejectedDiagnostics };
    });

    return { ...result, serverReceivedAt };
  }

  async listForShop(input: {
    appId: string;
    diagnosticId?: string;
    routePlanId?: string;
    shopDomain: string;
  }): Promise<DriverRuntimeDiagnosticShopView | null> {
    const shop = await this.prisma.shop.findUnique({
      select: { id: true },
      where: { appId_shopDomain: { appId: input.appId, shopDomain: input.shopDomain } },
    });
    if (shop === null) return null;
    const now = this.now();
    const snapshotRouteFilter = input.routePlanId === undefined
      ? Prisma.empty
      : Prisma.sql`AND snapshot."routePlanId" = ${input.routePlanId}::uuid`;
    const recordRouteFilter = input.routePlanId === undefined
      ? Prisma.empty
      : Prisma.sql`AND record."routePlanId" = ${input.routePlanId}::uuid`;
    const recordDiagnosticFilter = input.diagnosticId === undefined
      ? Prisma.empty
      : Prisma.sql`AND record."diagnosticId" = ${input.diagnosticId}::uuid AND record."kind" = 'USER_REPORT'`;
    const snapshotDiagnosticFilter = input.diagnosticId === undefined
      ? Prisma.empty
      : Prisma.sql`AND EXISTS (
          SELECT 1 FROM "driver_runtime_diagnostic_records" record
          WHERE record."deviceId" = snapshot."deviceId"
            AND record."routePlanId" = snapshot."routePlanId"
            AND record."shopId" = snapshot."shopId"
            AND record."diagnosticId" = ${input.diagnosticId}::uuid
            AND record."kind" = 'USER_REPORT'
            AND record."expiresAt" > ${now}
        )`;
    const snapshots = await this.prisma.$queryRaw<DiagnosticSnapshotAnchor[]>(Prisma.sql`
      WITH scoped AS (
        SELECT snapshot.*, device."deviceInstanceHash",
          ROW_NUMBER() OVER (
            PARTITION BY snapshot."deviceId", snapshot."routePlanId"
            ORDER BY snapshot."snapshotTimeValid" DESC, snapshot."snapshotObservedAt" DESC,
              snapshot."receivedAt" DESC, snapshot."id" DESC
          ) AS "snapshotRank"
        FROM "driver_runtime_diagnostic_snapshots" snapshot
        JOIN "driver_runtime_diagnostic_devices" device ON device."id" = snapshot."deviceId"
        WHERE snapshot."shopId" = ${shop.id}::uuid
          AND snapshot."routePlanId" IS NOT NULL
          AND snapshot."driverId" IS NOT NULL
          AND snapshot."expiresAt" > ${now}
          ${snapshotRouteFilter}
          ${snapshotDiagnosticFilter}
      ), route_state AS (
        SELECT scoped."deviceId", scoped."routePlanId",
          MAX(scoped."lastScopedContactAt") AS "routeLastScopedContactAt",
          (ARRAY_AGG(scoped."lastIngestionFailureAt" ORDER BY scoped."lastIngestionFailureAt" DESC)
            FILTER (WHERE scoped."lastIngestionFailureAt" IS NOT NULL))[1] AS "latestFailureAt",
          (ARRAY_AGG(scoped."lastIngestionFailureCode" ORDER BY scoped."lastIngestionFailureAt" DESC)
            FILTER (WHERE scoped."lastIngestionFailureAt" IS NOT NULL))[1] AS "latestFailureCode"
        FROM scoped GROUP BY scoped."deviceId", scoped."routePlanId"
      )
      SELECT chosen.*, state."routeLastScopedContactAt",
        CASE WHEN state."latestFailureAt" >= chosen."receivedAt"
          THEN state."latestFailureAt" ELSE NULL END AS "routeLastIngestionFailureAt",
        CASE WHEN state."latestFailureAt" >= chosen."receivedAt"
          THEN state."latestFailureCode" ELSE NULL END AS "routeLastIngestionFailureCode"
      FROM scoped chosen
      JOIN route_state state ON state."deviceId" = chosen."deviceId"
        AND state."routePlanId" = chosen."routePlanId"
      WHERE chosen."snapshotRank" = 1
      ORDER BY chosen."snapshotTimeValid" DESC, chosen."snapshotObservedAt" DESC,
        chosen."receivedAt" DESC, chosen."id" DESC
      LIMIT ${shopDeviceLimit + 1}
    `);
    const historicalRecords = await this.prisma.$queryRaw<DiagnosticRecordAnchor[]>(Prisma.sql`
      WITH scoped AS (
        SELECT record.*, device."deviceInstanceHash",
          ROW_NUMBER() OVER (
            PARTITION BY record."deviceId", record."routePlanId"
            ORDER BY record."observedAt" DESC, record."id" DESC
          ) AS rank
        FROM "driver_runtime_diagnostic_records" record
        JOIN "driver_runtime_diagnostic_devices" device ON device."id" = record."deviceId"
        WHERE record."shopId" = ${shop.id}::uuid
          AND record."routePlanId" IS NOT NULL
          AND record."driverId" IS NOT NULL
          AND record."expiresAt" > ${now}
          ${recordRouteFilter}
          ${recordDiagnosticFilter}
          AND NOT EXISTS (
            SELECT 1 FROM "driver_runtime_diagnostic_snapshots" snapshot
            WHERE snapshot."deviceId" = record."deviceId"
              AND snapshot."routePlanId" = record."routePlanId"
              AND snapshot."shopId" = record."shopId"
              AND snapshot."expiresAt" > ${now}
          )
      )
      SELECT * FROM scoped WHERE scoped.rank = 1
      ORDER BY scoped."observedAt" DESC, scoped."id" DESC
      LIMIT ${shopDeviceLimit + 1}
    `);
    const anchors = [
      ...snapshots.map((snapshot) => ({
        contactAt: snapshot.snapshotTimeValid ? snapshot.snapshotObservedAt : snapshot.receivedAt,
        snapshot,
      })),
      ...historicalRecords.map((record) => ({ contactAt: record.observedAt, record })),
    ].sort((left, right) => right.contactAt.getTime() - left.contactAt.getTime());
    const truncated = snapshots.length > shopDeviceLimit
      || historicalRecords.length > shopDeviceLimit
      || anchors.length > shopDeviceLimit;
    const selectedAnchors = anchors.slice(0, shopDeviceLimit);
    const scopeClauses = selectedAnchors.map((anchor) => {
      const value = 'snapshot' in anchor ? anchor.snapshot : anchor.record;
      return Prisma.sql`(record."deviceId" = ${value.deviceId}::uuid AND record."routePlanId" = ${value.routePlanId}::uuid)`;
    });
    const allRecords = scopeClauses.length === 0 ? [] : await this.prisma.$queryRaw<StoredDiagnosticRecord[]>(Prisma.sql`
      WITH ranked AS (
        SELECT record.*, ROW_NUMBER() OVER (
          PARTITION BY record."deviceId", record."routePlanId"
          ORDER BY record."observedAt" DESC, record."id" DESC
        ) AS rank
        FROM "driver_runtime_diagnostic_records" record
        WHERE record."shopId" = ${shop.id}::uuid AND record."expiresAt" > ${now}
          AND (${Prisma.join(scopeClauses, ' OR ')})
          ${recordDiagnosticFilter}
      )
      SELECT * FROM ranked WHERE ranked.rank <= ${shopRecordLimit + 1}
    `);
    const recordsByScope = groupByScope(allRecords);
    const evidenceByScope = new Map<string, { clientEventIds: string[]; requestIds: string[] }>();
    for (const anchor of selectedAnchors) {
      const value = 'snapshot' in anchor ? anchor.snapshot : anchor.record;
      const records = recordsByScope.get(scopeIdentity(value.deviceId, value.routePlanId)) ?? [];
      const snapshot = 'snapshot' in anchor ? parseDriverDiagnosticSnapshot(anchor.snapshot.snapshot) : null;
      evidenceByScope.set(scopeIdentity(value.deviceId, value.routePlanId), {
        clientEventIds: uniqueStrings([
          ...records.flatMap((record) => readIdentifier(record.identifiers, 'clientEventId')),
          ...(snapshot === null ? [] : readSnapshotBlockerIdentifiers(snapshot, 'clientEventId')),
        ]),
        requestIds: uniqueStrings([
          ...records.flatMap((record) => readIdentifier(record.identifiers, 'requestId')),
          ...(snapshot === null ? [] : readSnapshotBlockerIdentifiers(snapshot, 'requestId')),
        ]),
      });
    }
    const attemptScopes = selectedAnchors.flatMap((anchor) => {
      const value = 'snapshot' in anchor ? anchor.snapshot : anchor.record;
      const evidence = evidenceByScope.get(scopeIdentity(value.deviceId, value.routePlanId));
      if (evidence === undefined || (evidence.clientEventIds.length === 0 && evidence.requestIds.length === 0)) return [];
      const clientEventIds = evidence.clientEventIds.length === 0
        ? Prisma.sql`ARRAY[]::text[]`
        : Prisma.sql`ARRAY[${Prisma.join(evidence.clientEventIds)}]::text[]`;
      const requestIds = evidence.requestIds.length === 0
        ? Prisma.sql`ARRAY[]::text[]`
        : Prisma.sql`ARRAY[${Prisma.join(evidence.requestIds)}]::text[]`;
      return [Prisma.sql`(${value.deviceId}::uuid, ${value.driverId}::uuid, ${value.routePlanId}::uuid,
        ${clientEventIds}, ${requestIds})`];
    });
    const allAttempts = attemptScopes.length === 0 ? [] : await this.prisma.$queryRaw<ScopedDriverEventAttempt[]>(Prisma.sql`
      WITH scopes("diagnosticDeviceId", "driverId", "routePlanId", "clientEventIds", "requestIds") AS (
        VALUES ${Prisma.join(attemptScopes)}
      )
      SELECT attempt.*, scope."diagnosticDeviceId"
      FROM scopes scope
      CROSS JOIN LATERAL (
        SELECT attempt.* FROM "driver_event_attempts" attempt
        WHERE attempt."driverId" = scope."driverId"
          AND attempt."shopId" = ${shop.id}::uuid
          AND attempt."routePlanId" = scope."routePlanId"
          AND attempt."retainedUntil" > ${now}
          AND attempt."status" IN ('APPLIED', 'DUPLICATE', 'FAILED', 'REJECTED')
          AND (attempt."clientEventId" = ANY(scope."clientEventIds")
            OR attempt."transportRequestId" = ANY(scope."requestIds"))
        ORDER BY attempt."receivedAt" DESC, attempt."id" DESC
        LIMIT ${shopAttemptLimit + 1}
      ) attempt
    `);
    const attemptsByScope = groupAttemptsByScope(allAttempts);

    const devices: DriverRuntimeDiagnosticShopDevice[] = [];
    for (const anchor of selectedAnchors) {
      const value = 'snapshot' in anchor ? anchor.snapshot : anchor.record;
      const snapshot = 'snapshot' in anchor ? anchor.snapshot : null;
      const latestSnapshot = snapshot === null ? null : parseDriverDiagnosticSnapshot(snapshot.snapshot);
      if (snapshot !== null && latestSnapshot === null) continue;
      const records = recordsByScope.get(scopeIdentity(value.deviceId, value.routePlanId)) ?? [];
      const attempts = attemptsByScope.get(scopeIdentity(value.deviceId, value.routePlanId)) ?? [];
      const validRecords = records.flatMap((record) => {
        const parsedSnapshot = parseDriverDiagnosticSnapshot(record.snapshot);
        return parsedSnapshot === null ? [] : [{ ...record, parsedSnapshot }];
      });
      devices.push({
        attempts: attempts.slice(0, shopAttemptLimit).map((attempt) => ({
          clientEventId: attempt.clientEventId,
          clientRequestId: attempt.transportRequestId,
          errorCode: attempt.errorCode,
          id: attempt.id,
          receivedAt: attempt.receivedAt,
          requestId: attempt.requestId,
          status: attempt.status as DriverRuntimeDiagnosticAttempt['status'],
        })),
        attemptsTruncated: attempts.length > shopAttemptLimit,
        deviceInstanceHash: value.deviceInstanceHash,
        driverId: value.driverId,
        lastScopedContactAt: snapshot?.routeLastScopedContactAt ?? null,
        lastIngestionFailureAt: snapshot?.routeLastIngestionFailureAt ?? null,
        lastIngestionFailureCode: snapshot?.routeLastIngestionFailureCode ?? null,
        latestSnapshot: snapshot === null || latestSnapshot === null ? null : {
          context: snapshot.context as DriverDiagnosticContext,
          discardedRecordCount: snapshot.discardedRecordCount,
          firstObservedAt: snapshot.firstObservedAt,
          receivedAt: snapshot.receivedAt,
          snapshot: latestSnapshot,
          snapshotObservedAt: snapshot.snapshotObservedAt,
        },
        records: validRecords.slice(0, shopRecordLimit).map((record) => ({
          batchId: record.batchId,
          context: record.context as DriverDiagnosticContext,
          diagnosticId: record.diagnosticId,
          identifiers: readIdentifiers(record.identifiers),
          isHistoricalReplay: record.isHistoricalReplay,
          kind: record.kind,
          observedAt: record.observedAt,
          receivedAt: record.receivedAt,
          snapshot: record.parsedSnapshot,
        })),
        recordsTruncated: records.length > shopRecordLimit,
        routePlanId: value.routePlanId,
      });
    }
    return { devices, shopId: shop.id, truncated };
  }

  async cleanupExpired(input: {
    batchSize?: number;
    deadlineMs?: number;
    now?: Date;
  } = {}): Promise<{
    continuationRequired: boolean;
    credentials: number;
    devices: number;
    records: number;
    snapshots: number;
  }> {
    const batchSize = Math.max(1, Math.min(input.batchSize ?? 500, 5_000));
    const deadlineAt = Date.now() + Math.max(1, Math.min(input.deadlineMs ?? 1_000, 30_000));
    const now = input.now ?? this.now();
    const deleted = { credentials: 0, devices: 0, records: 0, snapshots: 0 };
    let continuationRequired = false;
    while (true) {
      const counts = await this.prisma.$transaction(async (tx) => ({
        credentials: await deleteExpiredCredentials(tx, now, batchSize),
        records: await deleteExpiredRecords(tx, now, batchSize),
        snapshots: await deleteExpiredSnapshots(tx, now, batchSize),
        devices: await deleteExpiredDevices(tx, now, batchSize),
      }));
      deleted.credentials += counts.credentials;
      deleted.devices += counts.devices;
      deleted.records += counts.records;
      deleted.snapshots += counts.snapshots;
      const mayHaveMore = Object.values(counts).some((count) => count === batchSize);
      if (!mayHaveMore) break;
      if (Date.now() >= deadlineAt) {
        continuationRequired = true;
        break;
      }
    }
    return { ...deleted, continuationRequired };
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

async function upsertLiveSnapshot(
  tx: Prisma.TransactionClient,
  input: {
    context: DriverDiagnosticContext;
    deviceId: string;
    envelope: DriverDiagnosticEnvelope;
    expiresAt: Date;
    routeScope: RouteScope | null;
    serverReceivedAt: Date;
    snapshotObservedAt: Date;
    futureSnapshot: boolean;
  },
): Promise<void> {
  const scopeKey = diagnosticScopeKey(input.envelope);
  const context = JSON.stringify(input.context);
  const snapshot = JSON.stringify(input.envelope.liveSnapshot);
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "driver_runtime_diagnostic_snapshots" (
      "id", "deviceId", "scopeKey", "shopId", "driverId", "routePlanId", "bootId",
      "sessionGeneration", "assignmentGeneration", "snapshotObservedAt", "firstObservedAt",
      "lastScopedContactAt", "sentAt", "receivedAt", "context", "snapshot", "expiresAt",
      "lastIngestionFailureAt", "lastIngestionFailureCode", "snapshotTimeValid",
      "discardedRecordCount", "createdAt", "updatedAt"
    ) VALUES (
      gen_random_uuid(), ${input.deviceId}::uuid, ${scopeKey}, ${input.routeScope?.shopId ?? null}::uuid,
      ${input.routeScope?.driverId ?? null}::uuid, ${input.routeScope?.routePlanId ?? null}::uuid,
      ${input.envelope.bootId}::uuid, ${input.context.sessionGeneration},
      ${input.context.assignmentGeneration ?? null}, ${input.snapshotObservedAt}, ${input.serverReceivedAt},
      ${input.serverReceivedAt}, ${new Date(input.envelope.sentAt)}, ${input.serverReceivedAt},
      ${context}::jsonb, ${snapshot}::jsonb, ${input.expiresAt},
      ${input.futureSnapshot ? input.serverReceivedAt : null}, ${input.futureSnapshot ? 'FUTURE_SNAPSHOT' : null},
      ${!input.futureSnapshot}, ${input.envelope.discardedRecordCount},
      ${input.serverReceivedAt}, ${input.serverReceivedAt}
    )
    ON CONFLICT ("deviceId", "scopeKey") DO UPDATE SET
      "lastScopedContactAt" = GREATEST(
        "driver_runtime_diagnostic_snapshots"."lastScopedContactAt",
        EXCLUDED."lastScopedContactAt"
      ),
      "expiresAt" = GREATEST("driver_runtime_diagnostic_snapshots"."expiresAt", EXCLUDED."expiresAt"),
      "lastIngestionFailureAt" = CASE
        WHEN ${input.futureSnapshot} THEN EXCLUDED."lastIngestionFailureAt"
        WHEN EXCLUDED."snapshotTimeValid"
          AND (NOT "driver_runtime_diagnostic_snapshots"."snapshotTimeValid"
            OR EXCLUDED."snapshotObservedAt" > "driver_runtime_diagnostic_snapshots"."snapshotObservedAt")
        THEN NULL ELSE "driver_runtime_diagnostic_snapshots"."lastIngestionFailureAt" END,
      "lastIngestionFailureCode" = CASE
        WHEN ${input.futureSnapshot} THEN EXCLUDED."lastIngestionFailureCode"
        WHEN EXCLUDED."snapshotTimeValid"
          AND (NOT "driver_runtime_diagnostic_snapshots"."snapshotTimeValid"
            OR EXCLUDED."snapshotObservedAt" > "driver_runtime_diagnostic_snapshots"."snapshotObservedAt")
        THEN NULL ELSE "driver_runtime_diagnostic_snapshots"."lastIngestionFailureCode" END,
      "discardedRecordCount" = CASE
        WHEN EXCLUDED."snapshotTimeValid"
          AND (NOT "driver_runtime_diagnostic_snapshots"."snapshotTimeValid"
            OR EXCLUDED."snapshotObservedAt" > "driver_runtime_diagnostic_snapshots"."snapshotObservedAt")
        THEN EXCLUDED."discardedRecordCount"
        ELSE "driver_runtime_diagnostic_snapshots"."discardedRecordCount" END,
      "snapshotObservedAt" = CASE
        WHEN EXCLUDED."snapshotTimeValid"
          AND (NOT "driver_runtime_diagnostic_snapshots"."snapshotTimeValid"
            OR EXCLUDED."snapshotObservedAt" > "driver_runtime_diagnostic_snapshots"."snapshotObservedAt")
        THEN EXCLUDED."snapshotObservedAt" ELSE "driver_runtime_diagnostic_snapshots"."snapshotObservedAt" END,
      "snapshotTimeValid" = CASE
        WHEN EXCLUDED."snapshotTimeValid"
          AND (NOT "driver_runtime_diagnostic_snapshots"."snapshotTimeValid"
            OR EXCLUDED."snapshotObservedAt" > "driver_runtime_diagnostic_snapshots"."snapshotObservedAt")
        THEN TRUE ELSE "driver_runtime_diagnostic_snapshots"."snapshotTimeValid" END,
      "sentAt" = CASE
        WHEN EXCLUDED."snapshotTimeValid"
          AND (NOT "driver_runtime_diagnostic_snapshots"."snapshotTimeValid"
            OR EXCLUDED."snapshotObservedAt" > "driver_runtime_diagnostic_snapshots"."snapshotObservedAt")
        THEN EXCLUDED."sentAt" ELSE "driver_runtime_diagnostic_snapshots"."sentAt" END,
      "receivedAt" = CASE
        WHEN EXCLUDED."snapshotTimeValid"
          AND (NOT "driver_runtime_diagnostic_snapshots"."snapshotTimeValid"
            OR EXCLUDED."snapshotObservedAt" > "driver_runtime_diagnostic_snapshots"."snapshotObservedAt")
        THEN EXCLUDED."receivedAt" ELSE "driver_runtime_diagnostic_snapshots"."receivedAt" END,
      "context" = CASE
        WHEN EXCLUDED."snapshotTimeValid"
          AND (NOT "driver_runtime_diagnostic_snapshots"."snapshotTimeValid"
            OR EXCLUDED."snapshotObservedAt" > "driver_runtime_diagnostic_snapshots"."snapshotObservedAt")
        THEN EXCLUDED."context" ELSE "driver_runtime_diagnostic_snapshots"."context" END,
      "snapshot" = CASE
        WHEN EXCLUDED."snapshotTimeValid"
          AND (NOT "driver_runtime_diagnostic_snapshots"."snapshotTimeValid"
            OR EXCLUDED."snapshotObservedAt" > "driver_runtime_diagnostic_snapshots"."snapshotObservedAt")
        THEN EXCLUDED."snapshot" ELSE "driver_runtime_diagnostic_snapshots"."snapshot" END,
      "updatedAt" = EXCLUDED."updatedAt"
  `);
}

async function insertRecord(
  tx: Prisma.TransactionClient,
  input: {
    batchId: string;
    deviceId: string;
    envelope: DriverDiagnosticEnvelope;
    expiresAt: Date;
    payloadHash: string;
    record: DriverDiagnosticRecord;
    routeScope: RouteScope | null;
    isHistoricalReplay: boolean;
    serverReceivedAt: Date;
  },
): Promise<boolean> {
  const count = await tx.$executeRaw(Prisma.sql`
    INSERT INTO "driver_runtime_diagnostic_records" (
      "id", "deviceId", "diagnosticId", "shopId", "driverId", "routePlanId", "batchId", "bootId",
      "sequence", "kind", "observedAt", "sentAt", "receivedAt", "payloadHash", "context", "snapshot",
      "identifiers", "expiresAt", "createdAt", "isHistoricalReplay"
    ) VALUES (
      gen_random_uuid(), ${input.deviceId}::uuid, ${input.record.diagnosticId}::uuid,
      ${input.routeScope?.shopId ?? null}::uuid, ${input.routeScope?.driverId ?? null}::uuid,
      ${input.routeScope?.routePlanId ?? null}::uuid, ${input.batchId}::uuid, ${input.record.bootId}::uuid,
      ${input.record.sequence}, ${input.record.kind}, ${new Date(input.record.observedAt)},
      ${new Date(input.envelope.sentAt)}, ${input.serverReceivedAt}, ${input.payloadHash},
      ${JSON.stringify(input.record.context)}::jsonb, ${JSON.stringify(input.record.snapshot)}::jsonb,
      ${input.record.identifiers === undefined ? null : JSON.stringify(input.record.identifiers)}::jsonb,
      ${input.expiresAt}, ${input.serverReceivedAt}, ${input.isHistoricalReplay}
    )
    ON CONFLICT ("deviceId", "diagnosticId") DO NOTHING
  `);
  return count === 1;
}

async function deleteExpiredCredentials(tx: Prisma.TransactionClient, now: Date, batchSize: number): Promise<number> {
  return tx.$executeRaw(Prisma.sql`
    WITH expired AS (
      SELECT "id" FROM "driver_runtime_diagnostic_credentials"
      WHERE "expiresAt" <= ${now} ORDER BY "expiresAt" ASC LIMIT ${batchSize}
    )
    DELETE FROM "driver_runtime_diagnostic_credentials" target USING expired
    WHERE target."id" = expired."id"
  `);
}

async function deleteExpiredRecords(tx: Prisma.TransactionClient, now: Date, batchSize: number): Promise<number> {
  return tx.$executeRaw(Prisma.sql`
    WITH expired AS (
      SELECT "id" FROM "driver_runtime_diagnostic_records"
      WHERE "expiresAt" <= ${now} ORDER BY "expiresAt" ASC LIMIT ${batchSize}
    )
    DELETE FROM "driver_runtime_diagnostic_records" target USING expired
    WHERE target."id" = expired."id"
  `);
}

async function deleteExpiredDevices(tx: Prisma.TransactionClient, now: Date, batchSize: number): Promise<number> {
  const staleBefore = new Date(now.getTime() - retentionMs);
  return tx.$executeRaw(Prisma.sql`
    WITH expired AS (
      SELECT device."id" FROM "driver_runtime_diagnostic_devices" device
      WHERE COALESCE(device."lastContactAt", device."createdAt") <= ${staleBefore}
        AND NOT EXISTS (SELECT 1 FROM "driver_runtime_diagnostic_credentials" credential WHERE credential."deviceId" = device."id")
        AND NOT EXISTS (SELECT 1 FROM "driver_runtime_diagnostic_records" record WHERE record."deviceId" = device."id")
        AND NOT EXISTS (SELECT 1 FROM "driver_runtime_diagnostic_snapshots" snapshot WHERE snapshot."deviceId" = device."id")
      ORDER BY COALESCE(device."lastContactAt", device."createdAt") ASC LIMIT ${batchSize}
    )
    DELETE FROM "driver_runtime_diagnostic_devices" target USING expired
    WHERE target."id" = expired."id"
  `);
}

async function deleteExpiredSnapshots(tx: Prisma.TransactionClient, now: Date, batchSize: number): Promise<number> {
  return tx.$executeRaw(Prisma.sql`
    WITH expired AS (
      SELECT "id" FROM "driver_runtime_diagnostic_snapshots"
      WHERE "expiresAt" <= ${now} ORDER BY "expiresAt" ASC LIMIT ${batchSize}
    )
    DELETE FROM "driver_runtime_diagnostic_snapshots" target USING expired
    WHERE target."id" = expired."id"
  `);
}

function hashPayload(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function diagnosticScopeKey(envelope: DriverDiagnosticEnvelope): string {
  return hashPayload({
    assignmentGeneration: envelope.liveContext.assignmentGeneration ?? null,
    bootId: envelope.bootId,
    routePlanId: envelope.liveContext.routePlanId,
    sessionGeneration: envelope.liveContext.sessionGeneration,
  });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function normalizeToken(value: string): string | null {
  const token = value.trim();
  return token.length >= 32 && token.length <= 200 && /^[A-Za-z0-9_-]+$/u.test(token) ? token : null;
}

function readIdentifier(value: Prisma.JsonValue | null, key: 'clientEventId' | 'requestId'): string[] {
  if (value === null || Array.isArray(value) || typeof value !== 'object') return [];
  const candidate = value[key];
  return typeof candidate === 'string' ? [candidate] : [];
}

function readIdentifiers(value: Prisma.JsonValue | null): { clientEventId?: string; requestId?: string } | null {
  const clientEventId = readIdentifier(value, 'clientEventId')[0];
  const requestId = readIdentifier(value, 'requestId')[0];
  if (clientEventId === undefined && requestId === undefined) return null;
  return {
    ...(clientEventId === undefined ? {} : { clientEventId }),
    ...(requestId === undefined ? {} : { requestId }),
  };
}

function readSnapshotBlockerIdentifiers(
  value: unknown,
  key: 'clientEventId' | 'requestId',
): string[] {
  if (value === null || Array.isArray(value) || typeof value !== 'object') return [];
  const blockers = (value as Record<string, unknown>).blockers;
  if (!Array.isArray(blockers)) return [];
  return blockers.flatMap((blocker) => {
    if (blocker === null || Array.isArray(blocker) || typeof blocker !== 'object') return [];
    const candidate = (blocker as Record<string, unknown>)[key];
    return typeof candidate === 'string' ? [candidate] : [];
  });
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function scopeIdentity(deviceId: string, routePlanId: string): string {
  return `${deviceId}:${routePlanId}`;
}

function groupByScope(records: StoredDiagnosticRecord[]): Map<string, StoredDiagnosticRecord[]> {
  const grouped = new Map<string, StoredDiagnosticRecord[]>();
  for (const record of records) {
    if (record.routePlanId === null) continue;
    const key = scopeIdentity(record.deviceId, record.routePlanId);
    const values = grouped.get(key) ?? [];
    values.push(record);
    grouped.set(key, values);
  }
  return grouped;
}

function groupAttemptsByScope(attempts: ScopedDriverEventAttempt[]): Map<string, ScopedDriverEventAttempt[]> {
  const grouped = new Map<string, ScopedDriverEventAttempt[]>();
  for (const attempt of attempts) {
    if (attempt.routePlanId === null) continue;
    const key = scopeIdentity(attempt.diagnosticDeviceId, attempt.routePlanId);
    const values = grouped.get(key) ?? [];
    values.push(attempt);
    grouped.set(key, values);
  }
  return grouped;
}
