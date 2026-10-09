import type { Prisma } from '@prisma/client';
import type { RecordDriverEventInput } from './driver-event.repository.js';
import { readDeliveryProof, proofRequired } from '../route-plans/delivery-options.js';
export class DriverDeliveryProofError extends Error {
  constructor(readonly code: 'DELIVERY_PROOF_REQUIRED' | 'DELIVERY_PROOF_INVALID' | 'DELIVERY_PROOF_APP_UPDATE_REQUIRED', message: string) { super(message); }
}
export async function validateDriverDeliveryProof(tx: Prisma.TransactionClient, input: RecordDriverEventInput): Promise<void> {
  if (!['STOP_DELIVERED', 'ROUTE_STARTED', 'PICKUP_COMPLETED'].includes(input.eventType) || input.routePlanId === null) return;
  const route = await tx.routePlan.findFirst({ where: { id: input.routePlanId, shopId: input.shopId, driverId: input.driverId }, select: { constraints: true } });
  if (route === null) return;
  const policy = readDeliveryProof(route.constraints);
  if (!proofRequired(policy)) return;
  if ((input.versionCode ?? 0) < 43 || object(input.payload)?.deliveryProofCapability !== 'delivery-proof-v1') throw new DriverDeliveryProofError('DELIVERY_PROOF_APP_UPDATE_REQUIRED', 'Update the driver app before starting a route requiring delivery proof');
  if (input.eventType !== 'STOP_DELIVERED') return;
  const proof = object(object(input.payload)?.proof);
  for (const [required, field, kind] of [[policy.photoRequired, 'photoMediaId', 'PHOTO'], [policy.signatureRequired, 'signatureMediaId', 'SIGNATURE']] as const) {
    if (!required) continue;
    const mediaId = proof?.[field];
    if (typeof mediaId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(mediaId)) throw new DriverDeliveryProofError('DELIVERY_PROOF_REQUIRED', `Upload required ${kind.toLowerCase()} before completion`);
    const media = await tx.driverProofMedia.findFirst({ where: { id: mediaId, kind, shopId: input.shopId, routePlanId: input.routePlanId,
      deliveryStopId: input.deliveryStopId!, driverId: input.driverId, uploadStatus: 'READY', deletedAt: null,
      ...(kind === 'SIGNATURE' ? { source: 'SIGNATURE', contentType: 'image/png' } : { source: { in: ['CAMERA', 'LIBRARY'] } }) }, select: { id: true } });
    if (media === null) throw new DriverDeliveryProofError('DELIVERY_PROOF_INVALID', 'Required proof must belong to this driver, route and stop');
  }
}
function object(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; }
