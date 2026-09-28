import { describe, expect, test, vi } from 'vitest';

import {
  loadRouteTrackingEventWindow,
  occurredAtWithinRouteTrackingEventWindow,
  resolveRouteTrackingEventWindow
} from '../src/modules/route-tracking/route-tracking.event-window.js';

describe('route tracking event window', () => {
  test('uses route timezone precedence and includes the service date plus the following local date', () => {
    const window = resolveRouteTrackingEventWindow({
      constraints: {
        routeScope: { timezone: 'America/Vancouver' },
        scheduledStartTimeZone: 'Europe/Paris',
        timezone: 'America/Toronto'
      },
      planDate: new Date('2026-09-17T00:00:00.000Z')
    })!;

    expect(window).toEqual({
      anchorSource: 'PLAN_DATE',
      endExclusive: new Date('2026-09-19T04:00:00.000Z'),
      serviceDate: '2026-09-17',
      startInclusive: new Date('2026-09-17T04:00:00.000Z'),
      timezone: 'America/Toronto'
    });
    expect(occurredAtWithinRouteTrackingEventWindow(window, '2026-09-17T04:00:00.000Z')).toBe(true);
    expect(occurredAtWithinRouteTrackingEventWindow(window, '2026-09-19T03:59:59.999Z')).toBe(true);
    expect(occurredAtWithinRouteTrackingEventWindow(window, '2026-09-19T04:00:00.000Z')).toBe(false);
  });

  test('calculates calendar-day bounds across daylight-saving transitions', () => {
    const spring = resolveRouteTrackingEventWindow({
      constraints: { scheduledStartTimeZone: 'America/Toronto' },
      planDate: '2026-03-07'
    })!;
    const fall = resolveRouteTrackingEventWindow({
      constraints: { scheduledStartTimeZone: 'America/Toronto' },
      planDate: '2026-10-31'
    })!;

    expect(spring.startInclusive).toEqual(new Date('2026-03-07T05:00:00.000Z'));
    expect(spring.endExclusive).toEqual(new Date('2026-03-09T04:00:00.000Z'));
    expect(spring.endExclusive.getTime() - spring.startInclusive.getTime()).toBe(47 * 60 * 60 * 1000);
    expect(fall.startInclusive).toEqual(new Date('2026-10-31T04:00:00.000Z'));
    expect(fall.endExclusive).toEqual(new Date('2026-11-02T05:00:00.000Z'));
    expect(fall.endExclusive.getTime() - fall.startInclusive.getTime()).toBe(49 * 60 * 60 * 1000);
  });

  test('anchors the service window to the first route start local date before plan date fallback', () => {
    const window = resolveRouteTrackingEventWindow({
      constraints: { scheduledStartTimeZone: 'America/Toronto' },
      planDate: '2026-07-18',
      startOccurredAt: '2026-07-21T03:30:00.000Z'
    });

    expect(window).toEqual({
      anchorSource: 'ROUTE_STARTED',
      endExclusive: new Date('2026-07-22T04:00:00.000Z'),
      serviceDate: '2026-07-20',
      startInclusive: new Date('2026-07-20T04:00:00.000Z'),
      timezone: 'America/Toronto'
    });
  });

  test('refuses to derive a destructive window without a valid route-owned timezone', () => {
    expect(resolveRouteTrackingEventWindow({
      constraints: {},
      planDate: '2026-09-17'
    })).toBeNull();
    expect(resolveRouteTrackingEventWindow({
      constraints: { scheduledStartTimeZone: 'invalid' },
      planDate: '2026-09-17'
    })).toBeNull();
  });

  test('loads only immutable route-owned window inputs', async () => {
    const findUnique = vi.fn(() => Promise.resolve({
      constraints: { routeScope: { timezone: 'America/Vancouver' } },
      planDate: new Date('2026-09-17T00:00:00.000Z'),
      shopId: 'shop-1'
    }));
    const findFirst = vi.fn(() => Promise.resolve({
      occurredAt: new Date('2026-09-18T08:30:00.000Z')
    }));

    await expect(loadRouteTrackingEventWindow({
      driverEvent: { findFirst },
      routePlan: { findUnique }
    } as never, 'route-1'))
      .resolves.toEqual({
        anchorSource: 'ROUTE_STARTED',
        endExclusive: new Date('2026-09-20T07:00:00.000Z'),
        serviceDate: '2026-09-18',
        startInclusive: new Date('2026-09-18T07:00:00.000Z'),
        timezone: 'America/Vancouver'
      });
    expect(findUnique).toHaveBeenCalledWith({
      select: {
        constraints: true,
        planDate: true,
        shopId: true
      },
      where: { id: 'route-1' }
    });
    expect(findFirst).toHaveBeenCalledWith({
      orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: { occurredAt: true },
      where: {
        eventType: 'ROUTE_STARTED',
        routePlanId: 'route-1',
        shopId: 'shop-1'
      }
    });
  });
});
