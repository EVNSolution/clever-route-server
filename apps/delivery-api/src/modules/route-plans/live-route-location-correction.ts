import type { Prisma } from '@prisma/client';

const LOCATION_FIELDS = ['address1', 'address2', 'city', 'province', 'postalCode', 'countryCode', 'latitude', 'longitude', 'geocodeStatus'];
type CorrectionTx = Pick<Prisma.TransactionClient, 'orderDeliveryFact' | 'order'>;
type CorrectionStop = { orderId: string; deliveryDate: Date | null; timeWindowStart: Date | null; timeWindowEnd: Date | null };

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

// The whole location tuple is one CLEVER correction. Upstream source address remains independent.
export async function persistLiveRouteLocationCorrections(tx: CorrectionTx,
  input: { shopId: string; routePlanId: string; publicationVersionId: string; publishedAt: Date; stops: CorrectionStop[] }): Promise<void> {
  for (const stop of input.stops) {
    const key = { shopId: input.shopId, orderId: stop.orderId };
    const fact = await tx.orderDeliveryFact.findUnique({ where: { shopId_orderId: key }, select: { mappingDiagnostics: true } });
    const diagnostics = { ...object(fact?.mappingDiagnostics) };
    const corrections = object(diagnostics.routeOpsCorrections);
    const fields = { ...object(corrections.fields) };
    const correctedAt = input.publishedAt.toISOString();
    for (const field of LOCATION_FIELDS) fields[field] = { actor: 'live_route_dispatch', source: 'live_route_dispatch', correctedAt,
      routePlanId: input.routePlanId, publicationVersionId: input.publicationVersionId };
    diagnostics.routeOpsCorrections = { ...corrections, fields, lastUpdatedAt: correctedAt, version: 1 };
    const mappingDiagnostics = diagnostics as Prisma.InputJsonObject;
    if (fact !== null) {
      await tx.orderDeliveryFact.update({ where: { shopId_orderId: key }, data: { mappingDiagnostics, geocodeStatus: 'RESOLVED' } });
      continue;
    }
    const order = await tx.order.findFirstOrThrow({ where: { id: stop.orderId, shopId: input.shopId }, select: {
      sourcePlatform: true, sourceSiteUrl: true, sourceOrderId: true, sourceOrderNumber: true, sourceUpdatedAt: true
    } });
    // Legacy records without canonical facts get a metadata carrier with their existing UTC schedule.
    await tx.orderDeliveryFact.create({ data: { ...key, ...order, mappingDiagnostics, matchedMappingPaths: {}, reviewReasons: [],
      deliveryDate: stop.deliveryDate, timeWindowStart: stop.timeWindowStart, timeWindowEnd: stop.timeWindowEnd,
      geocodeStatus: 'RESOLVED' } });
  }
}
