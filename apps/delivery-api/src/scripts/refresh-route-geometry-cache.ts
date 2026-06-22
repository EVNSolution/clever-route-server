import { PrismaClient } from '@prisma/client';

import { OsrmRouteGeometryProvider } from '../modules/route-plans/osrm-route-geometry.client.js';
import { PrismaRoutePlanRepository } from '../modules/route-plans/route-plan.repository.js';
import { RoutePlanAdminService } from '../modules/route-plans/route-plan.service.js';
import type { RoutePlanDetail } from '../modules/route-plans/route-plan.types.js';

type RefreshRouteGeometryArgs = {
  apply: boolean;
  routePlanId: string;
  shopDomain: string;
};

type RouteGeometrySummary = {
  coordinateCount: number;
  distanceMeters: number | null;
  generatedAt: string | null;
  maxSegmentMeters: number | null;
  source: string | null;
  status: string;
};

export function parseRefreshRouteGeometryArgs(argv: string[]): RefreshRouteGeometryArgs {
  const values = new Map<string, string>();
  let apply = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === '--apply') {
      apply = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      throw new UsageRequestedError();
    }
    if (arg.startsWith('--')) {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`Missing value for ${arg}`);
      }
      values.set(arg, next);
      index += 1;
      continue;
    }
    throw new Error(`Unexpected argument: ${arg}`);
  }

  const routePlanId = readRequired(values, '--route-plan-id');
  const shopDomain = readRequired(values, '--shop-domain');

  return { apply, routePlanId, shopDomain };
}

async function main(): Promise<void> {
  const args = parseRefreshRouteGeometryArgs(process.argv.slice(2));
  const prisma = new PrismaClient();

  try {
    const repository = new PrismaRoutePlanRepository(prisma);
    const before = await repository.findRoutePlanDetail({
      routePlanId: args.routePlanId,
      shopDomain: args.shopDomain
    });
    if (before === null) {
      throw new Error(`Route plan not found for ${args.shopDomain}: ${args.routePlanId}`);
    }

    let after: RoutePlanDetail = before;
    if (args.apply) {
      const osrmBaseUrl = readOsrmBaseUrl(process.env.OSRM_BASE_URL);
      const routeGeometryProvider = new OsrmRouteGeometryProvider({ baseUrl: osrmBaseUrl });
      const service = new RoutePlanAdminService(repository, routeGeometryProvider);
      const refreshed = await service.refreshRouteGeometryForRoutePlan({
        routePlanId: args.routePlanId,
        shopDomain: args.shopDomain,
        source: 'EXPLICIT_REFRESH'
      });
      if (refreshed === null) {
        throw new Error(`Route geometry refresh returned no route plan for ${args.shopDomain}: ${args.routePlanId}`);
      }
      after = refreshed;
    }

    console.log(JSON.stringify({
      ok: true,
      applied: args.apply,
      routePlanId: args.routePlanId,
      shopDomain: args.shopDomain,
      before: summarizeRouteGeometry(before),
      after: summarizeRouteGeometry(after)
    }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

export function summarizeRouteGeometry(detail: RoutePlanDetail): RouteGeometrySummary {
  const coordinates = detail.routeGeometry?.coordinates ?? [];
  return {
    coordinateCount: coordinates.length,
    distanceMeters: detail.routeMetrics?.distanceMeters ?? null,
    generatedAt: detail.routeGeometryGeneratedAt ?? null,
    maxSegmentMeters: computeMaxSegmentMeters(coordinates),
    source: detail.routeGeometrySource ?? null,
    status: detail.routeGeometryStatus ?? 'missing'
  };
}

class UsageRequestedError extends Error {}

function readRequired(values: Map<string, string>, key: string): string {
  const value = values.get(key)?.trim();
  if (value === undefined || value === '') {
    throw new Error(`Missing required argument: ${key}`);
  }
  return value;
}

function readOsrmBaseUrl(value: string | undefined): string {
  if (value === undefined || value.trim() === '') {
    throw new Error('OSRM_BASE_URL is required when --apply is used.');
  }
  return value.trim();
}

function computeMaxSegmentMeters(coordinates: Array<[number, number]>): number | null {
  if (coordinates.length < 2) return null;
  let max = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    const left = coordinates[index - 1];
    const right = coordinates[index];
    if (left !== undefined && right !== undefined) {
      max = Math.max(max, haversineMeters(left, right));
    }
  }
  return Math.round(max);
}

function haversineMeters(left: [number, number], right: [number, number]): number {
  const earthRadiusMeters = 6371000;
  const leftLatitude = toRadians(left[1]);
  const rightLatitude = toRadians(right[1]);
  const latitudeDelta = toRadians(right[1] - left[1]);
  const longitudeDelta = toRadians(right[0] - left[0]);
  const halfChord = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(leftLatitude) * Math.cos(rightLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * earthRadiusMeters * Math.atan2(Math.sqrt(halfChord), Math.sqrt(1 - halfChord));
}

function toRadians(value: number): number {
  return value * Math.PI / 180;
}

function printUsage(): void {
  console.error('Usage: node dist/scripts/refresh-route-geometry-cache.js --shop-domain <domain> --route-plan-id <uuid> [--apply]');
}

if (isMainModule()) {
  main().catch((error: unknown) => {
    if (error instanceof UsageRequestedError) {
      printUsage();
      process.exitCode = 0;
      return;
    }
    console.error(error instanceof Error ? error.message : error);
    printUsage();
    process.exitCode = 1;
  });
}

function isMainModule(): boolean {
  if (process.argv[1] === undefined) return false;
  return import.meta.url === new URL(process.argv[1], 'file:').href;
}
