import { PrismaClient } from '@prisma/client';

import {
  PrismaUvisVehicleTrailMaterializationRepository,
  UVIS_ROAD_MATCH_GPS_PRECISION_METERS,
} from '../modules/uvis/uvis-vehicle-trail-materializer.js';
import { readConfiguredCoverageBaseUrls, type RouteEngineRuntimeEnv } from '../modules/route-plans/route-engine-coverage.js';
import { OsrmRouteTrackingRoadMatchProvider } from '../modules/route-tracking/route-tracking.road-match.js';

const prisma = new PrismaClient();

try {
  const args = parseArgs(process.argv.slice(2));
  const repository = new PrismaUvisVehicleTrailMaterializationRepository(prisma);
  const roadMatchProvider = createRoadMatchProvider(process.env);
  let materialized = 0;
  for (const serviceDate of serviceDatesBetween(args.from, args.to)) {
    const window = serviceDateWindowUtc(serviceDate);
    const days = await repository.findVehicleDaysWithGpsSamples({
      from: window.start,
      ...(args.shopId === undefined ? {} : { shopId: args.shopId }),
      to: window.end,
    });
    for (const day of days) {
      await repository.materializeVehicleDay({
        ...day,
        finalizing: args.finalize,
        roadMatchProvider,
      });
      materialized += 1;
    }
  }
  console.info(JSON.stringify({
    finalized: args.finalize,
    from: args.from,
    materialized,
    to: args.to,
  }));
} finally {
  await prisma.$disconnect();
}

function parseArgs(args: string[]): { finalize: boolean; from: string; shopId?: string; to: string } {
  const values = new Map<string, string | true>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--finalize') {
      values.set('finalize', true);
      continue;
    }
    if (!arg.startsWith('--')) continue;
    const next = args[index + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new Error(`${arg} requires a value`);
    }
    values.set(arg.slice(2), next);
    index += 1;
  }
  const from = readIsoDate(values.get('from'));
  const to = readIsoDate(values.get('to') ?? values.get('from'));
  if (from === null || to === null) {
    throw new Error('Usage: tsx src/scripts/backfill-uvis-vehicle-trails.ts --from YYYY-MM-DD [--to YYYY-MM-DD] [--shop-id UUID] [--finalize]');
  }
  return {
    finalize: values.get('finalize') === true,
    from,
    ...(typeof values.get('shop-id') === 'string' ? { shopId: values.get('shop-id') as string } : {}),
    to,
  };
}

function* serviceDatesBetween(from: string, to: string): Generator<string> {
  const cursor = serviceDateAsDbDate(from);
  const end = serviceDateAsDbDate(to);
  while (cursor.getTime() <= end.getTime()) {
    yield cursor.toISOString().slice(0, 10);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
}

function readIsoDate(value: string | true | undefined): string | null {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value) ? value : null;
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

function createRoadMatchProvider(
  env: RouteEngineRuntimeEnv & Partial<Record<'OSRM_TIMEOUT_MS', string>>,
): OsrmRouteTrackingRoadMatchProvider | undefined {
  const baseUrls = readConfiguredCoverageBaseUrls(env, 'OSRM');
  if (Object.keys(baseUrls).length === 0) return undefined;
  return new OsrmRouteTrackingRoadMatchProvider({
    baseUrls,
    gpsPrecisionMeters: UVIS_ROAD_MATCH_GPS_PRECISION_METERS,
    ...optionalTimeout(env.OSRM_TIMEOUT_MS),
  });
}

function optionalTimeout(value: string | undefined): { timeoutMs?: number } {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? { timeoutMs: parsed } : {};
}
