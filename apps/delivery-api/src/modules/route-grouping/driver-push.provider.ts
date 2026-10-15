import type { getMessaging as GetMessaging } from 'firebase-admin/messaging';

export type DriverRoutePushAction = 'assigned' | 'cancelled' | 'changed' | 'released';

export type DriverRoutePushMessage = {
  action: DriverRoutePushAction;
  childVersion?: number | undefined;
  devicePushToken: string;
  metadata?: Record<string, string> | undefined;
  publicationVersion?: string | undefined;
  routeGroupingId?: string | undefined;
  routePlanId: string;
};

export type DriverRoutePushResult = {
  errorCode?: string;
  errorMessage?: string;
  invalidToken?: boolean;
  providerMessageId?: string;
  status: 'SENT' | 'FAILED' | 'SKIPPED';
};

export type DriverGpsCheckMessage = {
  devicePushToken: string;
  pushId: string;
  routePlanId: string;
  sentAt: string;
  severity: 'CRITICAL' | 'WARNING';
  silentSeconds: number;
};

export type DriverPushProvider = {
  readonly providerName: string;
  sendRouteNotification(message: DriverRoutePushMessage): Promise<DriverRoutePushResult>;
  /** WARNING is a silent data message; CRITICAL also shows a notification so the driver opens the app. */
  sendGpsCheck?(message: DriverGpsCheckMessage): Promise<DriverRoutePushResult>;
};

export class DisabledDriverPushProvider implements DriverPushProvider {
  readonly providerName = 'disabled';

  sendRouteNotification(): Promise<DriverRoutePushResult> {
    return Promise.resolve({ errorCode: 'NO_PROVIDER', errorMessage: 'Driver push provider is not configured.', status: 'SKIPPED' });
  }

  sendGpsCheck(): Promise<DriverRoutePushResult> {
    return this.sendRouteNotification();
  }
}

export class FirebaseAdminDriverPushProvider implements DriverPushProvider {
  readonly providerName = 'firebase-admin';
  private initialized = false;

  constructor(private readonly options: { projectId: string }) {}

  private async loadMessaging(): Promise<{ getMessaging: typeof GetMessaging }> {
    const [{ getApps, initializeApp, applicationDefault }, { getMessaging }] = await Promise.all([
      import('firebase-admin/app'),
      import('firebase-admin/messaging')
    ]);
    if (!this.initialized && getApps().length === 0) {
      initializeApp({ credential: applicationDefault(), projectId: this.options.projectId });
      this.initialized = true;
    }
    return { getMessaging };
  }

  async sendGpsCheck(message: DriverGpsCheckMessage): Promise<DriverRoutePushResult> {
    try {
      const { getMessaging } = await this.loadMessaging();
      const visible = message.severity === 'CRITICAL';
      const id = await getMessaging().send({
        android: {
          priority: 'high',
          ttl: 60_000,
          ...(visible ? { notification: { channelId: 'route-updates' } } : {})
        },
        data: {
          pushId: message.pushId,
          routePlanId: message.routePlanId,
          sentAt: message.sentAt,
          severity: message.severity,
          silentSeconds: String(message.silentSeconds),
          type: 'driver_gps_check'
        },
        ...(visible ? { notification: { body: '앱을 열어 위치 전송을 확인해 주세요.', title: '위치 확인 필요' } } : {}),
        token: message.devicePushToken
      });
      return { providerMessageId: id, status: 'SENT' };
    } catch (error) {
      const code = readFirebaseErrorCode(error);
      return {
        errorCode: code,
        errorMessage: error instanceof Error ? error.message : 'Firebase Admin send failed',
        invalidToken: code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token',
        status: 'FAILED'
      };
    }
  }

  async sendRouteNotification(message: DriverRoutePushMessage): Promise<DriverRoutePushResult> {
    try {
      const { getMessaging } = await this.loadMessaging();
      const isBundleHandoff = message.metadata?.handoffRequestId !== undefined;
      const id = await getMessaging().send({
        android: { notification: { channelId: 'route-updates' }, priority: 'high' },
        data: {
          action: message.action,
          ...(message.childVersion === undefined ? {} : { childVersion: String(message.childVersion) }),
          ...(message.metadata ?? {}),
          ...(message.publicationVersion === undefined ? {} : { publicationVersion: message.publicationVersion }),
          ...(message.routeGroupingId === undefined ? {} : { routeGroupingId: message.routeGroupingId }),
          routePlanId: message.routePlanId,
          type: isBundleHandoff ? 'driver_bundle_handoff' : 'driver_route_changed'
        },
        notification: {
          body: isBundleHandoff ? '앱에서 요청 내용을 확인해 주세요.' : routeNotificationBody(message.action),
          title: isBundleHandoff ? '배송지 인계 요청' : routeNotificationTitle(message.action)
        },
        token: message.devicePushToken
      });
      return { providerMessageId: id, status: 'SENT' };
    } catch (error) {
      const code = readFirebaseErrorCode(error);
      return {
        errorCode: code,
        errorMessage: error instanceof Error ? error.message : 'Firebase Admin send failed',
        invalidToken: code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token',
        status: 'FAILED'
      };
    }
  }
}

function routeNotificationBody(action: DriverRoutePushAction): string {
  switch (action) {
    case 'assigned':
      return 'Your route is ready.';
    case 'cancelled':
      return 'This route was cancelled. Open the app to refresh your routes.';
    case 'released':
      return 'This route is no longer assigned to you.';
    case 'changed':
      return 'Your assigned route has changed.';
  }
}

function routeNotificationTitle(action: DriverRoutePushAction): string {
  switch (action) {
    case 'assigned':
      return 'Route assigned';
    case 'cancelled':
      return 'Route cancelled';
    case 'released':
      return 'Route assignment removed';
    case 'changed':
      return 'Route updated';
  }
}

function readFirebaseErrorCode(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.trim() !== '') return code;
  }
  return 'FIREBASE_SEND_FAILED';
}

export function loadDriverPushProvider(env: Partial<Record<'FIREBASE_PROJECT_ID' | 'GOOGLE_APPLICATION_CREDENTIALS', string>>): DriverPushProvider {
  if (env.FIREBASE_PROJECT_ID?.trim() && env.GOOGLE_APPLICATION_CREDENTIALS?.trim()) {
    return new FirebaseAdminDriverPushProvider({ projectId: env.FIREBASE_PROJECT_ID.trim() });
  }
  return new DisabledDriverPushProvider();
}
