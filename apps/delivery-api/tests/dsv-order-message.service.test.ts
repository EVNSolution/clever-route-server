import { describe, expect, test, vi } from 'vitest';

import { PrismaDsvOrderMessageService } from '../src/modules/dsv/dsv-order-message.service.js';
import type { DsvOrderMessageError } from '../src/modules/dsv/dsv-order-message.service.js';

const shopId = '99999999-9999-4999-8999-999999999999';
const sellerOrderId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const customerId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const deliveryStopId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const routePlanId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const routeVersionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

describe('PrismaDsvOrderMessageService', () => {
  test('returns the existing message when command replay has the same payload', async () => {
    const existing = messageFixture({ body: 'Existing customer message', commandId: 'cmd-message-1' });
    const harness = createHarness({ existingMessage: existing });
    const service = new PrismaDsvOrderMessageService(harness.prisma as never, harness.dispatcher);

    await expect(service.create(messageInput({ body: 'Existing customer message', commandId: 'cmd-message-1' }))).resolves.toEqual(toExpectedDto(existing));

    expect(harness.prisma.orderMessage.create).not.toHaveBeenCalled();
    expect(harness.prisma.customerRouteNotificationFact.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { idempotencyKey: `${shopId}:cmd-message-1:customer-message-email` },
    }));
  });

  test('rejects command replay when the payload does not match', async () => {
    const harness = createHarness({
      existingMessage: messageFixture({ body: 'Original message', commandId: 'cmd-message-1' }),
    });
    const service = new PrismaDsvOrderMessageService(harness.prisma as never, harness.dispatcher);

    await expect(service.create(messageInput({ body: 'Changed message', commandId: 'cmd-message-1' }))).rejects.toMatchObject({
      code: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
      name: 'DsvOrderMessageError',
    } satisfies Partial<DsvOrderMessageError>);

    expect(harness.prisma.orderMessage.create).not.toHaveBeenCalled();
  });

  test('queues a customer email outbox row when customer notifications are enabled', async () => {
    const harness = createHarness({
      customer: {
        id: customerId,
        notificationEmailEnabled: true,
        notificationEmailRecipient: 'customer@example.com',
      },
    });
    const service = new PrismaDsvOrderMessageService(harness.prisma as never, harness.dispatcher);

    await service.create(messageInput({ audience: 'CUSTOMER', body: '  Customer update  ', commandId: 'cmd-customer-message' }));

    expect(harness.prisma.orderMessage.create).toHaveBeenCalledWith({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      data: expect.objectContaining({
        audience: 'CUSTOMER',
        body: 'Customer update',
        commandId: 'cmd-customer-message',
        orderId: sellerOrderId,
        shopId,
      }),
    });
    expect(harness.prisma.customerRouteNotificationFact.upsert).toHaveBeenCalledWith({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      create: expect.objectContaining({
        deliveryStopId,
        idempotencyKey: `${shopId}:cmd-customer-message:customer-message-email`,
        metadata: { body: 'Customer update', orderMessageId: 'message-new' },
        orderId: sellerOrderId,
        recipientEmailSnapshot: 'customer@example.com',
        routePlanId,
        shopId,
        source: 'DSV_CUSTOMER_MESSAGE',
        status: 'QUEUED',
      }),
      update: {},
      where: { idempotencyKey: `${shopId}:cmd-customer-message:customer-message-email` },
    });
  });

  test('does not queue customer email when notifications are disabled', async () => {
    const harness = createHarness({
      customer: {
        id: customerId,
        notificationEmailEnabled: false,
        notificationEmailRecipient: 'customer@example.com',
      },
    });
    const service = new PrismaDsvOrderMessageService(harness.prisma as never, harness.dispatcher);

    await service.create(messageInput({ audience: 'CUSTOMER', commandId: 'cmd-disabled-customer-message' }));

    expect(harness.prisma.customerRouteNotificationFact.upsert).not.toHaveBeenCalled();
  });

  test('records and dispatches a driver notification when message targets a routed driver', async () => {
    const harness = createHarness();
    const service = new PrismaDsvOrderMessageService(harness.prisma as never, harness.dispatcher);

    await service.create(messageInput({ audience: 'DRIVER', commandId: 'cmd-driver-message' }));

    expect(harness.prisma.driverRouteNotificationAttempt.upsert).toHaveBeenCalledWith({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      create: expect.objectContaining({
        childVersionId: routeVersionId,
        driverId: 'driver-1',
        groupingId: 'grouping-1',
        groupingVersion: 7,
        idempotencyKey: 'dsv-order-message:message-new',
        metadata: { orderMessageId: 'message-new' },
        routePlanId,
        shopId,
        status: 'PENDING',
      }),
      update: {},
      where: { idempotencyKey: 'dsv-order-message:message-new' },
    });
    expect(harness.dispatcher.dispatchByIdempotencyKey).toHaveBeenCalledWith('dsv-order-message:message-new');
  });

  test('rejects enabling customer notifications without a valid recipient email', async () => {
    const harness = createHarness();
    const service = new PrismaDsvOrderMessageService(harness.prisma as never, harness.dispatcher);

    await expect(service.updateCustomerNotificationSettings({
      customerId,
      enabled: true,
      recipient: 'not-an-email',
      shopDomain: 'Example.MyShopify.Com',
    })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    expect(harness.prisma.customer.updateMany).not.toHaveBeenCalled();
  });

  test('returns the concurrently-created message and repairs its idempotent notification side effect', async () => {
    const concurrent = messageFixture({ commandId: 'cmd-concurrent' });
    const harness = createHarness({
      existingMessage: null,
      findUniqueResults: [null, concurrent],
    });
    harness.prisma.orderMessage.create.mockRejectedValueOnce({ code: 'P2002' });
    const service = new PrismaDsvOrderMessageService(harness.prisma as never, harness.dispatcher);

    await expect(service.create(messageInput({ commandId: 'cmd-concurrent' }))).resolves.toEqual(toExpectedDto(concurrent));

    expect(harness.prisma.customerRouteNotificationFact.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { idempotencyKey: `${shopId}:cmd-concurrent:customer-message-email` },
    }));
    expect(harness.dispatcher.dispatchByIdempotencyKey).not.toHaveBeenCalled();
  });

  test('repairs a customer email outbox row when a command is retried after outbox failure', async () => {
    const persisted = messageFixture({ commandId: 'cmd-outbox-retry', id: 'message-new' });
    const harness = createHarness({ findUniqueResults: [null, persisted] });
    harness.prisma.customerRouteNotificationFact.upsert.mockRejectedValueOnce(new Error('outbox unavailable'));
    const service = new PrismaDsvOrderMessageService(harness.prisma as never, harness.dispatcher);

    await expect(service.create(messageInput({ commandId: 'cmd-outbox-retry' }))).rejects.toThrow('outbox unavailable');
    await expect(service.create(messageInput({ commandId: 'cmd-outbox-retry' }))).resolves.toEqual(toExpectedDto(persisted));

    expect(harness.prisma.orderMessage.create).toHaveBeenCalledTimes(1);
    expect(harness.prisma.customerRouteNotificationFact.upsert).toHaveBeenCalledTimes(2);
  });

  test('marks an assigned driver message as read idempotently', async () => {
    const existing = messageFixture({ audience: 'DRIVER', id: 'message-driver' });
    const harness = createHarness({ driverMessage: existing });
    const service = new PrismaDsvOrderMessageService(harness.prisma as never, harness.dispatcher);

    const result = await service.markDriverMessageRead({
      driverId: 'driver-1',
      messageId: existing.id,
      routePlanId,
      shopId,
    });

    expect(result.readByDriverAt).not.toBeNull();
    expect(harness.prisma.orderMessage.updateMany).toHaveBeenCalledWith({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      data: { readByDriverAt: expect.any(Date) },
      where: { id: existing.id, readByDriverAt: null, shopId },
    });
  });
});

function createHarness(input: {
  customer?: { id: string; notificationEmailEnabled: boolean; notificationEmailRecipient: string | null };
  driverMessage?: ReturnType<typeof messageFixture> | null;
  existingMessage?: ReturnType<typeof messageFixture> | null;
  findUniqueResults?: Array<ReturnType<typeof messageFixture> | null>;
} = {}) {
  const customer = input.customer ?? {
    id: customerId,
    notificationEmailEnabled: true,
    notificationEmailRecipient: 'customer@example.com',
  };
  const currentRouteVersion = {
    driverId: 'driver-1',
    groupingId: 'grouping-1',
    id: routeVersionId,
    routePlanId,
    version: 7,
  };
  const prisma = {
    customer: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    customerRouteNotificationFact: {
      upsert: vi.fn().mockResolvedValue({}),
    },
    driverRouteNotificationAttempt: {
      upsert: vi.fn().mockResolvedValue({}),
    },
    order: {
      findFirst: vi.fn().mockResolvedValue({
        currentRouteVersion,
        customer,
        deliveryStops: [{ id: deliveryStopId }],
        id: sellerOrderId,
      }),
    },
    orderMessage: {
      create: vi.fn((args: { data: Record<string, unknown> }) => Promise.resolve(messageFixture({
        audience: args.data.audience as 'CUSTOMER' | 'DRIVER',
        body: args.data.body as string,
        commandId: args.data.commandId as string,
        id: 'message-new',
      }))),
      findFirst: vi.fn().mockResolvedValue(input.driverMessage ?? null),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn()
        .mockResolvedValue(input.existingMessage ?? null)
        .mockResolvedValueOnce(input.findUniqueResults?.[0] ?? input.existingMessage ?? null),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    shop: {
      findUnique: vi.fn().mockResolvedValue({ id: shopId }),
    },
  };
  if (input.findUniqueResults !== undefined) {
    prisma.orderMessage.findUnique.mockReset();
    for (const result of input.findUniqueResults) prisma.orderMessage.findUnique.mockResolvedValueOnce(result);
  }
  const dispatcher = {
    dispatchByIdempotencyKey: vi.fn().mockResolvedValue({ attemptId: 'attempt-1', status: 'SENT' }),
  };
  return { dispatcher, prisma };
}

function messageInput(input: {
  audience?: 'CUSTOMER' | 'DRIVER';
  body?: string;
  commandId?: string;
} = {}) {
  return {
    actor: { actorId: 'admin-1', actorType: 'DSV_ADMIN', principalType: 'DSV_ADMIN', requestId: 'req-1' },
    audience: input.audience ?? 'CUSTOMER',
    body: input.body ?? 'Customer update',
    commandId: input.commandId ?? 'cmd-message-1',
    sellerOrderId,
    shopDomain: 'Example.MyShopify.Com',
  } as const;
}

function messageFixture(input: {
  audience?: 'CUSTOMER' | 'DRIVER';
  body?: string;
  commandId?: string;
  id?: string;
} = {}) {
  return {
    audience: input.audience ?? 'CUSTOMER',
    authorId: 'admin-1',
    authorType: 'DSV_ADMIN',
    body: input.body ?? 'Customer update',
    commandId: input.commandId ?? 'cmd-message-1',
    createdAt: new Date('2026-08-06T08:00:00.000Z'),
    id: input.id ?? 'message-existing',
    orderId: sellerOrderId,
    readByDriverAt: null,
    shopId,
  };
}

function toExpectedDto(message: ReturnType<typeof messageFixture>) {
  return {
    audience: message.audience,
    authorId: message.authorId,
    authorType: message.authorType,
    body: message.body,
    createdAt: message.createdAt.toISOString(),
    id: message.id,
    orderId: message.orderId,
    readByDriverAt: null,
  };
}
