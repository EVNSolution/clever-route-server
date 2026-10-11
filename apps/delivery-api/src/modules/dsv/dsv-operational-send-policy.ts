import {
  disabledDsvOperationalNotificationSendPolicy,
  isCompleteLivePolicy,
  type DsvOperationalNotificationSendPolicy,
} from './dsv-operational-driver-notification.service.js';

export type DsvOperationalSendPolicyEnv = Partial<Record<'DSV_OPERATIONAL_SEND_ENABLED' | 'DSV_OPERATIONAL_SEND_POLICY_JSON', string>>;

/** Malformed or incomplete configuration always disables new live sending. */
export function loadDsvOperationalSendPolicy(env: DsvOperationalSendPolicyEnv): DsvOperationalNotificationSendPolicy {
  if (env.DSV_OPERATIONAL_SEND_ENABLED !== 'true' || env.DSV_OPERATIONAL_SEND_POLICY_JSON === undefined) {
    return { ...disabledDsvOperationalNotificationSendPolicy };
  }
  try {
    const source: unknown = JSON.parse(env.DSV_OPERATIONAL_SEND_POLICY_JSON);
    if (source === null || typeof source !== 'object' || Array.isArray(source)) return { ...disabledDsvOperationalNotificationSendPolicy };
    const candidate = { ...source, liveSendingEnabled: true } as DsvOperationalNotificationSendPolicy;
    return isCompleteLivePolicy(candidate) ? candidate : { ...disabledDsvOperationalNotificationSendPolicy };
  } catch {
    return { ...disabledDsvOperationalNotificationSendPolicy };
  }
}
