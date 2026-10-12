import { describe, expect, test, vi } from 'vitest';

import {
  DriverDestinationCompletionCollisionError,
  DriverEventContextError,
  DriverEventScopeError,
  DriverEventStopTransitionConflictError,
  PrismaDriverEventRepository,
  isDriverDestinationCompletionNotAppliedError,
} from '../src/modules/driver/driver-event.repository.js';
import { PrismaDriverEventReceiptRepository } from '../src/modules/driver/driver-event-receipt.repository.js';

const input = {
  clientEventId: 'destination-1:delivered:1',
  completionOwnerAccountId: 'account-1',
  deliveryStopIds: ['stop-1', 'stop-2'],
  destinationId: 'destination-1',
  driverId: 'driver-1',
  occurredAt: new Date('2026-08-05T03:00:00.000Z'),
  payload: { deliveryStopIds: ['stop-1', 'stop-2'] },
  routePlanId: 'route-1',
  shopDomain: 'dsv.example.test',
  shopId: 'shop-1',
};

describe('Driver destination completion repository', () => {
  test('records one idempotent STOP_DELIVERED event for every validated order stop', async () => {
    const prisma = {
      deliveryStop: { findMany: vi.fn().mockResolvedValue([{ id: 'stop-1' }, { id: 'stop-2' }]) },
    };
    const repository = new PrismaDriverEventRepository(prisma as never);
    const recordDriverEvent = vi.spyOn(repository, 'recordDriverEvent')
      .mockResolvedValueOnce({ duplicate: false, eventId: 'event-1' })
      .mockResolvedValueOnce({ duplicate: false, eventId: 'event-2' });

    await expect(repository.completeDeliveryDestination(input)).resolves.toHaveLength(2);
    expect(recordDriverEvent).toHaveBeenCalledTimes(2);
    expect(recordDriverEvent).toHaveBeenNthCalledWith(1, expect.objectContaining({
      clientEventId: 'destination-1:delivered:1:stop-1',
      completionOwnerAccountId: 'account-1',
      deliveryStopId: 'stop-1',
      eventType: 'STOP_DELIVERED',
    }));
    expect(recordDriverEvent.mock.calls[0]?.[0].payload).toMatchObject({
      completionOwnerAccountId: 'account-1',
      occurredAt: '2026-08-05T03:00:00.000Z',
    });
    expect(recordDriverEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({
      clientEventId: 'destination-1:delivered:1:stop-2',
      deliveryStopId: 'stop-2',
      eventType: 'STOP_DELIVERED',
    }));
  });

  test('rejects the whole request before recording when a stop is outside the destination', async () => {
    const repository = new PrismaDriverEventRepository({
      deliveryStop: { findMany: vi.fn().mockResolvedValue([{ id: 'stop-1' }]) },
    } as never);
    const recordDriverEvent = vi.spyOn(repository, 'recordDriverEvent');

    const error = await repository.completeDeliveryDestination(input).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(DriverEventScopeError);
    expect(isDriverDestinationCompletionNotAppliedError(error)).toBe(true);
    expect(recordDriverEvent).not.toHaveBeenCalled();
  });

  test('overrides a forged completion owner in the client payload', async () => {
    const repository = new PrismaDriverEventRepository({
      deliveryStop: { findMany: vi.fn().mockResolvedValue([{ id: 'stop-1' }, { id: 'stop-2' }]) },
    } as never);
    const recordDriverEvent = vi.spyOn(repository, 'recordDriverEvent')
      .mockResolvedValue({ duplicate: false, eventId: 'event-id' });

    await repository.completeDeliveryDestination({
      ...input,
      payload: { completionOwnerAccountId: 'forged-account' },
    });

    expect(recordDriverEvent.mock.calls[0]?.[0].payload).toMatchObject({
      completionOwnerAccountId: 'account-1',
    });
  });

  test('does not mark a partial sequential completion as not applied', async () => {
    const repository = new PrismaDriverEventRepository({
      deliveryStop: { findMany: vi.fn().mockResolvedValue([{ id: 'stop-1' }, { id: 'stop-2' }]) },
    } as never);
    vi.spyOn(repository, 'recordDriverEvent')
      .mockResolvedValueOnce({ duplicate: false, eventId: 'event-1' })
      .mockRejectedValueOnce(new DriverEventContextError('second stop rejected'));

    const error = await repository.completeDeliveryDestination(input).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(DriverEventContextError);
    expect(isDriverDestinationCompletionNotAppliedError(error)).toBe(false);
  });

  test('keeps an exact first duplicate followed by a collision outcome unknown', async () => {
    const repository = new PrismaDriverEventRepository({
      deliveryStop: { findMany: vi.fn().mockResolvedValue([{ id: 'stop-1' }, { id: 'stop-2' }]) },
    } as never);
    vi.spyOn(repository, 'recordDriverEvent')
      .mockResolvedValueOnce({ duplicate: true, eventId: 'event-1' })
      .mockRejectedValueOnce(new DriverDestinationCompletionCollisionError());

    const error = await repository.completeDeliveryDestination(input).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(DriverDestinationCompletionCollisionError);
    expect(isDriverDestinationCompletionNotAppliedError(error)).toBe(false);
  });

  test('marks a first-stop transaction rollback as not applied', async () => {
    const repository = new PrismaDriverEventRepository({
      $queryRaw: vi.fn().mockResolvedValue([]),
      $transaction: vi.fn().mockRejectedValue(new DriverEventStopTransitionConflictError()),
      deliveryStop: { findMany: vi.fn().mockResolvedValue([{ id: 'stop-1' }, { id: 'stop-2' }]) },
    } as never);

    const error = await repository.completeDeliveryDestination(input).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(DriverEventStopTransitionConflictError);
    expect(isDriverDestinationCompletionNotAppliedError(error)).toBe(true);
  });
});

describe('Driver destination completion result repository', () => {
  const completionPayload = {
    clientEventId: input.clientEventId,
    completionOwnerAccountId: input.completionOwnerAccountId,
    deliveryStopIds: input.deliveryStopIds,
    destinationId: input.destinationId,
    occurredAt: input.occurredAt.toISOString(),
    routePlanId: input.routePlanId,
  };
  const events = input.deliveryStopIds.map((deliveryStopId, index) => ({
    clientEventId: `${input.clientEventId}:${deliveryStopId}`,
    completionOwnerAccountId: input.completionOwnerAccountId,
    deliveryStopId,
    eventType: 'STOP_DELIVERED',
    id: `event-${index + 1}`,
    occurredAt: input.occurredAt,
    payload: completionPayload,
    routePlanId: input.routePlanId,
  }));

  test('returns the original result after current route ownership changes', async () => {
    const findMany = vi.fn().mockResolvedValue([...events].reverse());
    const repository = new PrismaDriverEventReceiptRepository({ driverEvent: { findMany } } as never);

    await expect(repository.lookupDestinationCompletion({
      accountId: input.completionOwnerAccountId,
      clientEventId: input.clientEventId,
      deliveryStopIds: input.deliveryStopIds,
      destinationId: input.destinationId,
      occurredAt: input.occurredAt,
      routePlanId: input.routePlanId,
    })).resolves.toEqual({
      clientEventId: input.clientEventId,
      completedStopCount: 2,
      deliveryStopIds: input.deliveryStopIds,
      destinationId: input.destinationId,
      eventIds: ['event-1', 'event-2'],
      occurredAt: input.occurredAt.toISOString(),
      routePlanId: input.routePlanId,
      status: 'APPLIED',
    });
    const query = findMany.mock.calls[0]?.[0] as { where: Record<string, unknown> } | undefined;
    expect(query?.where).toMatchObject({ completionOwnerAccountId: 'account-1' });
    expect(query?.where).not.toHaveProperty('driver');
  });

  test.each([
    ['different account', events.map((event) => ({ ...event, completionOwnerAccountId: 'account-2' }))],
    ['forged legacy JSON owner without a server column', events.map((event) => ({
      ...event,
      completionOwnerAccountId: null,
      payload: { ...completionPayload, completionOwnerAccountId: input.completionOwnerAccountId },
    }))],
    ['mixed legacy and new events', events.map((event, index) => ({
      ...event,
      completionOwnerAccountId: index === 0 ? input.completionOwnerAccountId : null,
    }))],
    ['partial event set', events.slice(0, 1)],
    ['fingerprint collision', events.map((event) => ({ ...event, payload: { ...completionPayload, destinationId: 'destination-2' } }))],
  ])('returns UNKNOWN for %s', async (_label, storedEvents) => {
    const repository = new PrismaDriverEventReceiptRepository({
      driverEvent: { findMany: vi.fn().mockResolvedValue(storedEvents) },
    } as never);
    await expect(repository.lookupDestinationCompletion({
      accountId: input.completionOwnerAccountId,
      clientEventId: input.clientEventId,
      deliveryStopIds: input.deliveryStopIds,
      destinationId: input.destinationId,
      occurredAt: input.occurredAt,
      routePlanId: input.routePlanId,
    })).resolves.toEqual({ status: 'UNKNOWN' });
  });
});
