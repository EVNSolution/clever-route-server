import type { PrismaClient } from '@prisma/client';

import { visibleDsvRouteWhere } from '../dsv/dsv-test-visibility.js';
import { ROUTE_DRIVER_VISIBLE_STATUSES } from '../route-plans/route-plan-lifecycle.js';
import {
  buildCanonicalDestinationProjection,
  canonicalDestinationProfileSelect,
  DESTINATION_NOTE_COLUMNS,
  type CanonicalDestinationProfileRecord,
  type DestinationNoteField,
} from './driver-destination-notes.repository.js';

// One page of a driver's own visits to one destination, newest first. A visit is a route of this driver
// with a delivered or failed stop at the destination; it carries the destination notes as they were then.

export type DriverDestinationVisit = {
  boxCount: number;
  /** Fields the driver changed on this visit; their new values are in notes. */
  changedFields: DestinationNoteField[];
  deliveryDate: string;
  notes: Record<DestinationNoteField, string | null>;
  orderCount: number;
  orderNotes: string[];
  outcome: 'DELIVERED' | 'FAILED' | 'PARTIAL';
  routeName: string;
  routePlanId: string;
  /** The latest time the driver entered on 배송완료 at this destination on this route. */
  visitedAt: string | null;
};

export type ListDriverDestinationVisitsInput = {
  cursor: string | null;
  destinationId: string;
  driverId: string;
  shopId: string;
};

export type ListDriverDestinationVisitsResult = {
  nextCursor: string | null;
  visits: DriverDestinationVisit[];
};

export type DriverDestinationVisitsServiceContract = {
  list(input: ListDriverDestinationVisitsInput): Promise<ListDriverDestinationVisitsResult>;
};

export class DriverDestinationVisitsScopeError extends Error {
  constructor() {
    super('Destination is not visible to this driver');
    this.name = 'DriverDestinationVisitsScopeError';
  }
}

const PAGE_SIZE = 20;
const VISITED_STOP_STATUSES = ['DELIVERED', 'FAILED'] as const;

type VisitsPrisma = Pick<PrismaClient, 'deliveryCustomerProfile' | 'destinationNoteRevision' | 'driver' | 'routePlan'>;

export class PrismaDriverDestinationVisitsRepository implements DriverDestinationVisitsServiceContract {
  constructor(private readonly prisma: VisitsPrisma) {}

  async list(input: ListDriverDestinationVisitsInput): Promise<ListDriverDestinationVisitsResult> {
    const driver = await this.prisma.driver.findFirst({
      select: { isStoreReviewData: true },
      where: { id: input.driverId, shopId: input.shopId, status: 'ACTIVE' },
    });
    if (driver === null) throw new DriverDestinationVisitsScopeError();
    const memberIds = await this.destinationMemberIds(input.shopId, input.destinationId, driver.isStoreReviewData);
    if (memberIds.length === 0) throw new DriverDestinationVisitsScopeError();

    const cursor = decodeCursor(input.cursor);
    const routes = await this.prisma.routePlan.findMany({
      orderBy: [{ planDate: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        name: true,
        planDate: true,
        routeStops: {
          orderBy: { sequence: 'asc' },
          select: {
            deliveryStop: {
              select: {
                driverEvents: {
                  orderBy: { occurredAt: 'desc' },
                  select: { occurredAt: true, routePlanId: true },
                  where: { driverId: input.driverId, eventType: 'STOP_DELIVERED' },
                },
                instructions: true,
                order: { select: { rawPayload: true } },
                status: true,
              },
            },
          },
          where: { deliveryStop: { order: { destinationId: { in: memberIds } } } },
        },
      },
      take: PAGE_SIZE + 1,
      where: {
        driverId: input.driverId,
        isStoreReviewData: driver.isStoreReviewData,
        routeStops: {
          some: {
            deliveryStop: {
              order: { destinationId: { in: memberIds } },
              status: { in: [...VISITED_STOP_STATUSES] },
            },
          },
        },
        shopId: input.shopId,
        ...visibleDsvRouteWhere(input.shopId),
        status: { in: [...ROUTE_DRIVER_VISIBLE_STATUSES] },
        ...(cursor === null ? {} : {
          OR: [
            { planDate: { lt: cursor.planDate } },
            { id: { lt: cursor.id }, planDate: cursor.planDate },
          ],
        }),
      },
    });
    const page = routes.slice(0, PAGE_SIZE);
    const revisions = page.length === 0 ? [] : await this.prisma.destinationNoteRevision.findMany({
      orderBy: [{ changedAt: 'asc' }, { createdAt: 'asc' }],
      select: { changedAt: true, driverId: true, field: true, routePlanId: true, source: true, value: true },
      where: { destinationId: { in: memberIds }, shopId: input.shopId },
    });

    const visits = page.map((route): DriverDestinationVisit => {
      const stops = route.routeStops.map(({ deliveryStop }) => deliveryStop);
      const deliveredTimes = stops.flatMap(({ driverEvents, status }) => status === 'DELIVERED'
        ? driverEvents.filter((event) => event.routePlanId === route.id).slice(0, 1).map(({ occurredAt }) => occurredAt)
        : []);
      const visitedAt = deliveredTimes.reduce<Date | null>((latest, time) => latest === null || time > latest ? time : latest, null);
      const statuses = new Set(stops.map(({ status }) => status));
      // Notes in force when the visit ended; a visit with no completion time reads them at the end of its day.
      const asOf = visitedAt ?? new Date(route.planDate.getTime() + 24 * 60 * 60 * 1000);
      return {
        boxCount: stops.reduce((total, stop) => total + readShippedBoxes(stop.order.rawPayload), 0),
        changedFields: [...new Set(revisions
          .filter((revision) => revision.source === 'DRIVER' && revision.routePlanId === route.id
            && revision.driverId === input.driverId)
          .map(({ field }) => field as DestinationNoteField))],
        deliveryDate: route.planDate.toISOString().slice(0, 10),
        notes: Object.fromEntries(DESTINATION_NOTE_COLUMNS.map(([field]) => [
          field,
          revisions.filter((revision) => revision.field === field && revision.changedAt <= asOf).at(-1)?.value ?? null,
        ])) as Record<DestinationNoteField, string | null>,
        orderCount: stops.length,
        orderNotes: [...new Set(stops.flatMap(({ instructions }) => instructions?.trim() ? [instructions.trim()] : []))],
        outcome: statuses.size === 1 && statuses.has('DELIVERED')
          ? 'DELIVERED'
          : statuses.size === 1 && statuses.has('FAILED') ? 'FAILED' : 'PARTIAL',
        routeName: route.name,
        routePlanId: route.id,
        visitedAt: visitedAt?.toISOString() ?? null,
      };
    });
    const last = page.at(-1);
    return {
      nextCursor: routes.length > PAGE_SIZE && last !== undefined ? encodeCursor(last.planDate, last.id) : null,
      visits,
    };
  }

  // The destination id the app holds is the canonical projection id. Its visits also include the identity
  // duplicates projected onto it and the profiles merged into any of them.
  private async destinationMemberIds(shopId: string, destinationId: string, isStoreReviewData: boolean): Promise<string[]> {
    const profiles = await this.prisma.deliveryCustomerProfile.findMany({
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: canonicalDestinationProfileSelect,
      where: { mergedIntoProfileId: null, shopId },
    }) as CanonicalDestinationProfileRecord[];
    const projection = buildCanonicalDestinationProjection(profiles).get(destinationId);
    if (projection === undefined) return [];
    const canonical = profiles.find(({ id }) => id === projection.destinationId);
    if (canonical === undefined || canonical.isStoreReviewData !== isStoreReviewData) return [];
    const members = new Set(projection.memberIds);
    let frontier = [...members];
    for (let depth = 0; depth < 10 && frontier.length > 0; depth += 1) {
      const merged = await this.prisma.deliveryCustomerProfile.findMany({
        select: { id: true },
        where: { mergedIntoProfileId: { in: frontier }, shopId },
      });
      frontier = merged.map(({ id }) => id).filter((id) => !members.has(id));
      for (const id of frontier) members.add(id);
    }
    return [...members];
  }
}

function readShippedBoxes(rawPayload: unknown): number {
  const dsv = object(object(rawPayload)?.dsv);
  const value = object(dsv?.normalized)?.shippedBoxes ?? object(rawPayload)?.shippedBoxes;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function encodeCursor(planDate: Date, id: string): string {
  return Buffer.from(JSON.stringify({ id, planDate: planDate.toISOString() })).toString('base64url');
}

export class DriverDestinationVisitsCursorError extends Error {}

function decodeCursor(cursor: string | null): { id: string; planDate: Date } | null {
  if (cursor === null) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { id?: unknown; planDate?: unknown };
    const planDate = typeof parsed.planDate === 'string' ? new Date(parsed.planDate) : null;
    if (typeof parsed.id !== 'string' || planDate === null || Number.isNaN(planDate.getTime())) throw new Error('bad cursor');
    return { id: parsed.id, planDate };
  } catch {
    throw new DriverDestinationVisitsCursorError('Invalid destination visits cursor');
  }
}
