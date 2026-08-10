import { createHash } from 'node:crypto';

import type { Prisma, PrismaClient } from '@prisma/client';

import type { RouteTrackingRoadMatchProvider } from '../route-tracking/route-tracking.road-match.js';
import type { RouteTrackingRoadMatchedGeometryV1 } from '../route-tracking/route-tracking.types.js';

export const UVIS_VEHICLE_TRAIL_SCHEMA_VERSION = 'uvis_vehicle_trail.v1' as const;
const SERVICE_TIMEZONE = 'Asia/Seoul';

export type UvisVehicleTrailMarker = {
  kind: 'RESTART' | 'START';
  latitude: number;
  longitude: number;
  observedAt: string;
};

export type UvisVehicleTrailDocumentSegmentV1 = {
  endedAt: string;
  roadMatchedGeometry: RouteTrackingRoadMatchedGeometryV1 | null;
  samples: UvisVehicleTrailSampleV1[];
  startedAt: string;
  trailMarker: UvisVehicleTrailMarker;
};

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
    const materializedSegments: UvisVehicleTrailDocumentSegmentV1[] = [];
    let retryable = false;

    for (const segment of detected) {
      const roadMatchedGeometry = await matchRoadGeometry(segment.samples, input.roadMatchProvider);
      if (input.roadMatchProvider !== undefined && roadMatchedGeometry === null && segment.samples.length >= 2) {
        retryable = true;
      }
      materializedSegments.push({
        endedAt: segment.samples.at(-1)!.observedAt,
        roadMatchedGeometry,
        samples: segment.samples.map(toDocumentSample),
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
  private readonly pending = new Map<string, { finalizing: boolean; serviceDate: string; shopId: string; vehicleId: string }>();
  private flushing = false;
  private scheduled: NodeJS.Immediate | null = null;

  constructor(private readonly input: {
    logger?: { warn: (context: Record<string, unknown>, message: string) => void } | undefined;
    repository: PrismaUvisVehicleTrailMaterializationRepository;
    roadMatchProvider?: RouteTrackingRoadMatchProvider | undefined;
  }) {}

  enqueue(input: { observedAt: Date; shopId: string; vehicleId: string }): void {
    const serviceDate = serviceDateForInstant(input.observedAt);
    this.pending.set(queueKey(input.shopId, input.vehicleId, serviceDate), {
      finalizing: serviceDate < serviceDateForInstant(new Date()),
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
    await Promise.all(days.map((day) => this.input.repository.materializeVehicleDay({
      ...day,
      finalizing: true,
      now,
      roadMatchProvider: this.input.roadMatchProvider,
    })));
  }

  private async enqueueVehicleDays(from: Date, to: Date): Promise<void> {
    const days = await this.input.repository.findVehicleDaysWithGpsSamples({ from, to });
    for (const day of days) {
      this.pending.set(queueKey(day.shopId, day.vehicleId, day.serviceDate), { ...day, finalizing: false });
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.scheduled !== null || this.flushing) return;
    this.scheduled = setImmediate(() => {
      this.scheduled = null;
      void this.flush();
    });
    this.scheduled.unref();
  }

  private async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.pending.size > 0) {
        const nextKey = this.pending.keys().next().value as string;
        const next = this.pending.get(nextKey)!;
        this.pending.delete(nextKey);
        try {
          await this.input.repository.materializeVehicleDay({
            serviceDate: next.serviceDate,
            shopId: next.shopId,
            vehicleId: next.vehicleId,
            finalizing: next.finalizing,
            roadMatchProvider: this.input.roadMatchProvider,
          });
        } catch (error) {
          this.input.logger?.warn({ error, vehicleId: next.vehicleId }, 'UVIS trail materialization failed');
        }
      }
    } finally {
      this.flushing = false;
      if (this.pending.size > 0) this.schedule();
    }
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
        const firstEvidence = pending.find((item) => item.movement) ?? pending[0]!;
        current = uniquePoints([
          firstEvidence.previous,
          ...pending.flatMap((item) => [item.previous, item.current]),
        ]);
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
  return segments;
}

function classifyInterval(previous: TrailPoint, current: TrailPoint): IntervalEvidence {
  const displacementMeters = distanceMeters(previous, current);
  const maxSpeed = Math.max(previous.speedKph ?? 0, current.speedKph ?? 0);
  return {
    current,
    movement: maxSpeed > 3 || displacementMeters >= 80,
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
): Promise<RouteTrackingRoadMatchedGeometryV1 | null> {
  if (roadMatchProvider === undefined || samples.length < 2) return null;
  try {
    const result = await roadMatchProvider.match({
      coordinates: samples.map((sample) => [sample.longitude, sample.latitude]),
      samples: samples.map((sample) => ({
        driverId: null,
        eventId: sample.id,
        occurredAt: sample.observedAt,
        receivedAt: sample.observedAt,
      })),
      sourcePointCount: samples.length,
    });
    return result?.matchedGeometry ?? null;
  } catch {
    return null;
  }
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
