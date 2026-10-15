import { beforeEach, describe, expect, test, vi } from 'vitest';

import { FirebaseAdminDriverPushProvider } from '../src/modules/route-grouping/driver-push.provider.js';

const firebase = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock('firebase-admin/app', () => ({
  applicationDefault: vi.fn(() => ({})),
  getApps: vi.fn(() => [{}]),
  initializeApp: vi.fn()
}));

vi.mock('firebase-admin/messaging', () => ({
  getMessaging: vi.fn(() => ({ send: firebase.send }))
}));

describe('FirebaseAdminDriverPushProvider', () => {
  beforeEach(() => {
    firebase.send.mockReset();
    firebase.send.mockResolvedValue('firebase-message-id');
  });

  test('labels bundle handoff pushes without exposing delivery details', async () => {
    const provider = new FirebaseAdminDriverPushProvider({ projectId: 'clever-routes-prod' });

    await expect(provider.sendRouteNotification({
      action: 'changed',
      childVersion: 7,
      devicePushToken: 'driver-device-token',
      metadata: {
        handoffEvent: 'proposed',
        handoffRequestId: 'handoff-request-id'
      },
      routeGroupingId: 'grouping-id',
      routePlanId: 'route-plan-id'
    })).resolves.toEqual({ providerMessageId: 'firebase-message-id', status: 'SENT' });

    expect(firebase.send).toHaveBeenCalledWith({
      android: { notification: { channelId: 'route-updates' }, priority: 'high' },
      data: {
        action: 'changed',
        childVersion: '7',
        handoffEvent: 'proposed',
        handoffRequestId: 'handoff-request-id',
        routeGroupingId: 'grouping-id',
        routePlanId: 'route-plan-id',
        type: 'driver_bundle_handoff'
      },
      notification: {
        body: '앱에서 요청 내용을 확인해 주세요.',
        title: '배송지 인계 요청'
      },
      token: 'driver-device-token'
    });
  });

  test('sends the gps check as a silent data message for WARNING and with a notification for CRITICAL', async () => {
    const provider = new FirebaseAdminDriverPushProvider({ projectId: 'clever-routes-prod' });
    const base = { devicePushToken: 'tok', pushId: 'push-1', routePlanId: 'route-1', sentAt: '2026-10-14T01:00:00.000Z', silentSeconds: 61 };

    await provider.sendGpsCheck({ ...base, severity: 'WARNING' });
    expect(firebase.send).toHaveBeenLastCalledWith({
      android: { priority: 'high', ttl: 60_000 },
      data: { pushId: 'push-1', routePlanId: 'route-1', sentAt: '2026-10-14T01:00:00.000Z', severity: 'WARNING', silentSeconds: '61', type: 'driver_gps_check' },
      token: 'tok'
    });

    await provider.sendGpsCheck({ ...base, severity: 'CRITICAL', silentSeconds: 301 });
    expect(firebase.send).toHaveBeenLastCalledWith({
      android: { notification: { channelId: 'route-updates' }, priority: 'high', ttl: 60_000 },
      data: { pushId: 'push-1', routePlanId: 'route-1', sentAt: '2026-10-14T01:00:00.000Z', severity: 'CRITICAL', silentSeconds: '301', type: 'driver_gps_check' },
      notification: { body: '앱을 열어 위치 전송을 확인해 주세요.', title: '위치 확인 필요' },
      token: 'tok'
    });
  });

  test('reports an unregistered token as invalid', async () => {
    firebase.send.mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'messaging/registration-token-not-registered' }));
    const provider = new FirebaseAdminDriverPushProvider({ projectId: 'clever-routes-prod' });
    await expect(provider.sendGpsCheck({
      devicePushToken: 'tok', pushId: 'p', routePlanId: 'r', sentAt: 'now', severity: 'WARNING', silentSeconds: 70
    })).resolves.toMatchObject({ invalidToken: true, status: 'FAILED' });
  });
});
