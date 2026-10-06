import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await */

import { describe, expect, test, vi } from 'vitest';

import { PrismaDsvExecutionContextService } from '../src/modules/dsv/dsv-execution-context.service.js';
import { DsvExecutionContextError } from '../src/modules/dsv/dsv-execution-context.types.js';

const NOW = new Date('2026-10-05T22:37:00.000Z');
const STARTED_AT = new Date('2026-10-05T22:30:00.000Z');
const D03_FIXTURE = JSON.parse(readFileSync(
  fileURLToPath(new URL('./fixtures/dsv-notification-d03-cases.json', import.meta.url)),
  'utf8',
)) as D03Fixture;

describe('PrismaDsvExecutionContextService D03 transition contract', () => {
  const covered = new Set<string>();
  const observed = new Map<string, D03Observed>();
  const covers = (id: string) => { covered.add(id); };
  const observe = (
    id: string,
    outcome: string,
    harness: Harness,
    notificationKinds: string[],
    activeExecutionContextId: string | null = null,
  ) => {
    observed.set(id, observedCase(id, outcome, harness, notificationKinds, activeExecutionContextId));
  };

  test('D03-01 and D03-04 create identity only for a first valid publication', async () => {
    covers('D03-01'); covers('D03-04');
    for (const commandId of ['first-new-content', 'first-no-op-content']) {
      const harness = createHarness();
      const result = await harness.service.syncForRoute({
        commandId,
        firstPublication: true,
        now: NOW,
        routePlanId: 'route-am',
        shopId: 'shop-1',
      });
      expect(result).toMatchObject({ assignmentEpoch: '1', outcome: 'ACCEPT', routeVersion: 1 });
      expect(harness.contexts).toHaveLength(1);
      expect(harness.notifications.map((item) => item.kind)).toEqual(['N01']);
      expect(harness.contexts[0]).toMatchObject({
        notificationMode: 'OFF',
        reminderStatus: 'AWAITING_DEPARTURE',
        status: 'ACTIVE',
      });
      observe(commandId === 'first-new-content' ? 'D03-01' : 'D03-04', 'ACCEPT', harness, result.notificationKinds);
    }
  });

  test('D03-02 replays the same publication command when server-observed publication hints change', async () => {
    covers('D03-02');
    const harness = createHarness();
    const input = baseSync('same-command');
    const first = await harness.service.syncForRoute(input);
    Object.assign(harness.contexts[0]!, timerState());
    const replay = await harness.service.syncForRoute({
      ...input,
      firstPublication: false,
      previousPublishedAt: NOW,
    });
    expect(replay).toEqual({ ...first, outcome: 'REPLAY' });
    expect(harness.contexts).toHaveLength(1);
    expect(harness.notifications).toHaveLength(1);
    observe('D03-02', 'ACCEPT', harness, []);
  });

  test('D03-03 keeps identity, version, epoch, timer, and intents for a new no-op command', async () => {
    covers('D03-03');
    const harness = createHarness();
    await harness.service.syncForRoute(baseSync('create'));
    Object.assign(harness.contexts[0]!, timerState());
    const result = await harness.service.syncForRoute({ ...baseSync('new-no-op'), firstPublication: false, previousPublishedAt: NOW });
    expect(result).toMatchObject({ assignmentEpoch: '1', routeVersion: 1 });
    expect(harness.contexts[0]).toMatchObject(timerState());
    expect(harness.notifications).toHaveLength(1);
    observe('D03-03', 'ACCEPT', harness, result.notificationKinds);
  });

  test('D03-05, D03-06, and D03-07 bump content revision while preserving attribution and timer', async () => {
    for (const [id, mutate] of [
      ['D03-05', (h: Harness) => { h.routes['route-am']!.stops[0]!.quantity = 7; }],
      ['D03-06', (h: Harness) => {
        Object.assign(h.routes['route-am']!.stops[0]!, {
          address1: 'Busan 7', destinationId: 'destination-b', latitude: 35.1, longitude: 129.0,
        });
      }],
      ['D03-07', (h: Harness) => { h.routes['route-am']!.stops.reverse(); h.routes['route-am']!.stops.forEach((stop, index) => { stop.sequence = index + 1; }); }],
    ] as const) {
      covers(id);
      const harness = createHarness({ stopCount: 2 });
      if (id === 'D03-05') harness.routes['route-am']!.child.legacySnapshot = true;
      await harness.service.syncForRoute(baseSync(`create-${id}`));
      Object.assign(harness.contexts[0]!, timerState());
      mutate(harness);
      const result = await harness.service.syncForRoute({ ...baseSync(`edit-${id}`), firstPublication: false });
      expect(result).toMatchObject({ assignmentEpoch: '1', notificationKinds: ['N02'], routeVersion: 2 });
      expect(harness.contexts[0]).toMatchObject(timerState());
      observe(id, 'ACCEPT', harness, result.notificationKinds);
    }
  });

  test('D03-08 replaces driver attribution, ends old warnings, and resets the timer', async () => {
    covers('D03-08');
    const harness = createHarness();
    await harness.service.syncForRoute(baseSync('create-driver'));
    Object.assign(harness.contexts[0]!, timerState());
    harness.routes['route-am']!.driverId = 'driver-b';
    harness.routes['route-am']!.accountId = 'account-b';
    harness.routes['route-am']!.child.driverId = 'driver-b';
    const result = await harness.service.syncForRoute({ ...baseSync('replace-driver'), firstPublication: false });
    expect(result).toMatchObject({ assignmentEpoch: '2', notificationKinds: ['N03', 'N01'], routeVersion: 1 });
    expect(harness.contexts[0]).toMatchObject({
      departureObservedAt: null,
      driverId: 'driver-b',
      recipientAccountId: 'account-b',
      reminderDueAt: null,
      reminderOrdinal: 0,
      reminderStatus: 'AWAITING_FRESH_DEPARTURE',
    });
    expect(harness.notifications.find((item) => item.kind === 'N01' && item.assignmentEpoch === 1n)?.businessStatus).toBe('RESOLVED');
    observe('D03-08', 'ACCEPT', harness, result.notificationKinds);
  });

  test('D03-09 replaces only vehicle attribution and creates one content-change intent', async () => {
    covers('D03-09');
    const harness = createHarness();
    await harness.service.syncForRoute(baseSync('create-vehicle'));
    Object.assign(harness.contexts[0]!, timerState());
    harness.routes['route-am']!.vehicleId = 'vehicle-v2';
    const result = await harness.service.syncForRoute({ ...baseSync('replace-vehicle'), firstPublication: false });
    expect(result).toMatchObject({ assignmentEpoch: '2', notificationKinds: ['N02'], routeVersion: 1 });
    expect(harness.contexts[0]).toMatchObject({ vehicleId: 'vehicle-v2', reminderStatus: 'AWAITING_FRESH_DEPARTURE' });
    observe('D03-09', 'ACCEPT', harness, result.notificationKinds);
  });

  test('increments the epoch and releases the prior recipient when only the linked account changes', async () => {
    const harness = createHarness();
    await harness.service.syncForRoute(baseSync('create-account'));
    harness.driverAccounts['driver-a'] = 'account-b';
    const result = await harness.service.syncForRoute({ ...baseSync('replace-account'), firstPublication: false });
    expect(result).toMatchObject({ assignmentEpoch: '2', notificationKinds: ['N03', 'N01'], routeVersion: 1 });
    expect(harness.contexts[0]).toMatchObject({ driverId: 'driver-a', recipientAccountId: 'account-b' });
  });

  test('D03-10 rejects content changes to a closed execution', async () => {
    covers('D03-10');
    const harness = createHarness();
    await harness.service.syncForRoute(baseSync('create-closed'));
    Object.assign(harness.contexts[0]!, timerState(), {
      closedAt: NOW,
      reminderDueAt: null,
      reminderStatus: 'ENDED',
      startedAt: STARTED_AT,
      status: 'COMPLETED',
    });
    harness.notifications.forEach((item) => Object.assign(item, { businessStatus: 'RESOLVED', resolvedAt: NOW }));
    harness.routes['route-am']!.stops.push(stop('stop-extra', 2));
    harness.routes['route-am']!.child.stopIds.push('stop-extra');
    await expect(harness.service.syncForRoute({ ...baseSync('append-closed'), firstPublication: false }))
      .rejects.toMatchObject({ code: 'CLOSED_EXECUTION_CONTEXT' });
    expect(harness.contexts[0]).toMatchObject({ routeVersion: 1, status: 'COMPLETED' });
    observe('D03-10', 'REJECT_CLOSED_CONTEXT', harness, []);
  });

  test('D03-11 requires an explicit mapping for an already published route', async () => {
    covers('D03-11');
    const harness = createHarness({ routes: ['route-am', 'route-new'] });
    await harness.service.syncForRoute(baseSync('create-before-unmapped'));
    Object.assign(harness.contexts[0]!, timerState(), { startedAt: STARTED_AT });
    await harness.service.closeForRoute({ commandId: 'close-before-unmapped', now: NOW, reason: 'COMPLETED', routePlanId: 'route-am', shopId: 'shop-1' });
    const result = await harness.service.syncForRoute({
      commandId: 'unmapped-published',
      firstPublication: false,
      previousPublishedAt: NOW,
      routePlanId: 'route-new',
      shopId: 'shop-1',
    });
    expect(result.outcome).toBe('MAPPING_REQUIRED');
    expect(harness.contexts).toHaveLength(1);
    observe('D03-11', 'MAPPING_REQUIRED', harness, []);
  });

  test('D03-12 creates a distinct explicit new execution after a closed execution', async () => {
    covers('D03-12');
    const harness = createHarness({ routes: ['route-am', 'route-pm'] });
    await harness.service.syncForRoute(baseSync('create-am'));
    Object.assign(harness.contexts[0]!, timerState(), { startedAt: STARTED_AT });
    await harness.service.closeForRoute({ commandId: 'complete-am', now: NOW, reason: 'COMPLETED', routePlanId: 'route-am', shopId: 'shop-1' });
    const result = await harness.service.syncForRoute({
      commandId: 'create-pm',
      now: NOW,
      routePlanId: 'route-pm',
      shopId: 'shop-1',
      tripIntent: 'NEW_EXECUTION',
    });
    expect(result).toMatchObject({ assignmentEpoch: '1', outcome: 'ACCEPT', routeVersion: 1 });
    expect(harness.contexts.map((item) => item.id)).toHaveLength(2);
    expect(harness.contexts[0]!.id).not.toBe(harness.contexts[1]!.id);
    observe('D03-12', 'ACCEPT', harness, result.notificationKinds);
  });

  test('D03-13 defers ambiguous vehicle attribution without an explicit selection', async () => {
    covers('D03-13');
    const harness = createHarness({ routes: ['route-am', 'route-pm'] });
    await harness.service.syncForRoute(baseSync('am'));
    Object.assign(harness.contexts[0]!, timerState());
    await harness.service.syncForRoute({ ...baseSync('pm', 'route-pm'), tripIntent: 'NEW_EXECUTION' });
    await expect(harness.service.resolveSelectedExecution({ at: NOW, shopId: 'shop-1', vehicleId: 'vehicle-v1' })).resolves.toBeNull();
    observe('D03-13', 'DEFER_AMBIGUOUS_ATTRIBUTION', harness, []);
  });

  test('D03-14 uses a bounded explicit vehicle selection without changing execution state', async () => {
    covers('D03-14');
    const harness = createHarness({ routes: ['route-am', 'route-pm'] });
    const am = await harness.service.syncForRoute(baseSync('am-select'));
    Object.assign(harness.contexts[0]!, timerState());
    await harness.service.syncForRoute({ ...baseSync('pm-select', 'route-pm'), tripIntent: 'NEW_EXECUTION' });
    await harness.service.selectActiveExecution({
      commandId: 'select-am', executionContextId: am.executionContextId!, shopId: 'shop-1',
      validFrom: new Date(NOW.getTime() - 1000), validUntil: new Date(NOW.getTime() + 60_000), vehicleId: 'vehicle-v1',
    });
    const selected = await harness.service.resolveSelectedExecution({ at: NOW, shopId: 'shop-1', vehicleId: 'vehicle-v1' });
    expect(selected?.id).toBe(am.executionContextId);
    expect(harness.contexts.every((item) => item.routeVersion === 1 && item.assignmentEpoch === 1n)).toBe(true);
    observe('D03-14', 'ACCEPT', harness, [], selected?.id ?? null);
  });

  test('D03-15 rebinds a replacement route only with SAME_EXECUTION', async () => {
    covers('D03-15');
    const harness = createHarness({ routes: ['route-am', 'route-am-replacement'] });
    harness.routes['route-am-replacement']!.stops = structuredClone(harness.routes['route-am']!.stops);
    harness.routes['route-am-replacement']!.child.stopIds = harness.routes['route-am-replacement']!.stops.map((item) => item.id);
    const created = await harness.service.syncForRoute(baseSync('create-route'));
    Object.assign(harness.contexts[0]!, timerState());
    const result = await harness.service.syncForRoute({
      commandId: 'replace-route', executionContextId: created.executionContextId!, now: NOW,
      routePlanId: 'route-am-replacement', shopId: 'shop-1', tripIntent: 'SAME_EXECUTION',
    });
    expect(result).toMatchObject({ executionContextId: created.executionContextId, routePlanId: 'route-am-replacement', routeVersion: 1 });
    expect(harness.contexts[0]!.routePlanId).toBe('route-am-replacement');
    expect(harness.mappings.filter((item) => item.validUntil === null).map((item) => item.routePlanId)).toEqual(['route-am-replacement']);
    observe('D03-15', 'ACCEPT', harness, result.notificationKinds);
  });

  test('D03-16 closes an execution and resolves warnings without reopening it', async () => {
    covers('D03-16');
    const harness = createHarness();
    await harness.service.syncForRoute(baseSync('create-complete'));
    Object.assign(harness.contexts[0]!, timerState(), { startedAt: STARTED_AT });
    const result = await harness.service.closeForRoute({ commandId: 'complete', now: NOW, reason: 'COMPLETED', routePlanId: 'route-am', shopId: 'shop-1' });
    expect(result).toMatchObject({ outcome: 'ACCEPT', status: 'COMPLETED' });
    expect(harness.contexts[0]).toMatchObject({ closedAt: NOW, reminderDueAt: null, reminderStatus: 'ENDED', status: 'COMPLETED' });
    expect(harness.notifications.every((item) => item.businessStatus === 'RESOLVED')).toBe(true);
    observe('D03-16', 'ACCEPT', harness, []);
  });

  test('cancellation keeps selection history clipped and creates a release intent', async () => {
    const harness = createHarness();
    const created = await harness.service.syncForRoute(baseSync('create-cancel'));
    await harness.service.selectActiveExecution({
      commandId: 'select-cancel', executionContextId: created.executionContextId!, shopId: 'shop-1',
      validFrom: new Date(NOW.getTime() - 60_000), validUntil: new Date(NOW.getTime() + 60_000), vehicleId: 'vehicle-v1',
    });
    await harness.service.closeForRoute({ commandId: 'cancel', now: NOW, reason: 'CANCELLED', routePlanId: 'route-am', shopId: 'shop-1' });
    expect(harness.selections).toHaveLength(1);
    expect(harness.selections[0]!.validUntil).toEqual(NOW);
    expect(harness.notifications.at(-1)).toMatchObject({ businessStatus: 'OPEN', kind: 'N03' });
  });

  test('sync closes a newly cancelled legacy route and reports the release intent', async () => {
    const harness = createHarness();
    await harness.service.syncForRoute(baseSync('create-cancel-sync'));
    harness.routes['route-am']!.status = 'CANCELLED';
    const result = await harness.service.syncForRoute({ ...baseSync('cancel-sync'), firstPublication: false });
    expect(result).toMatchObject({ notificationKinds: ['N03'], outcome: 'ACCEPT' });
    expect(harness.contexts[0]).toMatchObject({ reminderStatus: 'ENDED', status: 'CANCELLED' });
  });

  test('rejects overlapping selection intervals and resolves historical intervals by timestamp', async () => {
    const harness = createHarness();
    const created = await harness.service.syncForRoute(baseSync('create-overlap'));
    const selection = {
      executionContextId: created.executionContextId!, shopId: 'shop-1',
      validFrom: new Date(NOW.getTime() - 60_000), validUntil: new Date(NOW.getTime() + 60_000), vehicleId: 'vehicle-v1',
    };
    await harness.service.selectActiveExecution({ ...selection, commandId: 'selection-one' });
    await expect(harness.service.selectActiveExecution({ ...selection, commandId: 'selection-two' }))
      .rejects.toMatchObject({ code: 'SELECTION_INTERVAL_OVERLAP' });
    await expect(harness.service.resolveSelectedExecution({ at: NOW, shopId: 'shop-1', vehicleId: 'vehicle-v1' }))
      .resolves.toMatchObject({ id: created.executionContextId });
  });

  test('serializes implicit first publication by shop, vehicle, and service date', async () => {
    const harness = createHarness({ routes: ['route-am', 'route-pm'] });
    await harness.service.syncForRoute(baseSync('implicit-am'));
    const second = await harness.service.syncForRoute(baseSync('implicit-pm', 'route-pm'));
    expect(second).toMatchObject({ executionContextId: null, outcome: 'MAPPING_REQUIRED' });
    expect(harness.contexts).toHaveLength(1);
    expect(JSON.stringify(harness.tx.$queryRaw.mock.calls)).toContain('vehicle-service-date:vehicle-v1:2026-10-05');
  });

  test('rejects SAME_EXECUTION rebind before the context, mapping, or publication effective time', async () => {
    const harness = createHarness({ routes: ['route-am', 'route-am-replacement'] });
    harness.routes['route-am-replacement']!.stops = structuredClone(harness.routes['route-am']!.stops);
    harness.routes['route-am-replacement']!.child.stopIds = harness.routes['route-am-replacement']!.stops.map((item) => item.id);
    const created = await harness.service.syncForRoute(baseSync('effective-create'));
    await expect(harness.service.syncForRoute({
      commandId: 'stale-rebind', executionContextId: created.executionContextId!,
      now: new Date(NOW.getTime() - 1), routePlanId: 'route-am-replacement', shopId: 'shop-1',
      tripIntent: 'SAME_EXECUTION',
    })).rejects.toMatchObject({ code: 'MAPPING_EFFECTIVE_TIME_INVALID' });
    expect(harness.mappings.filter((item) => item.validUntil === null).map((item) => item.routePlanId)).toEqual(['route-am']);
    expect(harness.contexts[0]!.routePlanId).toBe('route-am');

    const unpublishedAtEffectiveTime = createHarness();
    await expect(unpublishedAtEffectiveTime.service.syncForRoute({
      ...baseSync('stale-explicit-new'), now: new Date(NOW.getTime() - 1), tripIntent: 'NEW_EXECUTION',
    })).rejects.toMatchObject({ code: 'MAPPING_EFFECTIVE_TIME_INVALID' });
    expect(unpublishedAtEffectiveTime.contexts).toEqual([]);
  });

  test('does not resolve OPS N07 when execution warnings are closed', async () => {
    const harness = createHarness();
    const created = await harness.service.syncForRoute(baseSync('ops-report-create'));
    harness.notifications.push({
      assignmentEpoch: 1n,
      audience: 'OPS',
      businessStatus: 'OPEN',
      executionContextId: created.executionContextId,
      id: 'ops-notification',
      kind: 'N07',
      logicalKey: 'N07:ops-report',
      recipientAccountId: null,
      routeVersion: 1,
    });
    await harness.service.closeForRoute({
      commandId: 'close-with-open-report', now: NOW, reason: 'COMPLETED', routePlanId: 'route-am', shopId: 'shop-1',
    });
    expect(harness.notifications.find((item) => item.id === 'ops-notification')).toMatchObject({
      audience: 'OPS', businessStatus: 'OPEN', kind: 'N07',
    });
    expect(harness.notifications.find((item) => item.kind === 'N01')).toMatchObject({ businessStatus: 'RESOLVED' });
  });

  test('resolves both driver arrival and start warnings when start is newly observed', async () => {
    const harness = createHarness();
    const created = await harness.service.syncForRoute(baseSync('start-warning-create'));
    for (const kind of ['N04', 'N05']) {
      harness.notifications.push({
        assignmentEpoch: 1n, audience: 'DRIVER', businessStatus: 'OPEN', executionContextId: created.executionContextId,
        id: `notification-${kind}`, kind, logicalKey: `${kind}:warning`, recipientAccountId: 'account-a', routeVersion: 1,
      });
    }
    harness.routes['route-am']!.startedAt = STARTED_AT;
    await harness.service.syncForRoute({ ...baseSync('start-observed'), firstPublication: false });
    expect(harness.notifications.filter((item) => item.kind === 'N04' || item.kind === 'N05'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ businessStatus: 'RESOLVED', kind: 'N04' }),
        expect.objectContaining({ businessStatus: 'RESOLVED', kind: 'N05' }),
      ]));
  });

  test('D03-17 rejects command reuse with a different payload', async () => {
    covers('D03-17');
    const harness = createHarness({ routes: ['route-am', 'route-pm'] });
    const created = await harness.service.syncForRoute(baseSync('conflict'));
    Object.assign(harness.contexts[0]!, timerState());
    await expect(harness.service.syncForRoute({
      ...baseSync('conflict'), executionContextId: created.executionContextId!, tripIntent: 'SAME_EXECUTION',
    }))
      .rejects.toBeInstanceOf(DsvExecutionContextError);
    expect(harness.contexts).toHaveLength(1);
    observe('D03-17', 'REJECT_COMMAND_CONFLICT', harness, []);
  });

  test('D03-18 preserves execution when a downstream snapshot guard rejects after the canonical import conflict', async () => {
    covers('D03-18');
    const harness = createHarness();
    await harness.service.syncForRoute(baseSync('create-import-conflict'));
    Object.assign(harness.contexts[0]!, timerState(), {
      reminderDueAt: null,
      reminderStatus: 'RESOLVED_START',
      startedAt: STARTED_AT,
    });
    const before = structuredClone(harness.contexts[0]);
    harness.routes['route-am']!.child.stopIds = ['foreign-stop'];
    await expect(harness.service.syncForRoute({ ...baseSync('invalid-current-snapshot'), firstPublication: false }))
      .rejects.toMatchObject({ code: 'ROUTE_CURRENT_SNAPSHOT_INVALID' });
    expect(harness.contexts[0]).toEqual(before);
    observe('D03-18', 'REJECT_IMPORT_CONFLICT', harness, []);
  });

  test('D03-19 and D03-20 ignore metadata and upload text outside the content and attribution contract', async () => {
    covers('D03-19'); covers('D03-20');
    const harness = createHarness();
    await harness.service.syncForRoute(baseSync('create-metadata'));
    Object.assign(harness.contexts[0]!, timerState());
    harness.routes['route-am']!.planningColor = 'green';
    harness.routes['route-am']!.uploadDriverName = 'Driver B';
    const result = await harness.service.syncForRoute({ ...baseSync('metadata-only'), firstPublication: false });
    expect(result).toMatchObject({ assignmentEpoch: '1', notificationKinds: [], routeVersion: 1 });
    observe('D03-19', 'ACCEPT', harness, result.notificationKinds);
    observe('D03-20', 'ACCEPT', harness, result.notificationKinds);
  });

  test('D03-21 increments both content revisions when one stop moves between executions', async () => {
    covers('D03-21');
    const harness = createHarness({ routes: ['route-source', 'route-target'], stopCount: 2 });
    const source = await harness.service.syncForRoute(baseSync('create-source', 'route-source'));
    Object.assign(harness.contexts[0]!, timerState());
    const target = await harness.service.syncForRoute({ ...baseSync('create-target', 'route-target'), tripIntent: 'NEW_EXECUTION' });
    const moved = harness.routes['route-source']!.stops.pop()!;
    harness.routes['route-source']!.child.stopIds = harness.routes['route-source']!.stops.map((item) => item.id);
    moved.sequence = harness.routes['route-target']!.stops.length + 1;
    harness.routes['route-target']!.stops.push(moved);
    harness.routes['route-target']!.child.stopIds.push(moved.id);
    const sourceResult = await harness.service.syncForRoute({ ...baseSync('move-source', 'route-source'), firstPublication: false });
    const targetResult = await harness.service.syncForRoute({ ...baseSync('move-target', 'route-target'), firstPublication: false });
    expect([sourceResult.routeVersion, targetResult.routeVersion]).toEqual([2, 2]);
    expect([sourceResult.executionContextId, targetResult.executionContextId]).toEqual([source.executionContextId, target.executionContextId]);
    expect([sourceResult.assignmentEpoch, targetResult.assignmentEpoch]).toEqual(['1', '1']);
    observe('D03-21', 'ACCEPT', harness, [...sourceResult.notificationKinds, ...targetResult.notificationKinds]);
  });

  test('D03-22 does not mutate execution when only the vehicle default driver changes', async () => {
    covers('D03-22');
    const harness = createHarness();
    await harness.service.syncForRoute(baseSync('create-default-link'));
    Object.assign(harness.contexts[0]!, timerState());
    harness.defaultVehicleDriverId = 'driver-b';
    const result = await harness.service.syncForRoute({ ...baseSync('default-link-only'), firstPublication: false });
    expect(result).toMatchObject({ assignmentEpoch: '1', notificationKinds: [], routeVersion: 1 });
    expect(harness.contexts[0]!.driverId).toBe('driver-a');
    observe('D03-22', 'ACCEPT', harness, result.notificationKinds);
  });

  test('D03-23 preserves accepted start while an in-progress reorder bumps content revision', async () => {
    covers('D03-23');
    const harness = createHarness({ startedAt: STARTED_AT, stopCount: 2 });
    await harness.service.syncForRoute(baseSync('create-started'));
    Object.assign(harness.contexts[0]!, timerState(), { reminderDueAt: null, reminderStatus: 'RESOLVED_START' });
    harness.routes['route-am']!.stops.reverse();
    harness.routes['route-am']!.stops.forEach((item, index) => { item.sequence = index + 1; });
    const result = await harness.service.syncForRoute({ ...baseSync('reorder-started'), firstPublication: false });
    expect(result.routeVersion).toBe(2);
    expect(harness.contexts[0]).toMatchObject({ reminderDueAt: null, reminderStatus: 'RESOLVED_START', startedAt: STARTED_AT });
    observe('D03-23', 'ACCEPT', harness, result.notificationKinds);
  });

  test('keeps the content revision when only business stop status changes', async () => {
    const harness = createHarness();
    await harness.service.syncForRoute(baseSync('create-status'));
    harness.routes['route-am']!.stops[0]!.status = 'ARRIVED';
    const result = await harness.service.syncForRoute({ ...baseSync('status-only'), firstPublication: false });
    expect(result).toMatchObject({ notificationKinds: [], routeVersion: 1 });
    expect(harness.contexts[0]!.contentSnapshot.stops[0].status).toBe('ARRIVED');
  });

  test('uses a finite positive context notification TTL and keeps the storage fallback for OFF contexts', async () => {
    const configured = createHarness();
    await configured.service.syncForRoute(baseSync('create-ttl'));
    configured.contexts[0]!.policy = { notificationTtlSeconds: 90 };
    configured.routes['route-am']!.stops[0]!.quantity += 1;
    await configured.service.syncForRoute({ ...baseSync('update-ttl'), firstPublication: false });
    expect(configured.notifications.at(-1)!.expiresAt).toEqual(new Date(NOW.getTime() + 90_000));

    const fallback = createHarness();
    await fallback.service.syncForRoute(baseSync('create-fallback-ttl'));
    expect(fallback.notifications[0]!.expiresAt).toEqual(new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000));
  });

  test('the executable cases match all 23 P0 fixture identity, timer, and notification expectations', () => {
    expect([...covered].sort()).toEqual(D03_FIXTURE.cases.map((item) => item.id).sort());
    for (const fixtureCase of D03_FIXTURE.cases) {
      assertObservedMatchesFixture(fixtureCase, observed.get(fixtureCase.id));
    }
  });
});

type Stop = {
  address1: string; address2: string | null; countryCode: string; destinationId: string; id: string;
  latitude: number | null; longitude: number | null; orderId: string; postalCode: string;
  quantity: number; sequence: number; status: string;
};
type D03Fixture = {
  cases: D03FixtureCase[];
};
type D03FixtureCase = {
  id: string;
  proposal: {
    expected: {
      after: unknown;
      identityTransition: Record<string, string>;
      newIntents: Array<{ kind: string; logicalCount: number; recipient: string }>;
      oldNotifications: { action: string; scope: string };
      outcome: string;
      timerAction: string;
    };
  };
};
type D03Observed = {
  after: unknown;
  newIntents: Array<{ kind: string; logicalCount: number; recipient: string }>;
  notifications: Array<{
    assignmentEpoch: string;
    businessStatus: string;
    executionContextId: string;
    kind: string;
  }>;
  outcome: string;
};
type Route = {
  accountId: string | null;
  child: { driverId: string; id: string; legacySnapshot?: boolean; publishedAt: Date | null; stopIds: string[] };
  driverId: string | null;
  planningColor?: string;
  routePlanId: string;
  startedAt: Date | null;
  status: string;
  stops: Stop[];
  uploadDriverName?: string;
  vehicleId: string | null;
};
type Harness = ReturnType<typeof createHarness>;

function createHarness(options: { routes?: string[]; startedAt?: Date | null; stopCount?: number } = {}) {
  const contexts: Array<Record<string, any>> = [];
  const mappings: Array<Record<string, any>> = [];
  const selections: Array<Record<string, any>> = [];
  const commands: Array<Record<string, any>> = [];
  const notifications: Array<Record<string, any>> = [];
  const routeIds = options.routes ?? ['route-am'];
  const routes = Object.fromEntries(routeIds.map((routePlanId) => {
    const stops = Array.from({ length: options.stopCount ?? 1 }, (_, index) => stop(`${routePlanId}-stop-${index + 1}`, index + 1));
    return [routePlanId, {
      accountId: routePlanId.includes('target') ? 'account-b' : 'account-a',
      child: { driverId: routePlanId.includes('target') ? 'driver-b' : 'driver-a', id: `${routePlanId}-child`, publishedAt: NOW, stopIds: stops.map((item) => item.id) },
      driverId: routePlanId.includes('target') ? 'driver-b' : 'driver-a',
      routePlanId,
      startedAt: options.startedAt ?? null,
      status: options.startedAt === undefined || options.startedAt === null ? 'READY' : 'IN_PROGRESS',
      stops,
      vehicleId: routePlanId.includes('target') ? 'vehicle-v2' : 'vehicle-v1',
    } satisfies Route];
  })) as Record<string, Route>;
  const driverAccounts: Record<string, string | null> = { 'driver-a': 'account-a', 'driver-b': 'account-b' };
  let id = 0;
  const nextId = (prefix: string) => `${prefix}-${++id}`;

  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ locked: 1 }]),
    driver: { findUnique: vi.fn(async ({ where }: any) => {
      const driverId = where.id_shopId.id as string;
      return driverId in driverAccounts ? { accountId: driverAccounts[driverId], status: 'ACTIVE' } : null;
    }) },
    driverAccount: { findUnique: vi.fn(async ({ where }: any) => where.id.startsWith('account-') ? { status: 'ACTIVE' } : null) },
    vehicle: { findUnique: vi.fn(async ({ where }: any) => where.id_shopId.id.startsWith('vehicle-') ? { status: 'ACTIVE' } : null) },
    routePlan: { findUnique: vi.fn(async ({ where }: any) => {
      const route = routes[where.id_shopId.id];
      if (route === undefined || where.id_shopId.shopId !== 'shop-1') return null;
      return {
        depotLatitude: 37.5, depotLongitude: 127.0, driverId: route.driverId, id: route.routePlanId,
        planDate: new Date('2026-10-05T00:00:00.000Z'),
        driverEvents: route.startedAt === null ? [] : [{ occurredAt: route.startedAt }],
        routeStops: route.stops.map((item) => ({
          deliveryStop: {
            address1: item.address1, address2: item.address2, countryCode: item.countryCode,
            latitude: item.latitude, longitude: item.longitude,
            order: { destinationId: item.destinationId, id: item.orderId, rawPayload: { dsv: { normalized: { shippedBoxes: item.quantity } } }, sellerOrderSourceKind: 'DSV_DISPATCH' },
            postalCode: item.postalCode,
            status: item.status,
          },
          deliveryStopId: item.id, sequence: item.sequence,
        })),
        status: route.status, vehicleId: route.vehicleId,
      };
    }) },
    routeGroupingChildVersion: { findFirst: vi.fn(async ({ where }: any) => {
      const route = routes[where.routePlanId];
      return route === undefined ? null : {
        driverId: route.child.driverId, id: route.child.id, publishedAt: route.child.publishedAt,
        snapshot: route.child.legacySnapshot === true
          ? { deliveryStopIds: route.child.stopIds }
          : { membershipSchemaVersion: 1, stops: route.child.stopIds.map((deliveryStopId, sequence) => ({ deliveryStopId, sequence: sequence + 1 })) },
      };
    }) },
    dsvExecutionCommand: {
      create: vi.fn(async ({ data }: any) => { const row = { id: nextId('command'), ...data }; commands.push(row); return row; }),
      findUnique: vi.fn(async ({ where }: any) => commands.find((item) => item.shopId === where.shopId_commandName_commandId.shopId
        && item.commandName === where.shopId_commandName_commandId.commandName
        && item.commandId === where.shopId_commandName_commandId.commandId) ?? null),
    },
    dsvExecutionContext: {
      create: vi.fn(async ({ data }: any) => { const row = {
        closedAt: null, departureObservedAt: null, id: nextId('context'), reminderDueAt: null,
        reminderIncidentId: null, reminderOrdinal: 0, startedAt: null, ...data,
      }; contexts.push(row); return row; }),
      findFirst: vi.fn(async ({ where }: any) => contexts.find((item) => matches(item, where)) ?? null),
      findMany: vi.fn(async ({ take, where }: any) => contexts.filter((item) => matches(item, where)).slice(0, take)),
      update: vi.fn(async ({ data, where }: any) => {
        const row = contexts.find((item) => item.id === where.id_shopId.id && item.shopId === where.id_shopId.shopId)!;
        Object.assign(row, data); return row;
      }),
    },
    dsvExecutionRouteMapping: {
      create: vi.fn(async ({ data }: any) => { const row = { id: nextId('mapping'), validUntil: null, ...data }; mappings.push(row); return row; }),
      findFirst: vi.fn(async ({ where }: any) => [...mappings].reverse().find((item) => matches(item, where)) ?? null),
      updateMany: vi.fn(async ({ data, where }: any) => updateMany(mappings, where, data)),
    },
    dsvExecutionSelection: {
      deleteMany: vi.fn(async ({ where }: any) => removeMany(selections, where)),
      create: vi.fn(async ({ data }: any) => { const row = { id: nextId('selection'), ...data }; selections.push(row); return row; }),
      findFirst: vi.fn(async ({ where }: any) => [...selections].reverse().find((item) => matches(item, where)) ?? null),
      updateMany: vi.fn(async ({ data, where }: any) => updateMany(selections, where, data)),
    },
    dsvOperationalNotification: {
      updateMany: vi.fn(async ({ data, where }: any) => updateMany(notifications, where, data)),
      upsert: vi.fn(async ({ create, where }: any) => {
        const existing = notifications.find((item) => item.logicalKey === where.logicalKey);
        if (existing !== undefined) return existing;
        const row = { id: nextId('notification'), businessStatus: 'OPEN', ...create }; notifications.push(row); return row;
      }),
    },
  };
  return {
    commands, contexts, defaultVehicleDriverId: 'driver-a', driverAccounts, mappings, notifications, routes, selections,
    service: new PrismaDsvExecutionContextService(tx as never), tx,
  };
}

function baseSync(commandId: string, routePlanId = 'route-am') {
  return { commandId, firstPublication: true, now: NOW, routePlanId, shopId: 'shop-1' } as const;
}

function stop(id: string, sequence: number): Stop {
  return {
    address1: `Seoul ${sequence}`, address2: null, countryCode: 'KR', destinationId: `${id}-destination`,
    id, latitude: 37.5 + sequence / 100, longitude: 127 + sequence / 100,
    orderId: `${id}-order`, postalCode: `0000${sequence}`, quantity: 3, sequence, status: 'PENDING',
  };
}

function timerState() {
  return {
    departureObservedAt: STARTED_AT,
    reminderDueAt: new Date('2026-10-05T22:40:00.000Z'),
    reminderIncidentId: 'incident-am',
    reminderOrdinal: 1,
    reminderStatus: 'RUNNING',
  };
}

function observedCase(
  id: string,
  outcome: string,
  harness: Harness,
  notificationKinds: string[],
  activeExecutionContextId: string | null,
): D03Observed {
  const contexts = harness.contexts.map(normalizeContext);
  const byRoute = (routePlanId: string) => {
    const context = contexts.find((item) => item.routePlanId === routePlanId);
    if (context === undefined) throw new Error(`${id}: missing context for ${routePlanId}`);
    return context;
  };
  let after: unknown;
  if (id === 'D03-11') {
    after = { oldContext: byRoute('route-am'), newExecutionContext: null, unmappedRoutePlanId: 'route-new' };
  } else if (id === 'D03-12') {
    after = { oldContext: byRoute('route-am'), newContext: byRoute('route-pm') };
  } else if (id === 'D03-13' || id === 'D03-14') {
    after = {
      activeExecutionContextId: activeExecutionContextId === null
        ? null
        : symbolicContextId(harness.contexts.find((item) => item.id === activeExecutionContextId)!),
      contexts: [...contexts].sort((left, right) => left.routePlanId.localeCompare(right.routePlanId)),
    };
  } else if (id === 'D03-21') {
    after = { source: byRoute('route-source'), target: byRoute('route-target') };
  } else {
    if (contexts.length !== 1) throw new Error(`${id}: expected one context, got ${contexts.length}`);
    [after] = contexts;
  }

  const createdNotifications = notificationKinds.length === 0
    ? []
    : harness.notifications.slice(-notificationKinds.length);
  const newIntents = createdNotifications.map((notification) => ({
    kind: notification.kind as string,
    logicalCount: 1,
    recipient: symbolicRecipient(notification.recipientAccountId as string),
  }));
  return {
    after,
    newIntents,
    notifications: harness.notifications.map((notification) => ({
      assignmentEpoch: String(notification.assignmentEpoch),
      businessStatus: notification.businessStatus as string,
      executionContextId: symbolicContextId(harness.contexts.find((item) => item.id === notification.executionContextId)!),
      kind: notification.kind as string,
    })),
    outcome,
  };
}

function normalizeContext(context: Record<string, any>) {
  return {
    assignmentEpoch: String(context.assignmentEpoch),
    contextStatus: context.status as string,
    driverId: symbolicDriver(context.driverId as string),
    executionContextId: symbolicContextId(context),
    routePlanId: context.routePlanId as string,
    routeVersion: context.routeVersion as number,
    startApproved: context.startedAt !== null,
    timer: {
      departureObservedAt: isoSeconds(context.departureObservedAt as Date | null),
      dueAt: isoSeconds(context.reminderDueAt as Date | null),
      incidentId: context.reminderIncidentId as string | null,
      ordinal: context.reminderOrdinal as number,
      status: context.reminderStatus as string,
    },
    vehicleId: symbolicVehicle(context.vehicleId as string),
  };
}

function symbolicContextId(context: Record<string, any>): string {
  const routePlanId = context.routePlanId as string;
  if (routePlanId === 'route-target') return 'ctx-target';
  if (routePlanId === 'route-pm') return 'ctx-pm';
  return 'ctx-am';
}

function symbolicDriver(driverId: string): string {
  return driverId.replace(/^driver-([a-z])$/, (_match, suffix: string) => `driver-${suffix.toUpperCase()}`);
}

function symbolicVehicle(vehicleId: string): string {
  return vehicleId.replace(/^vehicle-v(\d+)$/, 'vehicle-V$1');
}

function symbolicRecipient(accountId: string): string {
  return accountId.replace(/^account-([a-z])$/, (_match, suffix: string) => `driver-${suffix.toUpperCase()}`);
}

function isoSeconds(value: Date | null): string | null {
  return value === null ? null : value.toISOString().replace('.000Z', 'Z');
}

function assertObservedMatchesFixture(fixtureCase: D03FixtureCase, observed: D03Observed | undefined): void {
  expect(observed, `${fixtureCase.id}: executable observation`).toBeDefined();
  expect(observed!.outcome, `${fixtureCase.id}: outcome`).toBe(fixtureCase.proposal.expected.outcome);
  expect(observed!.after, `${fixtureCase.id}: identity, versions, attribution, status, and timer`).toEqual(
    fixtureCase.proposal.expected.after,
  );
  expect(observed!.newIntents, `${fixtureCase.id}: logical notification intents`).toEqual(
    fixtureCase.proposal.expected.newIntents,
  );
  assertNotificationTransition(
    fixtureCase.id,
    fixtureCase.proposal.expected.oldNotifications.action,
    observed!.notifications,
    fixtureCase.proposal.expected.newIntents.reduce((sum, intent) => sum + intent.logicalCount, 0),
  );
}

function assertNotificationTransition(
  id: string,
  action: string,
  notifications: D03Observed['notifications'],
  newIntentCount: number,
): void {
  const prior = newIntentCount === 0 ? notifications : notifications.slice(0, -newIntentCount);
  switch (action) {
    case 'NONE':
      expect(prior, `${id}: no prior notification`).toEqual([]);
      break;
    case 'KEEP':
    case 'REBIND_CONTENT_TARGET':
      expect(prior.length, `${id}: retained prior notification`).toBeGreaterThan(0);
      expect(prior.every((item) => item.businessStatus === 'OPEN'), `${id}: prior notifications stay open`).toBe(true);
      break;
    case 'KEEP_TERMINAL':
      expect(prior.length, `${id}: retained terminal notification history`).toBeGreaterThan(0);
      expect(prior.every((item) => item.businessStatus === 'RESOLVED'), `${id}: terminal notifications stay resolved`).toBe(true);
      break;
    case 'SUPERSEDE_CONTENT_LINKS':
    case 'CANCEL_AFFECTED_VISIT_LINKS':
    case 'END_PREVIOUS_EPOCH':
    case 'RESOLVE_ALL':
    case 'CANCEL_MOVED_STOP_LINKS':
      expect(prior.length, `${id}: prior notification exists`).toBeGreaterThan(0);
      expect(prior.every((item) => item.businessStatus === 'RESOLVED'), `${id}: prior notifications are resolved`).toBe(true);
      break;
    default:
      throw new Error(`${id}: unsupported fixture notification action ${action}`);
  }
}

function matches(row: Record<string, any>, where: Record<string, any>): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (expected !== null && typeof expected === 'object' && !Array.isArray(expected) && 'in' in expected) {
      return (expected.in as unknown[]).includes(row[key]);
    }
    if (expected !== null && typeof expected === 'object' && !Array.isArray(expected)) {
      const actual = row[key] instanceof Date ? row[key].getTime() : row[key];
      const operators = expected as Record<string, any>;
      return (operators.lt === undefined || actual < new Date(operators.lt).getTime())
        && (operators.lte === undefined || actual <= new Date(operators.lte).getTime())
        && (operators.gt === undefined || actual > new Date(operators.gt).getTime())
        && (operators.gte === undefined || actual >= new Date(operators.gte).getTime());
    }
    return row[key] === expected;
  });
}

function updateMany(rows: Array<Record<string, any>>, where: Record<string, any>, data: Record<string, any>) {
  const selected = rows.filter((item) => matches(item, where));
  selected.forEach((item) => Object.assign(item, data));
  return { count: selected.length };
}

function removeMany(rows: Array<Record<string, any>>, where: Record<string, any>) {
  let count = 0;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (matches(rows[index]!, where)) { rows.splice(index, 1); count += 1; }
  }
  return { count };
}
