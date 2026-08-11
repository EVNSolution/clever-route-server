import { createHash } from 'node:crypto';

import type { Prisma, PrismaClient } from '@prisma/client';

import type {
  RouteTrackingRoadMatchClassifyingProvider,
  RouteTrackingRoadMatchProvider,
} from '../route-tracking/route-tracking.road-match.js';
import type { RouteTrackingRoadMatchedGeometryV1 } from '../route-tracking/route-tracking.types.js';

export const UVIS_VEHICLE_TRAIL_SCHEMA_VERSION = 'uvis_vehicle_trail.v1' as const;
export const UVIS_ROAD_MATCH_GPS_PRECISION_METERS = 75;
const SERVICE_TIMEZONE = 'Asia/Seoul';
const MAX_PLAUSIBLE_SPEED_METERS_PER_SECOND = 55;
const TRAIL_MATERIALIZATION_RETRY_DELAYS_MS = [60_000, 300_000, 900_000, 3_600_000] as const;

export type UvisVehicleTrailMarker = {
  kind: 'RESTART' | 'START';
  latitude: number;
  longitude: number;
  observedAt: string;
};

export type UvisVehicleTrailDocumentSegmentV1 = {
  endedAt: string;
  roadMatchFailureReason?: UvisVehicleTrailRoadMatchFailureReason | null;
  roadMatchedGeometry: RouteTrackingRoadMatchedGeometryV1 | null;
  roadMatchRetryable?: boolean;
  samples: UvisVehicleTrailSampleV1[];
  startedAt: string;
  trailMarker: UvisVehicleTrailMarker;
};

export type UvisVehicleTrailRoadMatchFailureReason =
  | 'INVALID_INPUT'
  | 'LOW_CONFIDENCE'
  | 'NO_MATCH'
  | 'PARTIAL_TRANSIENT_FAILURE'
  | 'PROVIDER_UNAVAILABLE'
  | 'TRANSIENT_FAILURE';

export type UvisVehicleTrailDocumentV1 = {
  generatedAt: string;
  retryable: boolean;
  schemaVersion: typeof UVIS_VEHICLE_TRAIL_SCHEMA_VERSION;
  segments: UvisVehicleTrailDocumentSegmentV1[];
  serviceDate: string;
  sourceSampleCount: number;
  sourceWatermark: string;
  timezone: typeof SERVICE_TIMEZONE;
  vehicleId: string;
};

export type UvisVehicleTrailSampleV1 = {
  distanceTodayKm: number | null;
  ignitionOn: boolean | null;
  latitude: number;
  longitude: number;
  observedAt: string;
  speedKph: number | null;
  staleAfter: string;
};

type UvisVehicleTrailPrismaClient = Pick<
  PrismaClient,
  'uvisVehicleTelemetrySample' | 'uvisVehicleTrailMaterialization'
>;

type SourceSample = {
  distanceTodayKm: Prisma.Decimal | number | string | null;
  id: string;
  ignitionOn: boolean | null;
  latitude: Prisma.Decimal | number | string | null;
  longitude: Prisma.Decimal | number | string | null;
  observedAt: Date;
  speedKph: Prisma.Decimal | number | string | null;
  staleAfter: Date;
};

type TrailPoint = UvisVehicleTrailSampleV1 & { id: string; observedAtDate: Date; staleAfterDate: Date };

type DetectedSegment = {
  marker: UvisVehicleTrailMarker;
  samples: TrailPoint[];
};

type IntervalEvidence = {
  current: TrailPoint;
  movement: boolean;
  previous: TrailPoint;
  stableStop: boolean;
};

export class PrismaUvisVehicleTrailMaterializationRepository {
  constructor(private readonly prisma: UvisVehicleTrailPrismaClient) {}

  async findDocument(input: {
    serviceDate: string;
    shopId: string;
    vehicleId: string;
  }): Promise<UvisVehicleTrailDocumentV1 | null> {
    const row = await this.prisma.uvisVehicleTrailMaterialization.findUnique({
      select: { document: true },
      where: {
        shopId_vehicleId_serviceDate_schemaVersion: {
          schemaVersion: UVIS_VEHICLE_TRAIL_SCHEMA_VERSION,
          serviceDate: serviceDateAsDbDate(input.serviceDate),
          shopId: input.shopId,
          vehicleId: input.vehicleId,
        },
      },
    });
    return readTrailDocument(row?.document);
  }

  async materializeVehicleDay(input: {
    finalizing?: boolean;
    now?: Date;
    roadMatchProvider?: RouteTrackingRoadMatchProvider | undefined;
    serviceDate: string;
    shopId: string;
    vehicleId: string;
  }): Promise<UvisVehicleTrailDocumentV1> {
    const now = input.now ?? new Date();
    const window = serviceDateWindowUtc(input.serviceDate);
    const sourceRows = await this.prisma.uvisVehicleTelemetrySample.findMany({
      orderBy: [{ observedAt: 'asc' }, { id: 'asc' }],
      select: {
        distanceTodayKm: true,
        id: true,
        ignitionOn: true,
        latitude: true,
        longitude: true,
        observedAt: true,
        speedKph: true,
        staleAfter: true,
      },
      where: {
        latitude: { not: null },
        longitude: { not: null },
        observedAt: { gte: window.start, lt: window.end },
        shopId: input.shopId,
        sourceKind: 'VEHICLE_GPS',
        vehicleId: input.vehicleId,
      },
    });
    const points = sourceRows.flatMap(toTrailPoint);
    const detected = detectMovingSegments(points);
    const previousDocument = await this.findDocument(input);
    const materializedSegments: UvisVehicleTrailDocumentSegmentV1[] = [];
    let retryable = false;

    for (const segment of detected) {
      const documentSamples = segment.samples.map(toDocumentSample);
      const reusableSegment = findReusableSegment(previousDocument, documentSamples);
      const roadMatch = reusableSegment === null
        ? await matchRoadGeometry(segment.samples, input.roadMatchProvider)
        : {
            failureReason: reusableSegment.roadMatchFailureReason ?? null,
            geometry: reusableSegment.roadMatchedGeometry,
            retryable: false,
          };
      retryable ||= roadMatch.retryable;
      materializedSegments.push({
        endedAt: segment.samples.at(-1)!.observedAt,
        roadMatchFailureReason: roadMatch.failureReason,
        roadMatchedGeometry: roadMatch.geometry,
        roadMatchRetryable: roadMatch.retryable,
        samples: documentSamples,
        startedAt: segment.samples[0]!.observedAt,
        trailMarker: segment.marker,
      });
    }

    const sourceWatermark = sourceWatermarkFor(sourceRows);
    const document: UvisVehicleTrailDocumentV1 = {
      generatedAt: now.toISOString(),
      retryable,
      schemaVersion: UVIS_VEHICLE_TRAIL_SCHEMA_VERSION,
      segments: materializedSegments,
      serviceDate: input.serviceDate,
      sourceSampleCount: sourceRows.length,
      sourceWatermark,
      timezone: SERVICE_TIMEZONE,
      vehicleId: input.vehicleId,
    };

    const finalizedAt = input.finalizing === true && !retryable ? now : null;
    const finalizedAtUpdate = input.finalizing === true ? { finalizedAt } : {};
    await this.prisma.uvisVehicleTrailMaterialization.upsert({
      create: {
        document,
        finalizedAt,
        generatedAt: now,
        schemaVersion: UVIS_VEHICLE_TRAIL_SCHEMA_VERSION,
        serviceDate: serviceDateAsDbDate(input.serviceDate),
        shopId: input.shopId,
        sourceSampleCount: sourceRows.length,
        sourceWatermark,
        vehicleId: input.vehicleId,
      },
      update: {
        document,
        ...finalizedAtUpdate,
        generatedAt: now,
        sourceSampleCount: sourceRows.length,
        sourceWatermark,
      },
      where: {
        shopId_vehicleId_serviceDate_schemaVersion: {
          schemaVersion: UVIS_VEHICLE_TRAIL_SCHEMA_VERSION,
          serviceDate: serviceDateAsDbDate(input.serviceDate),
          shopId: input.shopId,
          vehicleId: input.vehicleId,
        },
      },
    });
    return document;
  }

  async findVehicleDaysWithGpsSamples(input: {
    from: Date;
    shopId?: string | undefined;
    to: Date;
  }): Promise<Array<{ serviceDate: string; shopId: string; vehicleId: string }>> {
    const rows = await this.prisma.uvisVehicleTelemetrySample.findMany({
      distinct: ['shopId', 'vehicleId'],
      orderBy: [{ shopId: 'asc' }, { vehicleId: 'asc' }],
      select: { observedAt: true, shopId: true, vehicleId: true },
      where: {
        latitude: { not: null },
        longitude: { not: null },
        observedAt: { gte: input.from, lt: input.to },
        ...(input.shopId === undefined ? {} : { shopId: input.shopId }),
        sourceKind: 'VEHICLE_GPS',
      },
    });
    return rows.map((row) => ({
      serviceDate: serviceDateForInstant(row.observedAt),
      shopId: row.shopId,
      vehicleId: row.vehicleId,
    }));
  }
}

export class UvisVehicleTrailMaterializationQueue {
  private readonly pending = new Map<string, {
    attempt: number;
    finalizing: boolean;
    readyAt: number;
    serviceDate: string;
    shopId: string;
    vehicleId: string;
  }>();
  private flushing = false;
  private scheduled: NodeJS.Immediate | NodeJS.Timeout | null = null;

  constructor(private readonly input: {
    logger?: { warn: (context: Record<string, unknown>, message: string) => void } | undefined;
    repository: PrismaUvisVehicleTrailMaterializationRepository;
    retryDelaysMs?: readonly number[] | undefined;
    roadMatchProvider?: RouteTrackingRoadMatchProvider | undefined;
  }) {}

  enqueue(input: { observedAt: Date; shopId: string; vehicleId: string }): void {
    const serviceDate = serviceDateForInstant(input.observedAt);
    this.upsertPending(queueKey(input.shopId, input.vehicleId, serviceDate), {
      attempt: 0,
      finalizing: serviceDate < serviceDateForInstant(new Date()),
      readyAt: Date.now(),
      serviceDate,
      shopId: input.shopId,
      vehicleId: input.vehicleId,
    });
    this.schedule();
  }

  async recoverCurrentDay(now = new Date()): Promise<void> {
    const serviceDate = serviceDateForInstant(now);
    const window = serviceDateWindowUtc(serviceDate);
    await this.enqueueVehicleDays(window.start, window.end);
  }

  async finalizePreviousDay(now = new Date()): Promise<void> {
    const today = serviceDateForInstant(now);
    const todayWindow = serviceDateWindowUtc(today);
    const previousEnd = todayWindow.start;
    const previousStart = new Date(previousEnd.getTime() - 24 * 60 * 60 * 1000);
    const days = await this.input.repository.findVehicleDaysWithGpsSamples({ from: previousStart, to: previousEnd });
    for (const day of days) {
      this.upsertPending(queueKey(day.shopId, day.vehicleId, day.serviceDate), {
        ...day,
        attempt: 0,
        finalizing: true,
        readyAt: Date.now(),
      });
    }
    this.schedule();
  }

  private async enqueueVehicleDays(from: Date, to: Date): Promise<void> {
    const days = await this.input.repository.findVehicleDaysWithGpsSamples({ from, to });
    for (const day of days) {
      this.upsertPending(queueKey(day.shopId, day.vehicleId, day.serviceDate), {
        ...day,
        attempt: 0,
        finalizing: false,
        readyAt: Date.now(),
      });
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.scheduled !== null || this.flushing) return;
    const delayMs = this.nextDelayMs();
    const run = (): void => {
      this.scheduled = null;
      void this.flush();
    };
    this.scheduled = delayMs === 0 ? setImmediate(run) : setTimeout(run, delayMs);
    this.scheduled.unref();
  }

  private async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (true) {
        const nextKey = this.nextReadyKey();
        if (nextKey === null) break;
        const next = this.pending.get(nextKey)!;
        this.pending.delete(nextKey);
        try {
          const document = await this.input.repository.materializeVehicleDay({
            serviceDate: next.serviceDate,
            shopId: next.shopId,
            vehicleId: next.vehicleId,
            finalizing: next.finalizing,
            roadMatchProvider: this.input.roadMatchProvider,
          });
          if (document.retryable) {
            this.rescheduleRetry(nextKey, next);
          }
        } catch (error) {
          this.input.logger?.warn({ error, vehicleId: next.vehicleId }, 'UVIS trail materialization failed');
          this.rescheduleRetry(nextKey, next);
        }
      }
    } finally {
      this.flushing = false;
      if (this.pending.size > 0) this.schedule();
    }
  }

  private upsertPending(
    key: string,
    next: { attempt: number; finalizing: boolean; readyAt: number; serviceDate: string; shopId: string; vehicleId: string },
  ): void {
    const existing = this.pending.get(key);
    this.pending.set(key, {
      ...next,
      attempt: Math.min(existing?.attempt ?? next.attempt, next.attempt),
      finalizing: next.finalizing || existing?.finalizing === true,
      readyAt: Math.min(existing?.readyAt ?? next.readyAt, next.readyAt),
    });
    if (!this.flushing && (existing === undefined || next.readyAt < existing.readyAt)) {
      this.clearScheduled();
      this.schedule();
    }
  }

  private rescheduleRetry(
    key: string,
    item: { attempt: number; finalizing: boolean; serviceDate: string; shopId: string; vehicleId: string },
  ): void {
    const retryDelaysMs = this.input.retryDelaysMs ?? TRAIL_MATERIALIZATION_RETRY_DELAYS_MS;
    if (item.attempt >= retryDelaysMs.length) {
      this.input.logger?.warn({
        serviceDate: item.serviceDate,
        shopId: item.shopId,
        vehicleId: item.vehicleId,
      }, 'UVIS trail materialization retry limit reached');
      return;
    }
    this.upsertPending(key, {
      ...item,
      attempt: item.attempt + 1,
      readyAt: Date.now() + Math.max(0, retryDelaysMs[item.attempt] ?? 0),
    });
  }

  private nextReadyKey(): string | null {
    const now = Date.now();
    for (const [key, item] of this.pending) {
      if (item.readyAt <= now) return key;
    }
    return null;
  }

  private nextDelayMs(): number {
    if (this.pending.size === 0) return 0;
    const now = Date.now();
    let nextReadyAt = Number.POSITIVE_INFINITY;
    for (const item of this.pending.values()) {
      nextReadyAt = Math.min(nextReadyAt, item.readyAt);
    }
    return Math.max(0, nextReadyAt - now);
  }

  private clearScheduled(): void {
    if (this.scheduled === null) return;
    clearImmediate(this.scheduled as NodeJS.Immediate);
    clearTimeout(this.scheduled as NodeJS.Timeout);
    this.scheduled = null;
  }
}

export function serviceDateForInstant(instant: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    timeZone: SERVICE_TIMEZONE,
    year: 'numeric',
  }).formatToParts(instant);
  const read = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return `${read('year')}-${read('month')}-${read('day')}`;
}

function detectMovingSegments(points: TrailPoint[]): DetectedSegment[] {
  const segments: DetectedSegment[] = [];
  let current: TrailPoint[] = [];
  let pending: IntervalEvidence[] = [];
  let stableStopCount = 0;

  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!;
    const point = points[index]!;
    if (previous.staleAfterDate.getTime() < point.observedAtDate.getTime()) {
      if (current.length > 0) segments.push(toDetectedSegment(current, segments.length));
      else {
        const pendingMovement = pendingMovementPoints(pending);
        if (pendingMovement !== null) segments.push(toDetectedSegment(pendingMovement, segments.length));
      }
      current = [];
      pending = [];
      stableStopCount = 0;
      continue;
    }

    const interval = classifyInterval(previous, point);
    if (current.length === 0) {
      pending.push(interval);
      pending = pending.slice(-3);
      if (pending.filter((item) => item.movement).length >= 2) {
        current = uniquePoints(pending.flatMap((item) => [item.previous, item.current]));
        pending = [];
        stableStopCount = interval.stableStop ? 1 : 0;
      }
      continue;
    }

    current.push(point);
    stableStopCount = interval.stableStop ? stableStopCount + 1 : 0;
    if (stableStopCount >= 5) {
      segments.push(toDetectedSegment(current, segments.length));
      current = [];
      pending = [];
      stableStopCount = 0;
    }
  }
  if (current.length > 0) segments.push(toDetectedSegment(current, segments.length));
  if (current.length === 0) {
    const pendingMovement = pendingMovementPoints(pending);
    if (pendingMovement !== null) segments.push(toDetectedSegment(pendingMovement, segments.length));
  }
  return segments;
}

function pendingMovementPoints(pending: IntervalEvidence[]): TrailPoint[] | null {
  const samples = uniquePoints(pending
    .filter((item) => item.movement)
    .flatMap((item) => [item.previous, item.current]));
  return samples.length >= 2 ? samples : null;
}

function classifyInterval(previous: TrailPoint, current: TrailPoint): IntervalEvidence {
  const displacementMeters = distanceMeters(previous, current);
  const maxSpeed = Math.max(previous.speedKph ?? 0, current.speedKph ?? 0);
  return {
    current,
    movement: displacementMeters >= 80 || (maxSpeed > 3 && displacementMeters >= 40),
    previous,
    stableStop: maxSpeed <= 1 && displacementMeters <= 30,
  };
}

function toDetectedSegment(samples: TrailPoint[], index: number): DetectedSegment {
  const first = samples[0]!;
  return {
    marker: {
      kind: index === 0 ? 'START' : 'RESTART',
      latitude: first.latitude,
      longitude: first.longitude,
      observedAt: first.observedAt,
    },
    samples,
  };
}

async function matchRoadGeometry(
  samples: TrailPoint[],
  roadMatchProvider?: RouteTrackingRoadMatchProvider,
): Promise<{
  failureReason: UvisVehicleTrailRoadMatchFailureReason | null;
  geometry: RouteTrackingRoadMatchedGeometryV1 | null;
  retryable: boolean;
}> {
  if (roadMatchProvider === undefined) {
    return { failureReason: 'PROVIDER_UNAVAILABLE', geometry: null, retryable: false };
  }
  if (samples.length < 2) return { failureReason: 'INVALID_INPUT', geometry: null, retryable: false };
  const preparedSamples = prepareRoadMatchSamples(samples);
  if (preparedSamples.length < 2) return { failureReason: 'INVALID_INPUT', geometry: null, retryable: false };
  const document = {
    coordinates: preparedSamples.map((sample) => [sample.longitude, sample.latitude] as [number, number]),
    samples: preparedSamples.map((sample) => ({
      driverId: null,
      eventId: sample.id,
      occurredAt: sample.observedAt,
      receivedAt: sample.observedAt,
    })),
    sourcePointCount: preparedSamples.length,
  };
  try {
    const outcome = isClassifyingRoadMatchProvider(roadMatchProvider)
      ? await roadMatchProvider.matchWithStatus(document)
      : await matchWithoutStatus(roadMatchProvider, document);
    if (outcome.path !== null) {
      const geometry = addRoadMatchedGeometryAnchors(outcome.path.matchedGeometry, preparedSamples);
      return {
        failureReason: outcome.retryable
          ? 'PARTIAL_TRANSIENT_FAILURE'
          : geometry === null && outcome.path.uncertainGeometry !== null
            ? 'LOW_CONFIDENCE'
            : null,
        geometry,
        retryable: outcome.retryable,
      };
    }
    return {
      failureReason: outcome.retryable ? 'TRANSIENT_FAILURE' : 'NO_MATCH',
      geometry: null,
      retryable: outcome.retryable,
    };
  } catch {
    // A later UVIS-only queue attempt may recover from a transient OSRM or network failure.
    return { failureReason: 'TRANSIENT_FAILURE', geometry: null, retryable: true };
  }
}

async function matchWithoutStatus(
  provider: RouteTrackingRoadMatchProvider,
  document: Parameters<RouteTrackingRoadMatchProvider['match']>[0],
): Promise<{ path: Awaited<ReturnType<RouteTrackingRoadMatchProvider['match']>>; retryable: boolean }> {
  const path = await provider.match(document);
  return { path, retryable: path === null };
}

function isClassifyingRoadMatchProvider(
  provider: RouteTrackingRoadMatchProvider,
): provider is RouteTrackingRoadMatchClassifyingProvider {
  return typeof (provider as Partial<RouteTrackingRoadMatchClassifyingProvider>).matchWithStatus === 'function';
}

function findReusableSegment(
  previousDocument: UvisVehicleTrailDocumentV1 | null,
  samples: UvisVehicleTrailSampleV1[],
): UvisVehicleTrailDocumentSegmentV1 | null {
  if (previousDocument === null) return null;
  const signature = sampleSignature(samples);
  return previousDocument.segments.find((segment) => (
    sampleSignature(segment.samples) === signature
    && !isPreviousSegmentRetryable(previousDocument, segment)
  )) ?? null;
}

function isPreviousSegmentRetryable(
  previousDocument: UvisVehicleTrailDocumentV1,
  segment: UvisVehicleTrailDocumentSegmentV1,
): boolean {
  return typeof segment.roadMatchRetryable === 'boolean'
    ? segment.roadMatchRetryable
    : segment.roadMatchedGeometry === null && previousDocument.retryable;
}

function sampleSignature(samples: UvisVehicleTrailSampleV1[]): string {
  return JSON.stringify(samples.map((sample) => [
    sample.observedAt,
    sample.staleAfter,
    sample.latitude,
    sample.longitude,
  ]));
}

function addRoadMatchedGeometryAnchors(
  geometry: RouteTrackingRoadMatchedGeometryV1 | null,
  samples: TrailPoint[],
): RouteTrackingRoadMatchedGeometryV1 | null {
  if (geometry === null) return null;
  const anchors: NonNullable<RouteTrackingRoadMatchedGeometryV1['anchors']> = [];
  let previous: { coordinateIndex: number; lineIndex: number } | undefined;
  for (const sample of samples) {
    const nearest = nearestRoadMatchedCoordinate(
      geometry.coordinates,
      [sample.longitude, sample.latitude],
      previous,
    );
    if (nearest === null) continue;
    anchors.push({
      observedAt: sample.observedAt,
      lineIndex: nearest.lineIndex,
      coordinateIndex: nearest.coordinateIndex,
    });
    previous = nearest;
  }
  return anchors.length === 0 ? geometry : { ...geometry, anchors };
}

function nearestRoadMatchedCoordinate(
  lines: Array<Array<[number, number]>>,
  target: [number, number],
  minimum?: { coordinateIndex: number; lineIndex: number },
): { coordinateIndex: number; lineIndex: number } | null {
  let nearest: { coordinateIndex: number; distance: number; lineIndex: number } | null = null;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]!;
    for (let coordinateIndex = 0; coordinateIndex < line.length; coordinateIndex += 1) {
      if (
        minimum !== undefined
        && (lineIndex < minimum.lineIndex
          || (lineIndex === minimum.lineIndex && coordinateIndex < minimum.coordinateIndex))
      ) continue;
      const coordinate = line[coordinateIndex]!;
      const distance = ((coordinate[0] - target[0]) ** 2) + ((coordinate[1] - target[1]) ** 2);
      if (nearest === null || distance < nearest.distance) {
        nearest = { coordinateIndex, distance, lineIndex };
      }
    }
  }
  return nearest === null ? null : { coordinateIndex: nearest.coordinateIndex, lineIndex: nearest.lineIndex };
}

function prepareRoadMatchSamples(samples: TrailPoint[]): TrailPoint[] {
  const chronological = [...samples]
    .sort((left, right) => left.observedAtDate.getTime() - right.observedAtDate.getTime() || left.id.localeCompare(right.id))
    .filter((sample, index, ordered) => (
      index === 0 || Math.floor(sample.observedAtDate.getTime() / 1000)
        > Math.floor(ordered[index - 1]!.observedAtDate.getTime() / 1000)
    ));
  if (chronological.length < 3) return chronological;

  const prepared: TrailPoint[] = [chronological[0]!];
  for (let index = 1; index < chronological.length - 1; index += 1) {
    const previous = prepared.at(-1)!;
    const current = chronological[index]!;
    const next = chronological[index + 1]!;
    if (isIsolatedGpsJump(previous, current, next)) continue;
    prepared.push(current);
  }
  prepared.push(chronological.at(-1)!);
  return prepared;
}

function isIsolatedGpsJump(previous: TrailPoint, current: TrailPoint, next: TrailPoint): boolean {
  const incoming = impliedSpeedMetersPerSecond(previous, current);
  const outgoing = impliedSpeedMetersPerSecond(current, next);
  const bypass = impliedSpeedMetersPerSecond(previous, next);
  return incoming > MAX_PLAUSIBLE_SPEED_METERS_PER_SECOND
    && outgoing > MAX_PLAUSIBLE_SPEED_METERS_PER_SECOND
    && bypass <= MAX_PLAUSIBLE_SPEED_METERS_PER_SECOND;
}

function impliedSpeedMetersPerSecond(previous: TrailPoint, current: TrailPoint): number {
  const elapsedSeconds = (current.observedAtDate.getTime() - previous.observedAtDate.getTime()) / 1000;
  return elapsedSeconds > 0 ? distanceMeters(previous, current) / elapsedSeconds : Number.POSITIVE_INFINITY;
}

function toTrailPoint(row: SourceSample): TrailPoint[] {
  const latitude = decimalToNumber(row.latitude);
  const longitude = decimalToNumber(row.longitude);
  if (latitude === null || longitude === null) return [];
  return [{
    distanceTodayKm: decimalToNumber(row.distanceTodayKm),
    id: row.id,
    ignitionOn: row.ignitionOn,
    latitude,
    longitude,
    observedAt: row.observedAt.toISOString(),
    observedAtDate: row.observedAt,
    speedKph: decimalToNumber(row.speedKph),
    staleAfter: row.staleAfter.toISOString(),
    staleAfterDate: row.staleAfter,
  }];
}

function toDocumentSample(sample: TrailPoint): UvisVehicleTrailSampleV1 {
  return {
    distanceTodayKm: sample.distanceTodayKm,
    ignitionOn: sample.ignitionOn,
    latitude: sample.latitude,
    longitude: sample.longitude,
    observedAt: sample.observedAt,
    speedKph: sample.speedKph,
    staleAfter: sample.staleAfter,
  };
}

function readTrailDocument(value: unknown): UvisVehicleTrailDocumentV1 | null {
  const object = objectOrNull(value);
  if (object?.schemaVersion !== UVIS_VEHICLE_TRAIL_SCHEMA_VERSION || !Array.isArray(object.segments)) return null;
  return object as UvisVehicleTrailDocumentV1;
}

function uniquePoints(points: TrailPoint[]): TrailPoint[] {
  const seen = new Set<string>();
  const output: TrailPoint[] = [];
  for (const point of points) {
    if (seen.has(point.id)) continue;
    seen.add(point.id);
    output.push(point);
  }
  return output;
}

function sourceWatermarkFor(rows: SourceSample[]): string {
  const hash = createHash('sha256');
  for (const row of rows) {
    hash.update(row.id);
    hash.update(row.observedAt.toISOString());
    hash.update(row.staleAfter.toISOString());
  }
  return `sha256:${hash.digest('hex')}`;
}

function serviceDateWindowUtc(serviceDate: string): { end: Date; start: Date } {
  const year = Number.parseInt(serviceDate.slice(0, 4), 10);
  const month = Number.parseInt(serviceDate.slice(5, 7), 10);
  const day = Number.parseInt(serviceDate.slice(8, 10), 10);
  const start = new Date(Date.UTC(year, month - 1, day, -9, 0, 0, 0));
  return { end: new Date(start.getTime() + 24 * 60 * 60 * 1000), start };
}

function serviceDateAsDbDate(serviceDate: string): Date {
  return new Date(`${serviceDate}T00:00:00.000Z`);
}

function queueKey(shopId: string, vehicleId: string, serviceDate: string): string {
  return `${shopId}:${vehicleId}:${serviceDate}`;
}

function decimalToNumber(value: Prisma.Decimal | number | string | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function distanceMeters(
  left: { latitude: number; longitude: number },
  right: { latitude: number; longitude: number },
): number {
  const earthRadiusMeters = 6_371_000;
  const leftLat = degreesToRadians(left.latitude);
  const rightLat = degreesToRadians(right.latitude);
  const deltaLat = degreesToRadians(right.latitude - left.latitude);
  const deltaLng = degreesToRadians(right.longitude - left.longitude);
  const a = Math.sin(deltaLat / 2) ** 2
    + Math.cos(leftLat) * Math.cos(rightLat) * Math.sin(deltaLng / 2) ** 2;
  return 2 * earthRadiusMeters * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function degreesToRadians(value: number): number {
  return value * Math.PI / 180;
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
