import type { Prisma } from '@prisma/client';

import { dsvBusinessDayBounds } from './dsv-business-time.js';
import { parseDsvGeofencePolicy } from './dsv-geofence-policy.js';
import { isCompleteLivePolicy } from './dsv-operational-driver-notification.service.js';
import { loadDsvOperationalSendPolicy, type DsvOperationalSendPolicyEnv } from './dsv-operational-send-policy.js';

export type DsvContextActivationEnv = DsvOperationalSendPolicyEnv
  & Partial<Record<'DSV_GEOFENCE_ENABLED' | 'DSV_GEOFENCE_POLICY_JSON', string>>;

export type DsvContextActivation = {
  liveEligibleAt: Date | null;
  monitorEndAt: Date;
  monitorStartAt: Date;
  notificationMode: 'LIVE' | 'SHADOW';
  policy: Prisma.InputJsonObject;
};

/**
 * A new execution context starts in the mode the operator's runtime switches describe.
 * It returns null (context stays OFF) unless every switch is present and valid:
 * - SHADOW: geofence enabled with a SHADOW policy. Decisions are recorded, nothing is sent.
 * - LIVE: geofence enabled with a LIVE policy, a complete send policy, the same policy version
 *   on both sides, and a recipient account and shop that the send policy allowlists.
 * The policy snapshot stored on the context is what the send worker checks again before FCM.
 */
export function resolveDsvContextActivation(
  env: DsvContextActivationEnv,
  input: { now: Date; recipientAccountId: string | null; serviceDate: Date; shopId: string },
): DsvContextActivation | null {
  if (env.DSV_GEOFENCE_ENABLED !== 'true') return null;
  const geofence = parseGeofencePolicy(env.DSV_GEOFENCE_POLICY_JSON);
  if (geofence === null) return null;
  const { end, start } = dsvBusinessDayBounds(input.serviceDate);
  const window = { monitorEndAt: end, monitorStartAt: start };
  if (geofence.mode === 'SHADOW') {
    return { ...window, liveEligibleAt: null, notificationMode: 'SHADOW', policy: { ...geofence } };
  }
  const send = loadDsvOperationalSendPolicy(env);
  if (
    !isCompleteLivePolicy(send)
    || input.recipientAccountId === null
    || !send.allowedAccountIds.includes(input.recipientAccountId)
    || !send.allowedShopIds.includes(input.shopId)
    || send.approvedGeofencePolicyVersion !== geofence.policyVersion
    || send.approvedAuthorizationId === null
  ) return null;
  return {
    ...window,
    liveEligibleAt: input.now,
    notificationMode: 'LIVE',
    policy: { ...geofence, authorizationId: send.approvedAuthorizationId },
  };
}

function parseGeofencePolicy(value: string | undefined) {
  if (value === undefined) return null;
  try {
    return parseDsvGeofencePolicy(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}
