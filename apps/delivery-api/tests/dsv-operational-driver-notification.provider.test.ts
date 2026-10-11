import { beforeEach, describe, expect, test, vi } from 'vitest';

import {
  FirebaseAdminDsvOperationalPushProvider,
  type DsvOperationalPushMessage,
} from '../src/modules/dsv/dsv-operational-driver-notification.provider.js';

const firebase = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock('firebase-admin/app', () => ({
  applicationDefault: vi.fn(() => ({})),
  getApps: vi.fn(() => [{}]),
  initializeApp: vi.fn(),
}));
vi.mock('firebase-admin/messaging', () => ({
  getMessaging: vi.fn(() => ({ send: firebase.send })),
}));

function message(kind: DsvOperationalPushMessage['payload']['kind'] = 'N05'): DsvOperationalPushMessage {
  return {
    body: '배송 시작을 확인해 주세요.',
    collapseKey: 'execution:N05',
    payload: { expiresAt: '2026-10-08T03:00:00.000Z', kind, notificationId: 'notification', schemaVersion: '1' },
    title: '운행 시작 확인',
    token: 'isolated-test-token',
    ttlMs: 1_000,
  };
}

describe('FirebaseAdminDsvOperationalPushProvider reminder deadline', () => {
  beforeEach(() => {
    firebase.send.mockReset().mockResolvedValue('isolated-message');
  });

  test.each(['2026-10-08T03:00:00.000Z', '2026-10-08T03:00:01.000Z'])(
    'blocks N05 when asynchronous SDK loading reaches %s', async (boundary) => {
      let now = new Date('2026-10-08T02:59:59.000Z');
      const provider = new FirebaseAdminDsvOperationalPushProvider({ clock: () => now, projectId: 'isolated-test' });
      const sending = provider.send(message());
      now = new Date(boundary);
      await expect(sending).resolves.toEqual({ errorCode: 'MISSING_START_EXPIRED', status: 'SKIPPED' });
      expect(firebase.send).not.toHaveBeenCalled();
    },
  );

  test('recomputes N05 TTL after SDK loading without extending the business deadline', async () => {
    let now = new Date('2026-10-08T02:59:59.000Z');
    const provider = new FirebaseAdminDsvOperationalPushProvider({ clock: () => now, projectId: 'isolated-test' });
    const sending = provider.send(message());
    now = new Date('2026-10-08T02:59:59.750Z');
    await expect(sending).resolves.toEqual({ providerMessageId: 'isolated-message', status: 'SENT' });
    expect(firebase.send).toHaveBeenCalledWith(expect.objectContaining({
      android: expect.objectContaining({ ttl: 250 }) as unknown, data: message().payload,
    }));
  });

  test('fails closed for an invalid reminder expiration', async () => {
    const provider = new FirebaseAdminDsvOperationalPushProvider({
      clock: () => new Date('2026-10-08T02:59:59.000Z'), projectId: 'isolated-test',
    });
    await expect(provider.send({ ...message(), payload: { ...message().payload, expiresAt: 'invalid' } }))
      .resolves.toEqual({ errorCode: 'MISSING_START_EXPIRED', status: 'SKIPPED' });
    expect(firebase.send).not.toHaveBeenCalled();
  });

  test.each(['N01', 'N02', 'N04'] as const)('does not add the N05 deadline to %s', async (kind) => {
    const provider = new FirebaseAdminDsvOperationalPushProvider({
      clock: () => new Date('2026-10-08T03:00:00.000Z'), projectId: 'isolated-test',
    });
    await expect(provider.send(message(kind))).resolves.toEqual({ providerMessageId: 'isolated-message', status: 'SENT' });
    expect(firebase.send).toHaveBeenCalledWith(expect.objectContaining({ android: expect.objectContaining({ ttl: 1_000 }) as unknown }));
  });
});
