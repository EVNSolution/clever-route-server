export const DSV_OPERATIONAL_DRIVER_APP_ID = 'com.evnsolution.clever.driver';
const FCM_MAX_TTL_MS = 28 * 24 * 60 * 60 * 1000;

export const dsvOperationalDriverNotificationKinds = [
  'N01',
  'N02',
  'N03',
  'N04',
  'N05',
  'N06',
] as const;

export type DsvOperationalDriverNotificationKind = typeof dsvOperationalDriverNotificationKinds[number];

export type DsvOperationalPushMessage = {
  body: string;
  collapseKey?: string;
  payload: {
    expiresAt: string;
    kind: DsvOperationalDriverNotificationKind;
    notificationId: string;
    schemaVersion: string;
  };
  title: string;
  token: string;
  ttlMs: number;
};

export type DsvOperationalPushResult = {
  errorCode?: string;
  errorMessage?: string;
  invalidToken?: boolean;
  providerMessageId?: string;
  status: 'FAILED' | 'SENT' | 'SKIPPED';
};

export type DsvOperationalPushProvider = {
  readonly providerName: string;
  send(message: DsvOperationalPushMessage): Promise<DsvOperationalPushResult>;
};

export class DisabledDsvOperationalPushProvider implements DsvOperationalPushProvider {
  readonly providerName = 'disabled';

  send(): Promise<DsvOperationalPushResult> {
    return Promise.resolve({
      errorCode: 'LIVE_SEND_DISABLED',
      errorMessage: 'DSV operational notification live sending is disabled.',
      status: 'SKIPPED',
    });
  }
}

export class FirebaseAdminDsvOperationalPushProvider implements DsvOperationalPushProvider {
  readonly providerName = 'firebase-admin';
  private initialized = false;

  constructor(private readonly options: { projectId: string }) {}

  async send(message: DsvOperationalPushMessage): Promise<DsvOperationalPushResult> {
    try {
      const [{ applicationDefault, getApps, initializeApp }, { getMessaging }] = await Promise.all([
        import('firebase-admin/app'),
        import('firebase-admin/messaging'),
      ]);
      if (!this.initialized && getApps().length === 0) {
        initializeApp({ credential: applicationDefault(), projectId: this.options.projectId });
        this.initialized = true;
      }
      const providerMessageId = await getMessaging().send({
        android: {
          ...(message.collapseKey === undefined ? {} : { collapseKey: message.collapseKey }),
          notification: {
            channelId: 'route-updates',
            ...(message.collapseKey === undefined ? {} : { tag: message.collapseKey }),
          },
          priority: 'high',
          ttl: Math.min(message.ttlMs, FCM_MAX_TTL_MS),
        },
        data: message.payload,
        notification: { body: message.body, title: message.title },
        token: message.token,
      });
      return { providerMessageId, status: 'SENT' };
    } catch (error) {
      const errorCode = firebaseErrorCode(error);
      return {
        errorCode,
        errorMessage: error instanceof Error ? error.message : 'Firebase Admin send failed.',
        invalidToken: errorCode === 'messaging/registration-token-not-registered'
          || errorCode === 'messaging/invalid-registration-token',
        status: 'FAILED',
      };
    }
  }
}

export function notificationCopy(kind: DsvOperationalDriverNotificationKind): { body: string; title: string } {
  switch (kind) {
    case 'N01':
      return { body: '앱에서 새 배차를 확인해 주세요.', title: '배차가 등록되었습니다' };
    case 'N02':
      return { body: '앱에서 변경된 배차를 확인해 주세요.', title: '배차가 변경되었습니다' };
    case 'N03':
      return { body: '앱에서 배차 변경을 확인해 주세요.', title: '배차가 해제되었습니다' };
    case 'N04':
      return { body: '상차를 마치면 배송 시작 버튼을 눌러주세요.', title: '창고 도착이 확인되었습니다' };
    case 'N05':
      return { body: '배송 시작이 확인되지 않았습니다. 안전한 곳에 정차한 후 시작 버튼을 눌러주세요.', title: '운행 시작 확인이 필요합니다' };
    case 'N06':
      return { body: '앱에서 현재 배송 업무를 확인해 주세요.', title: '배송지 도착 확인이 필요합니다' };
  }
}

export function loadDsvOperationalPushProvider(
  env: Partial<Record<'FIREBASE_PROJECT_ID' | 'GOOGLE_APPLICATION_CREDENTIALS', string>>,
): DsvOperationalPushProvider {
  if (env.FIREBASE_PROJECT_ID?.trim() && env.GOOGLE_APPLICATION_CREDENTIALS?.trim()) {
    return new FirebaseAdminDsvOperationalPushProvider({ projectId: env.FIREBASE_PROJECT_ID.trim() });
  }
  return new DisabledDsvOperationalPushProvider();
}

function firebaseErrorCode(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const value = (error as { code?: unknown }).code;
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return 'FIREBASE_SEND_FAILED';
}
