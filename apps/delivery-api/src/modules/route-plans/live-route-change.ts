import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { hasDeliveryNavigationGraceExpired, hasDeliveryWorkCompleted } from './kfood-delivery-completion.js';
import { diagnoseRouteStopLocation } from './route-stop-location-diagnostic.js';
import { persistLiveRouteLocationCorrections } from './live-route-location-correction.js';

type Tx = Prisma.TransactionClient;
type Client = PrismaClient | Tx;
type Identity = { shopId: string; routePlanId: string };
type DriverIdentity = Identity & { driverId: string; accountId?: string; assignmentGeneration?: string };
const TERMINAL_STOPS = new Set(['DELIVERED', 'FAILED', 'SKIPPED', 'CANCELLED']);
const FUTURE_STATUSES = new Set(['PENDING', 'ASSIGNED']);
const STOP_EVENTS = new Set(['STOP_ARRIVED', 'STOP_DELIVERED', 'STOP_FAILED']);
const TEXT_FIELDS = ['recipientName', 'phone', 'address1', 'address2', 'city', 'province', 'postalCode', 'countryCode', 'instructions'] as const;
const ADDRESS_FIELDS = ['address1', 'address2', 'city', 'province', 'postalCode', 'countryCode'] as const;
const OPERATIONAL_FIELDS = [...TEXT_FIELDS, 'latitude', 'longitude', 'serviceMinutes', 'timeWindowStart', 'timeWindowEnd'] as const;

export type LiveRouteStopOverride = {
  deliveryStopId: string;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  province?: string | null;
  postalCode?: string | null;
  countryCode?: string | null;
  latitude?: number | string | null;
  longitude?: number | string | null;
};

export type LiveRouteStopSnapshot = {
  routePlanStopId: string;
  deliveryStopId: string;
  orderId: string;
  sourceOrderId: string | null;
  sequence: number;
  recipientName: string | null;
  phone: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  province: string | null;
  postalCode: string | null;
  countryCode: string | null;
  instructions: string | null;
  latitude: string | null;
  longitude: string | null;
  serviceMinutes: number;
  timeWindowStart: string | null;
  timeWindowEnd: string | null;
};
export type LiveRouteSnapshot = { schemaVersion: 1; stops: LiveRouteStopSnapshot[]; initialRouteVersionId?: string };
type AdminCommandIdentity = Identity & { commandId: string; expectedAssignmentGeneration: string; expectedRouteVersionId: string; expectedRevision: number };
export type SaveLiveRouteChangeInput = AdminCommandIdentity & {
  stopOverrides: LiveRouteStopOverride[];
  futureStopOrder?: string[];
};
export type PublishLiveRouteChangeInput = AdminCommandIdentity;

export class LiveRouteChangeError extends Error {
  constructor(public readonly code: string, public readonly statusCode: number, message: string) {
    super(message);
    this.name = 'LiveRouteChangeError';
  }
}

const routeSelect = {
  id: true, shopId: true, driverId: true, status: true, assignmentGeneration: true,
  driver: { select: { accountId: true, shopId: true, status: true, authSubject: true, account: { select: { status: true } } } },
  deliveryWorkCompletedAt: true, deliveryWorkCompletedGeneration: true,
  deliveryWorkCompletedVersionId: true, driverNavigationUntil: true,
  routeGroupingChildVersions: { where: { status: 'CURRENT', supersededAt: null }, take: 2, select: { id: true, driverId: true } },
  routeStops: { orderBy: { sequence: 'asc' }, include: { deliveryStop: { include: { order: { select: { sourceOrderId: true } } } } } }
} satisfies Prisma.RoutePlanSelect;
type Route = Prisma.RoutePlanGetPayload<{ select: typeof routeSelect }>;
type State = Prisma.RouteLiveChangeStateGetPayload<Record<string, never>>;
type Publication = Prisma.RouteLiveChangePublicationGetPayload<Record<string, never>>;

async function withRouteLock<T>(prisma: Client, identity: Identity, command: (tx: Tx) => Promise<T>): Promise<T> {
  const run = async (tx: Tx) => {
    await tx.$queryRaw`SELECT id FROM route_plans WHERE id = ${identity.routePlanId}::uuid AND "shopId" = ${identity.shopId}::uuid FOR UPDATE`;
    return command(tx);
  };
  return '$transaction' in prisma ? prisma.$transaction(run, { timeout: 15_000 }) : run(prisma);
}

async function loadRoute(tx: Tx, identity: Identity): Promise<Route> {
  const route = await tx.routePlan.findFirst({ where: { id: identity.routePlanId, shopId: identity.shopId }, select: routeSelect });
  if (route === null) throw new LiveRouteChangeError('NOT_FOUND', 404, 'Route was not found');
  return route;
}

function underlyingVersion(route: Route): string {
  if (route.routeGroupingChildVersions.length > 1) throw new LiveRouteChangeError('VERSION_CONFLICT', 409, 'Route has ambiguous current membership');
  const version = route.routeGroupingChildVersions[0];
  if (version !== undefined && version.driverId !== route.driverId) throw new LiveRouteChangeError('ASSIGNMENT_CHANGED', 409, 'Current route version belongs to another assignment');
  return version?.id ?? route.id;
}

function requireWritableRoute(route: Route): void {
  if (route.status !== 'IN_PROGRESS' || hasDeliveryWorkCompleted(route)) {
    throw new LiveRouteChangeError('ROUTE_NOT_IN_PROGRESS', 409, 'Future changes require active delivery work');
  }
  if (route.driverId === null) throw new LiveRouteChangeError('ASSIGNMENT_CHANGED', 409, 'Route has no assigned driver');
}

function requireDriver(route: Route, input: DriverIdentity, now: Date): void {
  if (route.driverId !== input.driverId || (input.assignmentGeneration !== undefined && route.assignmentGeneration.toString() !== input.assignmentGeneration)) {
    throw new LiveRouteChangeError('ASSIGNMENT_CHANGED', 409, 'Route assignment has changed');
  }
  if (route.driver === null || route.driver.shopId !== input.shopId || route.driver.status !== 'ACTIVE'
    || route.driver.authSubject === null || route.driver.account?.status !== 'ACTIVE'
    || (input.accountId !== undefined && route.driver.accountId !== input.accountId)) {
    throw new LiveRouteChangeError('ACCESS_REVOKED', 403, 'Driver access is no longer active');
  }
  if (route.status !== 'IN_PROGRESS' || hasDeliveryNavigationGraceExpired(route, now)) {
    throw new LiveRouteChangeError('ROUTE_NOT_IN_PROGRESS', 409, 'Route is no longer active');
  }
}

function captureSnapshot(route: Route): LiveRouteSnapshot {
  return { schemaVersion: 1, stops: route.routeStops.map((row) => {
    const stop = row.deliveryStop;
    return {
      routePlanStopId: row.id, deliveryStopId: row.deliveryStopId, orderId: stop.orderId,
      sourceOrderId: stop.order.sourceOrderId, sequence: row.sequence,
      recipientName: stop.recipientName, phone: stop.phone, address1: stop.address1, address2: stop.address2,
      city: stop.city, province: stop.province, postalCode: stop.postalCode, countryCode: stop.countryCode,
      instructions: stop.instructions, latitude: stop.latitude?.toString() ?? null, longitude: stop.longitude?.toString() ?? null,
      serviceMinutes: stop.serviceMinutes, timeWindowStart: stop.timeWindowStart?.toISOString() ?? null,
      timeWindowEnd: stop.timeWindowEnd?.toISOString() ?? null
    };
  }) };
}

function snapshotFromJson(value: Prisma.JsonValue): LiveRouteSnapshot {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1 || !Array.isArray(value.stops)) {
    throw new LiveRouteChangeError('VERSION_CONFLICT', 409, 'Stored route snapshot is invalid');
  }
  return value as unknown as LiveRouteSnapshot;
}

function contentHash(snapshot: LiveRouteSnapshot): string {
  // Postgres JSONB changes object key order. Hash canonical field order instead.
  const stops = snapshot.stops.map((stop) => [stop.routePlanStopId, stop.deliveryStopId, stop.orderId, stop.sourceOrderId, stop.sequence,
    ...OPERATIONAL_FIELDS.map((field) => stop[field])]);
  return createHash('sha256').update(JSON.stringify(stops)).digest('hex');
}

function operationalFingerprint(stop: LiveRouteStopSnapshot): string {
  return JSON.stringify([stop.routePlanStopId, stop.deliveryStopId, stop.orderId, stop.sourceOrderId, stop.sequence, ...OPERATIONAL_FIELDS.map((field) => stop[field])]);
}

function membership(snapshot: LiveRouteSnapshot): string {
  return JSON.stringify(snapshot.stops.map((stop) => JSON.stringify([stop.routePlanStopId, stop.deliveryStopId, stop.orderId, stop.sourceOrderId])).sort());
}

function editableFutureStopIds(route: Route): string[] {
  let protectedIndex = route.routeStops.findIndex((row) => !TERMINAL_STOPS.has(row.deliveryStop.status));
  if (protectedIndex < 0) return [];
  for (let index = protectedIndex + 1; index < route.routeStops.length; index += 1) {
    const status = route.routeStops[index]!.deliveryStop.status;
    if (status === 'ARRIVED' || status === 'EN_ROUTE') protectedIndex = index;
  }
  return route.routeStops.filter((row, index) => index > protectedIndex && FUTURE_STATUSES.has(row.deliveryStop.status)).map((row) => row.deliveryStopId);
}

function assertStateIdentity(route: Route, state: State): void {
  if (hasAssignmentChanged(route, state)) {
    throw new LiveRouteChangeError('ASSIGNMENT_CHANGED', 409, 'Draft belongs to an earlier assignment');
  }
  if (state.baselineRouteVersionId !== underlyingVersion(route)) {
    throw new LiveRouteChangeError('VERSION_CONFLICT', 409, 'Underlying route membership has changed');
  }
}

function hasAssignmentChanged(route: Route, state: State): boolean {
  return state.driverId !== route.driverId || state.assignmentGeneration !== route.assignmentGeneration;
}

function belongsToPreviousAssignment(route: Route, state: State): boolean {
  return state.assignmentGeneration < route.assignmentGeneration;
}

async function loadCurrentPublication(tx: Tx, state: State): Promise<Publication> {
  const publication = await tx.routeLiveChangePublication.findFirst({ where: {
    id: state.latestPublicationId, routePlanId: state.routePlanId, shopId: state.shopId,
    driverId: state.driverId, assignmentGeneration: state.assignmentGeneration, sequence: state.latestSequence
  } });
  if (publication === null) throw new LiveRouteChangeError('VERSION_CONFLICT', 409, 'Current publication was not found');
  return publication;
}

async function loadState(tx: Tx, identity: Identity): Promise<State | null> {
  return tx.routeLiveChangeState.findFirst({ where: { routePlanId: identity.routePlanId, shopId: identity.shopId } });
}

function assertNoLiveDrift(route: Route, publication: Publication): void {
  if (contentHash(captureSnapshot(route)) !== publication.contentHash) {
    throw new LiveRouteChangeError('VERSION_CONFLICT', 409, 'Live operational data changed outside this draft');
  }
}

function draftResponse(route: Route, state: State | null, publication: Publication | null) {
  const live = captureSnapshot(route);
  return {
    routePlanId: route.id, revision: state?.revision ?? 0, assignmentGeneration: route.assignmentGeneration.toString(),
    expectedRouteVersionId: underlyingVersion(route), publishedVersionId: publication?.id ?? null,
    hasUnpublishedChanges: state !== null && state.draftHash !== publication?.contentHash,
    editableFutureStopIds: editableFutureStopIds(route),
    draft: state === null ? live : snapshotFromJson(state.draftSnapshot)
  };
}

function publicationResponse(state: State, publication: Publication) {
  return {
    routePlanId: state.routePlanId, publicationVersionId: publication.id, assignmentGeneration: state.assignmentGeneration.toString(),
    sequence: publication.sequence, publishedAt: publication.publishedAt.toISOString(),
    appliedVersionId: state.appliedPublicationId, pending: state.appliedSequence < state.latestSequence,
    snapshot: snapshotFromJson(publication.snapshot)
  };
}

export async function getAdminLiveRouteChange(prisma: Client, input: Identity) {
  return withRouteLock(prisma, input, async (tx) => {
    const route = await loadRoute(tx, input);
    requireWritableRoute(route);
    const state = await loadState(tx, input);
    if (state === null || belongsToPreviousAssignment(route, state)) return draftResponse(route, null, null);
    assertStateIdentity(route, state);
    const current = await loadCurrentPublication(tx, state);
    assertNoLiveDrift(route, current);
    return draftResponse(route, state, current);
  });
}

async function enroll(tx: Tx, route: Route, input: Identity, replacing = false): Promise<State> {
  const snapshot = { ...captureSnapshot(route), initialRouteVersionId: underlyingVersion(route) };
  const id = randomUUID();
  const hash = contentHash(snapshot);
  await tx.routeLiveChangePublication.create({ data: { id, ...input, assignmentGeneration: route.assignmentGeneration,
    driverId: route.driverId!, sequence: 0, contentHash: hash, snapshot, notificationStatus: 'SKIPPED', nextAttemptAt: null } });
  const data = { ...input, assignmentGeneration: route.assignmentGeneration,
    driverId: route.driverId!, baselineRouteVersionId: underlyingVersion(route), draftSnapshot: snapshot,
    draftHash: hash, latestPublicationId: id, appliedPublicationId: id, revision: 0, latestSequence: 0,
    appliedSequence: 0, appliedAt: null };
  return replacing ? tx.routeLiveChangeState.update({ where: { routePlanId: route.id }, data }) : tx.routeLiveChangeState.create({ data });
}

function requireRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new LiveRouteChangeError('INVALID_INPUT', 400, 'expectedRevision must be a nonnegative safe integer');
}

function commandHash(value: unknown): string {
  function canonical(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(canonical);
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(Object.entries(input).filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, entry]) => [key, canonical(entry)]));
    }
    return input;
  }
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function requireCommandId(value: string): void {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new LiveRouteChangeError('INVALID_INPUT', 400, 'commandId must be a UUID');
  }
}

function requireAdminCommandIdentity(route: Route, input: AdminCommandIdentity, checkVersion = true): void {
  if (!/^[1-9]\d{0,18}$/u.test(input.expectedAssignmentGeneration)) throw new LiveRouteChangeError('INVALID_INPUT', 400, 'expectedAssignmentGeneration must be canonical positive decimal');
  if (route.assignmentGeneration.toString() !== input.expectedAssignmentGeneration) throw new LiveRouteChangeError('ASSIGNMENT_CHANGED', 409, 'Route assignment has changed since the draft was read');
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(input.expectedRouteVersionId)) throw new LiveRouteChangeError('INVALID_INPUT', 400, 'expectedRouteVersionId must be a UUID');
  const version = underlyingVersion(route);
  if (checkVersion && version !== input.expectedRouteVersionId) throw new LiveRouteChangeError('VERSION_CONFLICT', 409, 'Route membership has changed since the draft was read');
  if (route.driverId === null || route.status !== 'IN_PROGRESS') throw new LiveRouteChangeError('ROUTE_NOT_IN_PROGRESS', 409, 'Route is no longer active');
}

type DraftResponse = ReturnType<typeof draftResponse>;
type PublishResponse = ReturnType<typeof publicationResponse> & { revision: number; changed: boolean };

async function replayCommand<T>(tx: Tx, route: Route, input: Identity & { commandId: string }, kind: 'SAVE' | 'DISPATCH' | 'DISCARD', requestHash: string): Promise<T | null> {
  const receipt = await tx.routeLiveChangeCommandReceipt.findFirst({ where: { ...inputIdentity(input), kind, commandId: input.commandId } });
  if (receipt === null) return null;
  if (receipt.driverId !== route.driverId || receipt.assignmentGeneration !== route.assignmentGeneration) {
    throw new LiveRouteChangeError('ASSIGNMENT_CHANGED', 409, 'Command belongs to an earlier assignment');
  }
  if (receipt.requestHash !== requestHash) throw new LiveRouteChangeError('IDEMPOTENCY_CONFLICT', 409, 'commandId was used with different request content');
  return receipt.response as unknown as T;
}

async function recordCommand(tx: Tx, route: Route, input: Identity & { commandId: string }, kind: 'SAVE' | 'DISPATCH' | 'DISCARD', requestHash: string,
  response: DraftResponse | PublishResponse, publicationId: string | null): Promise<void> {
  await tx.routeLiveChangeCommandReceipt.create({ data: { ...inputIdentity(input), commandId: input.commandId, kind,
    driverId: route.driverId!, assignmentGeneration: route.assignmentGeneration, requestHash,
    response, publicationId } });
}

function patchStop(stop: LiveRouteStopSnapshot, override: LiveRouteStopOverride): LiveRouteStopSnapshot {
  const allowed = new Set<string>(['deliveryStopId', ...ADDRESS_FIELDS, 'latitude', 'longitude']);
  if (Object.keys(override).some((field) => !allowed.has(field))) throw new LiveRouteChangeError('INVALID_INPUT', 400, 'Only address and coordinates can be overridden');
  const next = { ...stop };
  for (const field of ADDRESS_FIELDS) {
    const value = override[field];
    if (value !== undefined) {
      if (value !== null && (typeof value !== 'string' || value.length > 10_000)) throw new LiveRouteChangeError('INVALID_INPUT', 400, `Invalid ${field}`);
      next[field] = value;
    }
  }
  const hasLatitude = override.latitude !== undefined;
  const hasLongitude = override.longitude !== undefined;
  if (hasLatitude !== hasLongitude || ((override.latitude === null) !== (override.longitude === null))) {
    throw new LiveRouteChangeError('INVALID_INPUT', 400, 'Latitude and longitude must be supplied together');
  }
  if (hasLatitude) {
    const latitude = override.latitude === null ? null : Number(override.latitude);
    const longitude = override.longitude === null ? null : Number(override.longitude);
    if ((latitude !== null && (!Number.isFinite(latitude) || latitude < -90 || latitude > 90))
      || (longitude !== null && (!Number.isFinite(longitude) || longitude < -180 || longitude > 180))) {
      throw new LiveRouteChangeError('INVALID_INPUT', 400, 'Coordinates are out of range');
    }
    next.latitude = latitude === null ? null : new Prisma.Decimal(latitude).toDecimalPlaces(7).toString();
    next.longitude = longitude === null ? null : new Prisma.Decimal(longitude).toDecimalPlaces(7).toString();
  } else if (ADDRESS_FIELDS.some((field) => next[field] !== stop[field])) {
    // Coordinates for the old address must not remain a routeable new address.
    next.latitude = null;
    next.longitude = null;
  }
  return next;
}

export async function saveLiveRouteChange(prisma: Client, input: SaveLiveRouteChangeInput) {
  requireRevision(input.expectedRevision);
  requireCommandId(input.commandId);
  const requestHash = commandHash({ expectedRevision: input.expectedRevision, expectedAssignmentGeneration: input.expectedAssignmentGeneration,
    expectedRouteVersionId: input.expectedRouteVersionId, stopOverrides: input.stopOverrides, futureStopOrder: input.futureStopOrder });
  return withRouteLock(prisma, input, async (tx) => {
    const route = await loadRoute(tx, input);
    requireAdminCommandIdentity(route, input, false);
    const identity = { routePlanId: input.routePlanId, shopId: input.shopId };
    let state = await loadState(tx, identity);
    if (state !== null && !belongsToPreviousAssignment(route, state)) assertStateIdentity(route, state);
    const replay = await replayCommand<DraftResponse>(tx, route, input, 'SAVE', requestHash);
    if (replay !== null) return replay;
    requireAdminCommandIdentity(route, input);
    requireWritableRoute(route);
    if (state === null || belongsToPreviousAssignment(route, state)) {
      if (input.expectedRevision !== 0) throw new LiveRouteChangeError('REVISION_CONFLICT', 409, 'Draft revision has changed');
      state = await enroll(tx, route, identity, state !== null);
    }
    assertStateIdentity(route, state);
    const current = await loadCurrentPublication(tx, state);
    assertNoLiveDrift(route, current);
    if (state.revision !== input.expectedRevision) throw new LiveRouteChangeError('REVISION_CONFLICT', 409, 'Draft revision has changed');
    const editable = new Set(editableFutureStopIds(route));
    const snapshot = snapshotFromJson(state.draftSnapshot);
    const overridden = new Set<string>();
    for (const override of input.stopOverrides) {
      if (overridden.has(override.deliveryStopId)) throw new LiveRouteChangeError('INVALID_INPUT', 400, 'Duplicate stop override');
      overridden.add(override.deliveryStopId);
      if (!editable.has(override.deliveryStopId)) throw new LiveRouteChangeError('STOP_NOT_FUTURE', 409, 'Only future pending stops can be changed');
      const index = snapshot.stops.findIndex((stop) => stop.deliveryStopId === override.deliveryStopId);
      if (index < 0) throw new LiveRouteChangeError('VERSION_CONFLICT', 409, 'Draft membership has changed');
      snapshot.stops[index] = patchStop(snapshot.stops[index]!, override);
    }
    if (input.futureStopOrder !== undefined) {
      const order = input.futureStopOrder;
      if (order.length !== editable.size || new Set(order).size !== order.length || order.some((id) => !editable.has(id))) {
        throw new LiveRouteChangeError('INVALID_INPUT', 400, 'futureStopOrder must contain every editable future stop once');
      }
      const byId = new Map(snapshot.stops.map((stop) => [stop.deliveryStopId, stop]));
      let cursor = 0;
      snapshot.stops = snapshot.stops.map((stop) => editable.has(stop.deliveryStopId)
        ? { ...byId.get(order[cursor++]!)!, sequence: stop.sequence } : stop);
    }
    const hash = contentHash(snapshot);
    if (hash !== state.draftHash) state = await tx.routeLiveChangeState.update({ where: { routePlanId: route.id },
      data: { draftSnapshot: snapshot, draftHash: hash, revision: { increment: 1 } } });
    const response = draftResponse(route, state, current);
    await recordCommand(tx, route, input, 'SAVE', requestHash, response, null);
    return response;
  });
}

function changedStops(current: LiveRouteSnapshot, draft: LiveRouteSnapshot): LiveRouteStopSnapshot[] {
  if (membership(current) !== membership(draft)) throw new LiveRouteChangeError('VERSION_CONFLICT', 409, 'Draft membership has changed');
  const byId = new Map(current.stops.map((stop) => [stop.deliveryStopId, stop]));
  return draft.stops.filter((stop) => {
    const previous = byId.get(stop.deliveryStopId)!;
    return stop.sequence !== previous.sequence || operationalFingerprint(stop) !== operationalFingerprint(previous);
  });
}

// Recovery never edits current stops or publication history. A repeated command
// returns its original receipt even if another Save has since changed the draft.
export async function discardLiveRouteChange(prisma: Client, input: PublishLiveRouteChangeInput) {
  requireRevision(input.expectedRevision);
  requireCommandId(input.commandId);
  const requestHash = commandHash({ expectedRevision: input.expectedRevision, expectedAssignmentGeneration: input.expectedAssignmentGeneration,
    expectedRouteVersionId: input.expectedRouteVersionId });
  return withRouteLock(prisma, input, async (tx) => {
    const route = await loadRoute(tx, input);
    requireAdminCommandIdentity(route, input, false);
    let state = await loadState(tx, input);
    if (state === null) throw new LiveRouteChangeError('DRAFT_NOT_FOUND', 409, 'No draft exists to discard');
    assertStateIdentity(route, state);
    const replay = await replayCommand<DraftResponse>(tx, route, input, 'DISCARD', requestHash);
    if (replay !== null) return replay;
    requireAdminCommandIdentity(route, input);
    requireWritableRoute(route);
    if (state.revision !== input.expectedRevision) throw new LiveRouteChangeError('REVISION_CONFLICT', 409, 'Draft revision has changed');
    const current = await loadCurrentPublication(tx, state);
    assertNoLiveDrift(route, current);
    if (state.draftHash !== current.contentHash) state = await tx.routeLiveChangeState.update({ where: { routePlanId: route.id },
      data: { draftSnapshot: current.snapshot as Prisma.InputJsonValue, draftHash: current.contentHash, revision: { increment: 1 } } });
    const response = draftResponse(route, state, current);
    await recordCommand(tx, route, input, 'DISCARD', requestHash, response, current.id);
    return response;
  });
}

export type LiveRouteChildReplacementContext = { identity: Identity; state: State; current: Publication };

// Existing successor writers call this before mutating stops while holding the
// route lock. Private drafts require an explicit discard, never an implicit loss.
export async function prepareLiveRouteChildReplacement(tx: Tx, input: Identity & { currentChildVersionId: string }): Promise<LiveRouteChildReplacementContext | null> {
  const state = await loadState(tx, input);
  if (state === null) return null;
  const route = await loadRoute(tx, input);
  if (hasDeliveryWorkCompleted(route)) requireWritableRoute(route);
  if (belongsToPreviousAssignment(route, state)) return null;
  assertStateIdentity(route, state);
  requireWritableRoute(route);
  if (underlyingVersion(route) !== input.currentChildVersionId) throw new LiveRouteChangeError('VERSION_CONFLICT', 409, 'Successor predecessor is no longer current');
  const current = await loadCurrentPublication(tx, state);
  assertNoLiveDrift(route, current);
  if (state.draftHash !== current.contentHash) throw new LiveRouteChangeError('DRAFT_CONFLICT', 409, 'Discard the private live-change draft before replacing route membership');
  return { identity: inputIdentity(input), state, current };
}

// Preserve immutable lineage and the applied cursor. A successor child is also
// its publication UUID so legacy callers and live-change readers issue one ID.
export async function completeLiveRouteChildReplacement(tx: Tx, input: { context: LiveRouteChildReplacementContext; nextChildVersionId: string }): Promise<void> {
  const { identity, state, current } = input.context;
  const route = await loadRoute(tx, identity);
  if (belongsToPreviousAssignment(route, state)) return; // A real reassignment uses its new generic contract.
  if (hasAssignmentChanged(route, state)) throw new LiveRouteChangeError('ASSIGNMENT_CHANGED', 409, 'Successor assignment is inconsistent');
  if (underlyingVersion(route) !== input.nextChildVersionId) throw new LiveRouteChangeError('VERSION_CONFLICT', 409, 'Successor membership is ambiguous');
  const previous = snapshotFromJson(current.snapshot);
  const snapshot: LiveRouteSnapshot = { ...captureSnapshot(route), initialRouteVersionId: previous.initialRouteVersionId ?? state.baselineRouteVersionId };
  if (membership(previous) !== membership(snapshot)) throw new LiveRouteChangeError('VERSION_CONFLICT', 409, 'Live-change successors require unchanged membership');
  const oldStops = new Map(previous.stops.map(stop => [stop.deliveryStopId, stop]));
  if (snapshot.stops.some(stop => operationalFingerprint({ ...stop, sequence: oldStops.get(stop.deliveryStopId)!.sequence }) !== operationalFingerprint(oldStops.get(stop.deliveryStopId)!))) {
    throw new LiveRouteChangeError('VERSION_CONFLICT', 409, 'Successor changed operational data outside Dispatch');
  }
  const hash = contentHash(snapshot);
  const publication = await tx.routeLiveChangePublication.create({ data: { ...identity, id: input.nextChildVersionId,
    driverId: state.driverId, assignmentGeneration: state.assignmentGeneration, sequence: state.latestSequence + 1,
    snapshot, contentHash: hash, notificationStatus: 'SKIPPED', nextAttemptAt: null, errorCode: 'LEGACY_CHILD_REPLACEMENT' } });
  await tx.routeLiveChangeState.update({ where: { routePlanId: route.id }, data: {
    baselineRouteVersionId: input.nextChildVersionId, latestPublicationId: publication.id, latestSequence: publication.sequence,
    draftSnapshot: snapshot, draftHash: hash, revision: { increment: 1 }
  } });
}

export async function publishLiveRouteChange(prisma: Client, input: PublishLiveRouteChangeInput) {
  requireRevision(input.expectedRevision);
  requireCommandId(input.commandId);
  const requestHash = commandHash({ expectedRevision: input.expectedRevision, expectedAssignmentGeneration: input.expectedAssignmentGeneration,
    expectedRouteVersionId: input.expectedRouteVersionId });
  return withRouteLock(prisma, input, async (tx) => {
    let route = await loadRoute(tx, input);
    requireAdminCommandIdentity(route, input, false);
    const state = await loadState(tx, input);
    if (state === null) throw new LiveRouteChangeError('DRAFT_NOT_FOUND', 409, 'Save a draft before Dispatch');
    assertStateIdentity(route, state);
    const replay = await replayCommand<PublishResponse>(tx, route, input, 'DISPATCH', requestHash);
    if (replay !== null) return replay;
    requireAdminCommandIdentity(route, input);
    requireWritableRoute(route);
    if (state.revision !== input.expectedRevision) throw new LiveRouteChangeError('REVISION_CONFLICT', 409, 'Draft revision has changed');
    const current = await loadCurrentPublication(tx, state);
    assertNoLiveDrift(route, current);
    if (state.draftHash === current.contentHash) {
      const response = { ...publicationResponse(state, current), revision: state.revision, changed: false };
      await recordCommand(tx, route, input, 'DISPATCH', requestHash, response, current.id);
      return response;
    }
    // Driver ingestion uses this same route lock. Stop locks also exclude legacy operational writes.
    const stopIds = route.routeStops.map((row) => row.deliveryStopId).sort();
    if (stopIds.length > 0) await tx.$queryRaw(Prisma.sql`SELECT id FROM delivery_stops WHERE "shopId" = ${input.shopId}::uuid AND id::text IN (${Prisma.join(stopIds)}) ORDER BY id FOR UPDATE`);
    route = await loadRoute(tx, input);
    requireWritableRoute(route);
    assertStateIdentity(route, state);
    assertNoLiveDrift(route, current);
    const draft = snapshotFromJson(state.draftSnapshot);
    const live = captureSnapshot(route);
    const changes = changedStops(live, draft);
    const editable = new Set(editableFutureStopIds(route));
    if (changes.some((stop) => !editable.has(stop.deliveryStopId))) throw new LiveRouteChangeError('STOP_NOT_FUTURE', 409, 'A changed stop is no longer future and pending');
    const byId = new Map(live.stops.map((stop) => [stop.deliveryStopId, stop]));
    for (const stop of changes) {
      const previous = byId.get(stop.deliveryStopId)!;
      if (!ADDRESS_FIELDS.some((field) => previous[field] !== stop[field]) && previous.latitude === stop.latitude && previous.longitude === stop.longitude) continue;
      const diagnostic = diagnoseRouteStopLocation({ countryCode: stop.countryCode, province: stop.province,
        latitude: stop.latitude, longitude: stop.longitude, geocodeStatus: 'RESOLVED' });
      if (!diagnostic.routeable) throw new LiveRouteChangeError('STOP_LOCATION_NOT_ROUTEABLE', 409,
        `Changed stop requires a routeable location: ${diagnostic.issues.join(', ')}`);
    }
    for (const stop of changes) {
      const previous = byId.get(stop.deliveryStopId)!;
      const data: Prisma.DeliveryStopUpdateManyMutationInput = {};
      for (const field of TEXT_FIELDS) if (previous[field] !== stop[field]) data[field] = stop[field];
      if (previous.latitude !== stop.latitude) data.latitude = stop.latitude;
      if (previous.longitude !== stop.longitude) data.longitude = stop.longitude;
      if (previous.serviceMinutes !== stop.serviceMinutes) data.serviceMinutes = stop.serviceMinutes;
      if (previous.timeWindowStart !== stop.timeWindowStart) data.timeWindowStart = stop.timeWindowStart === null ? null : new Date(stop.timeWindowStart);
      if (previous.timeWindowEnd !== stop.timeWindowEnd) data.timeWindowEnd = stop.timeWindowEnd === null ? null : new Date(stop.timeWindowEnd);
      if (ADDRESS_FIELDS.some((field) => previous[field] !== stop[field]) || previous.latitude !== stop.latitude || previous.longitude !== stop.longitude) {
        data.geocodeStatus = stop.latitude === null || stop.longitude === null ? 'PENDING' : 'RESOLVED';
      }
      if (Object.keys(data).length > 0) {
        const updated = await tx.deliveryStop.updateMany({ where: { id: stop.deliveryStopId, shopId: input.shopId, status: { in: ['PENDING', 'ASSIGNED'] } }, data });
        if (updated.count !== 1) throw new LiveRouteChangeError('STOP_NOT_FUTURE', 409, 'A changed stop is no longer pending');
      }
    }
    const reordered = changes.filter((stop) => byId.get(stop.deliveryStopId)!.sequence !== stop.sequence);
    // Move to unused positive positions first so the unique route/sequence key never collides.
    const temporaryBase = Math.max(0, ...live.stops.map((stop) => stop.sequence), ...draft.stops.map((stop) => stop.sequence)) + 1;
    for (let index = 0; index < reordered.length; index += 1) await tx.routePlanStop.update({ where: { id: reordered[index]!.routePlanStopId }, data: { sequence: temporaryBase + index } });
    for (const stop of reordered) await tx.routePlanStop.update({ where: { id: stop.routePlanStopId }, data: { sequence: stop.sequence } });
    await tx.routePlanGeometryCache.deleteMany({ where: { routePlanId: route.id } });
    await tx.routePlanStop.updateMany({ where: { routePlanId: route.id, shopId: input.shopId, deliveryStopId: { in: [...editable] }, deliveryStop: { status: { in: ['PENDING', 'ASSIGNED'] } } },
      data: { estimatedArrivalAt: null, distanceFromPreviousMeters: null, durationFromPreviousSeconds: null, etaCalculatedAt: null,
        etaFailureCode: null, etaFailureMessage: null, etaInputRouteVersionId: null, etaSource: 'LIVE_ROUTE_CHANGE', etaStatus: 'STALE' } });
    const publication = await tx.routeLiveChangePublication.create({ data: { ...inputIdentity(input), id: randomUUID(), driverId: state.driverId,
      assignmentGeneration: state.assignmentGeneration, sequence: state.latestSequence + 1, contentHash: state.draftHash,
      snapshot: draft, notificationStatus: 'PENDING' } });
    const changedLocations = new Set(changes.filter((stop) => {
      const previous = byId.get(stop.deliveryStopId)!;
      return ADDRESS_FIELDS.some((field) => previous[field] !== stop[field]) || previous.latitude !== stop.latitude || previous.longitude !== stop.longitude;
    }).map((stop) => stop.deliveryStopId));
    await persistLiveRouteLocationCorrections(tx, { ...inputIdentity(input), publicationVersionId: publication.id, publishedAt: publication.publishedAt,
      stops: route.routeStops.filter((stop) => changedLocations.has(stop.deliveryStopId)).map((stop) => stop.deliveryStop) });
    // A Serializable sync that took its snapshot before waiting on this route lock must retry.
    await tx.routePlan.update({ where: { id: route.id }, data: { updatedAt: new Date() } });
    const updatedState = await tx.routeLiveChangeState.update({ where: { routePlanId: route.id },
      data: { latestPublicationId: publication.id, latestSequence: publication.sequence } });
    const response = { ...publicationResponse(updatedState, publication), revision: state.revision, changed: true };
    await recordCommand(tx, route, input, 'DISPATCH', requestHash, response, publication.id);
    return response;
  });
}

function inputIdentity(input: Identity): Identity { return { routePlanId: input.routePlanId, shopId: input.shopId }; }

export async function getLiveRouteChange(prisma: Client, input: DriverIdentity & { now?: Date }) {
  return withRouteLock(prisma, input, async (tx) => {
    const route = await loadRoute(tx, input);
    requireDriver(route, input, input.now ?? new Date());
    const state = await loadState(tx, inputIdentity(input));
    underlyingVersion(route);
    if (state === null || belongsToPreviousAssignment(route, state)) return null;
    assertStateIdentity(route, state);
    const publication = await loadCurrentPublication(tx, state);
    assertNoLiveDrift(route, publication);
    return publicationResponse(state, publication);
  });
}

export async function acknowledgeLiveRouteChange(prisma: Client, input: DriverIdentity & { assignmentGeneration: string; publicationVersionId: string; now?: Date }) {
  return withRouteLock(prisma, input, async (tx) => {
    const route = await loadRoute(tx, input);
    requireDriver(route, input, input.now ?? new Date());
    let state = await loadState(tx, inputIdentity(input));
    if (state === null) throw new LiveRouteChangeError('PUBLICATION_NOT_FOUND', 404, 'Route publication was not found');
    assertStateIdentity(route, state);
    const publication = await tx.routeLiveChangePublication.findFirst({ where: {
      id: input.publicationVersionId, ...inputIdentity(input), driverId: input.driverId, assignmentGeneration: route.assignmentGeneration
    } });
    if (publication === null || publication.sequence > state.latestSequence) throw new LiveRouteChangeError('PUBLICATION_NOT_FOUND', 404, 'Route publication was not found');
    if (publication.sequence > state.appliedSequence) state = await tx.routeLiveChangeState.update({ where: { routePlanId: route.id },
      data: { appliedPublicationId: publication.id, appliedSequence: publication.sequence, appliedAt: input.now ?? new Date() } });
    const latest = await loadCurrentPublication(tx, state);
    assertNoLiveDrift(route, latest);
    return publicationResponse(state, latest);
  });
}

export type LiveRouteEventInput = DriverIdentity & { assignmentGeneration: string; expectedRouteVersionId: string; eventType: string; deliveryStopId?: string | null; occurredAt?: Date };

// Caller holds the same route row lock as Dispatch and driver event ingestion.
export async function validateLiveRouteEvent(tx: Tx, input: LiveRouteEventInput): Promise<boolean> {
  const state = await loadState(tx, inputIdentity(input));
  if (state === null) return false;
  const route = await loadRoute(tx, input);
  requireDriver(route, input, new Date());
  underlyingVersion(route);
  if (belongsToPreviousAssignment(route, state)) return false;
  assertStateIdentity(route, state);
  const current = await loadCurrentPublication(tx, state);
  assertNoLiveDrift(route, current);
  const initialRouteVersionId = snapshotFromJson(current.snapshot).initialRouteVersionId ?? state.baselineRouteVersionId;
  if (input.expectedRouteVersionId === current.id || (state.latestSequence === 0 && input.expectedRouteVersionId === initialRouteVersionId)) return true;
  if (!STOP_EVENTS.has(input.eventType) || input.deliveryStopId == null) throw new LiveRouteChangeError('VERSION_CONFLICT', 409, 'Execution event requires the latest publication');
  const origin = input.expectedRouteVersionId === initialRouteVersionId
    ? await tx.routeLiveChangePublication.findFirst({ where: { ...inputIdentity(input), driverId: state.driverId, assignmentGeneration: state.assignmentGeneration, sequence: 0 } })
    : await tx.routeLiveChangePublication.findFirst({ where: { id: input.expectedRouteVersionId, ...inputIdentity(input), driverId: state.driverId, assignmentGeneration: state.assignmentGeneration } });
  if (origin === null || origin.sequence >= current.sequence) throw new LiveRouteChangeError('VERSION_CONFLICT', 409, 'Execution event references an unrelated publication');
  const originSnapshot = snapshotFromJson(origin.snapshot);
  const target = originSnapshot.stops.find((stop) => stop.deliveryStopId === input.deliveryStopId);
  if (target === undefined) throw new LiveRouteChangeError('VERSION_CONFLICT', 409, 'Execution event stop is outside its publication');
  const fingerprint = operationalFingerprint(target);
  const originalMembership = membership(originSnapshot);
  const publications = await tx.routeLiveChangePublication.findMany({ where: { ...inputIdentity(input), driverId: state.driverId,
    assignmentGeneration: state.assignmentGeneration, sequence: { gt: origin.sequence, lte: current.sequence } }, orderBy: { sequence: 'asc' } });
  if (publications.length !== current.sequence - origin.sequence) throw new LiveRouteChangeError('VERSION_CONFLICT', 409, 'Publication history is incomplete');
  for (const snapshot of [...publications.map((row) => snapshotFromJson(row.snapshot)), captureSnapshot(route)]) {
    const stop = snapshot.stops.find((row) => row.deliveryStopId === input.deliveryStopId);
    if (membership(snapshot) !== originalMembership || stop === undefined || operationalFingerprint(stop) !== fingerprint) {
      throw new LiveRouteChangeError('VERSION_CONFLICT', 409, 'Execution event stop changed after its publication');
    }
  }
  return true;
}

// Read projection only. Integrators authenticate the route and supply the captured assignment.
export async function resolveLiveRoutePublication(prisma: Pick<Tx, 'routePlan' | 'routeLiveChangeState' | 'routeLiveChangePublication'>,
  input: DriverIdentity & { assignmentGeneration: string }) {
  const state = await prisma.routeLiveChangeState.findFirst({ where: { ...inputIdentity(input), driverId: input.driverId,
    assignmentGeneration: BigInt(input.assignmentGeneration) } });
  if (state === null) return null;
  const route = await prisma.routePlan.findFirst({ where: { id: input.routePlanId, shopId: input.shopId, driverId: input.driverId,
    assignmentGeneration: state.assignmentGeneration }, select: routeSelect });
  if (route === null || state.baselineRouteVersionId !== underlyingVersion(route)) return null;
  const publication = await prisma.routeLiveChangePublication.findFirst({ where: { id: state.latestPublicationId, ...inputIdentity(input),
    driverId: input.driverId, assignmentGeneration: state.assignmentGeneration } });
  if (publication === null) return null;
  assertNoLiveDrift(route, publication);
  return publicationResponse(state, publication);
}
