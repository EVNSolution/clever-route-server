import { EventEmitter } from 'node:events';

import { describe, expect, test, vi } from 'vitest';

import { PostgresAdminNotificationStreamBridge } from '../src/modules/notifications/admin-notification.postgres-stream.js';
import { AdminNotificationStreamHub } from '../src/modules/notifications/admin-notification.stream.js';

class FakePgClient extends EventEmitter {
  connect = vi.fn((): Promise<unknown> => Promise.resolve());
  end = vi.fn((): Promise<unknown> => Promise.resolve());
  query = vi.fn((text: string, values?: unknown[]): Promise<unknown> => {
    void text;
    void values;
    return Promise.resolve();
  });
}

describe('PostgresAdminNotificationStreamBridge', () => {
  test('starts a dedicated listener and publisher connection', async () => {
    const { bridge, clients } = createBridgeHarness();

    await bridge.start();

    expect(clients).toHaveLength(2);
    expect(clients[0]?.connect).toHaveBeenCalledTimes(1);
    expect(clients[0]?.query).toHaveBeenCalledWith(
      'LISTEN clever_route_admin_notifications_changed',
    );
    expect(clients[1]?.connect).toHaveBeenCalledTimes(1);
  });

  test('publishes notifications through Postgres NOTIFY', async () => {
    const { bridge, clients } = createBridgeHarness();
    await bridge.start();

    await bridge.publishNotificationsChanged({
      notificationId: 'notification-id',
      shopId: 'shop-id',
    });

    expect(clients[1]?.query).toHaveBeenCalledWith('SELECT pg_notify($1, $2)', [
      'clever_route_admin_notifications_changed',
      expect.stringContaining('notification-id'),
    ]);
    const notifyCall = clients[1]?.query.mock.calls.at(-1);
    const notifyValues = notifyCall?.[1];
    const payload = notifyValues?.[1];
    expect(typeof payload).toBe('string');
    expect(JSON.parse(payload as string)).toEqual(
      expect.objectContaining({
        notificationId: 'notification-id',
        shopId: 'shop-id',
        type: 'notifications_changed',
      }),
    );
  });

  test('fans out Postgres notifications to local shop listeners', async () => {
    const { bridge, clients, hub } = createBridgeHarness();
    const listener = vi.fn();
    hub.subscribeToShop('shop-id', listener);
    await bridge.start();

    clients[0]?.emit('notification', {
      channel: 'clever_route_admin_notifications_changed',
      payload: JSON.stringify({
        notificationId: 'notification-id',
        occurredAt: '2026-06-22T04:00:00.000Z',
        originId: 'other-process',
        shopId: 'shop-id',
        type: 'notifications_changed',
      }),
    });

    expect(listener).toHaveBeenCalledWith({
      notificationId: 'notification-id',
      occurredAt: '2026-06-22T04:00:00.000Z',
      type: 'notifications_changed',
    });
  });

  test('falls back to local fanout before the Postgres bridge starts', async () => {
    const { bridge, hub } = createBridgeHarness();
    const listener = vi.fn();
    hub.subscribeToShop('shop-id', listener);

    await bridge.publishNotificationsChanged({
      notificationId: 'notification-id',
      shopId: 'shop-id',
    });

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'notifications_changed' }),
    );
  });
});

function createBridgeHarness() {
  const clients: FakePgClient[] = [];
  const hub = new AdminNotificationStreamHub();
  const bridge = new PostgresAdminNotificationStreamBridge({
    clientFactory: () => {
      const client = new FakePgClient();
      clients.push(client);
      return client;
    },
    connectionString: 'postgresql://clever:clever@localhost:5432/clever_route',
    streamHub: hub,
  });
  return { bridge, clients, hub };
}
