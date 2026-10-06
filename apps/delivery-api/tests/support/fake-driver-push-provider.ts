import type {
  DriverPushProvider,
  DriverRoutePushMessage,
  DriverRoutePushResult,
} from '../../src/modules/route-grouping/driver-push.provider.js';

export class FakeDriverPushProvider implements DriverPushProvider {
  readonly providerName = 'fake';
  readonly sentMessages: DriverRoutePushMessage[] = [];

  sendRouteNotification(message: DriverRoutePushMessage): Promise<DriverRoutePushResult> {
    this.sentMessages.push(message);
    return Promise.resolve({
      providerMessageId: `fake:${message.routeGroupingId ?? 'standalone'}:${message.childVersion ?? message.publicationVersion ?? 'current'}:${message.routePlanId}`,
      status: 'SENT',
    });
  }
}
