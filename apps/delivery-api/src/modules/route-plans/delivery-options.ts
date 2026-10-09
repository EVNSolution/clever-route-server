import type { Prisma } from '@prisma/client';
import { RoutePlanOptionsUpdateInvalidError } from './route-plan.types.js';
export type DeliveryProofPolicy = { photoRequired: boolean; signatureRequired: boolean };
export type TollPolicy = 'ALLOW_TOLLS' | 'AVOID_TOLLS';
export function readDeliveryProof(value: unknown): DeliveryProofPolicy {
  const policy = object(object(value)?.deliveryProof);
  return { photoRequired: policy?.photoRequired === true, signatureRequired: policy?.signatureRequired === true };
}
export function readTollPolicy(value: unknown): TollPolicy { return object(value)?.tollPolicy === 'AVOID_TOLLS' ? 'AVOID_TOLLS' : 'ALLOW_TOLLS'; }
export function parseDeliveryProof(value: unknown): DeliveryProofPolicy {
  const policy = object(value);
  if (policy === null || Object.keys(policy).some(key => !['photoRequired', 'signatureRequired'].includes(key))
    || typeof policy.photoRequired !== 'boolean' || typeof policy.signatureRequired !== 'boolean') throw new Error('Invalid delivery proof policy');
  return { photoRequired: policy.photoRequired, signatureRequired: policy.signatureRequired };
}
export function proofRequired(policy: DeliveryProofPolicy): boolean { return policy.photoRequired || policy.signatureRequired; }
export function mergeDeliveryOptions(constraints: unknown, patch: { deliveryProof?: DeliveryProofPolicy; tollPolicy?: TollPolicy }): Prisma.InputJsonObject {
  return { ...(object(constraints) as Prisma.InputJsonObject ?? {}), ...(patch.deliveryProof === undefined ? {} : { deliveryProof: patch.deliveryProof }),
    ...(patch.tollPolicy === undefined ? {} : { tollPolicy: patch.tollPolicy }) };
}
export function assertProofRollout(policy: DeliveryProofPolicy): void {
  if (proofRequired(policy) && process.env.KFOOD_DELIVERY_PROOF_ENABLED !== 'true') throw new RoutePlanOptionsUpdateInvalidError('DELIVERY_PROOF_ROLLOUT_DISABLED: required proof is not enabled until compatible app acceptance');
}
export function assertDeliveryOptionsEditable(route: { status: string; driverId?: string | null; constraints: unknown }): void {
  const constraints = object(route.constraints);
  if (!['DRAFT', 'READY'].includes(route.status) || route.driverId != null || constraints?.cleverDispatchReservedAt != null || constraints?.publishedAt != null) {
    throw new RoutePlanOptionsUpdateInvalidError('DELIVERY_OPTIONS_LOCKED: change proof and toll options before assigning or publishing the route');
  }
}
export async function assertProofDriverCompatible(tx: Prisma.TransactionClient, route: { constraints: unknown; driverId?: string | null }, shopId: string): Promise<void> {
  if (!proofRequired(readDeliveryProof(route.constraints))) return;
  assertProofRollout(readDeliveryProof(route.constraints));
  if (route.driverId == null) throw new RoutePlanOptionsUpdateInvalidError('DELIVERY_PROOF_DRIVER_UPDATE_REQUIRED: assign a compatible driver before Dispatch');
  const driver = await tx.driver.findFirst({ where: { id: route.driverId, shopId, status: 'ACTIVE' }, select: { account: { select: { id: true, status: true, tokenVersion: true } } } });
  const account = driver?.account;
  if (account == null || account.status !== 'ACTIVE') throw new RoutePlanOptionsUpdateInvalidError('DELIVERY_PROOF_DRIVER_UPDATE_REQUIRED: active driver account required');
  const sessions = await tx.driverAccountSession.findMany({ where: { accountId: account.id, revokedAt: null, expiresAt: { gt: new Date() } },
    select: { deliveryProofCapability: true, capabilityVersionCode: true, capabilityPackageId: true, capabilityTokenVersion: true } });
  if (!sessions.some(session => session.deliveryProofCapability === 'delivery-proof-v1'
    && (session.capabilityVersionCode ?? 0) >= 43 && session.capabilityPackageId === 'com.evnsolution.clever.routes'
    && session.capabilityTokenVersion === account.tokenVersion)) throw new RoutePlanOptionsUpdateInvalidError('DELIVERY_PROOF_DRIVER_UPDATE_REQUIRED: an active driver account session must report delivery-proof-v1 from production versionCode 43 or newer before Dispatch');
}
function object(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; }
