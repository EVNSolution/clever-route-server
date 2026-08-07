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
});
