export type DriverRoutePushAction = 'assigned' | 'changed';

export type DriverRoutePushMessage = {
  action: DriverRoutePushAction;
  childVersion: number;
  devicePushToken: string;
  routeGroupingId: string;
  routePlanId: string;
};

export type DriverRoutePushResult = {
  errorCode?: string;
  errorMessage?: string;
  invalidToken?: boolean;
  providerMessageId?: string;
  status: 'SENT' | 'FAILED' | 'SKIPPED';
};

export type DriverPushProvider = {
  readonly providerName: string;
  sendRouteNotification(message: DriverRoutePushMessage): Promise<DriverRoutePushResult>;
};

export class FakeDriverPushProvider implements DriverPushProvider {
  readonly providerName = 'fake';
  readonly sentMessages: DriverRoutePushMessage[] = [];

  sendRouteNotification(message: DriverRoutePushMessage): Promise<DriverRoutePushResult> {
    this.sentMessages.push(message);
    return Promise.resolve({
      providerMessageId: `fake:${message.routeGroupingId}:${message.childVersion}:${message.routePlanId}`,
      status: 'SENT'
    });
  }
}

export class DisabledDriverPushProvider implements DriverPushProvider {
  readonly providerName = 'disabled';

  sendRouteNotification(): Promise<DriverRoutePushResult> {
    return Promise.resolve({ errorCode: 'NO_PROVIDER', errorMessage: 'Driver push provider is not configured.', status: 'SKIPPED' });
  }
}

export class FirebaseAdminDriverPushProvider implements DriverPushProvider {
  readonly providerName = 'firebase-admin';
  private initialized = false;

  constructor(private readonly options: { projectId: string }) {}

  async sendRouteNotification(message: DriverRoutePushMessage): Promise<DriverRoutePushResult> {
    try {
      const [{ getApps, initializeApp, applicationDefault }, { getMessaging }] = await Promise.all([
        import('firebase-admin/app'),
        import('firebase-admin/messaging')
      ]);
      if (!this.initialized && getApps().length === 0) {
        initializeApp({ credential: applicationDefault(), projectId: this.options.projectId });
        this.initialized = true;
      }
      const id = await getMessaging().send({
        android: { notification: { channelId: 'route-updates' }, priority: 'high' },
        data: {
          action: message.action,
          childVersion: String(message.childVersion),
          routeGroupingId: message.routeGroupingId,
          routePlanId: message.routePlanId,
          type: 'driver_route_changed'
        },
        notification: {
          body: message.action === 'assigned' ? 'Your route is ready.' : 'Your assigned route has changed.',
          title: message.action === 'assigned' ? 'Route assigned' : 'Route updated'
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
