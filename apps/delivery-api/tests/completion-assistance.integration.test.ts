import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { registerDriverCompletionAssistanceRoutes } from '../src/routes/driver-completion-assistance.routes.js';
import { signDriverAccountToken } from '../src/modules/driver/driver-token-verifier.js';
import { PrismaDriverTokenAccessRepository } from '../src/modules/driver/driver-token-access.repository.js';
import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, test } from 'vitest';
import { PrismaCompletionAssistanceService } from '../src/modules/driver/completion-assistance.service.js';
import { PrismaRoutePlanRepository } from '../src/modules/route-plans/route-plan.repository.js';
import { PrismaDriverEventRepository } from '../src/modules/driver/driver-event.repository.js';
import type { CompletionCandidate, CompletionCommand, CompletionPolicy } from '../src/modules/driver/completion-assistance.contract.js';

const databaseUrl = process.env.COMPLETION_ASSISTANCE_DATABASE_URL;
const enabled = process.env.COMPLETION_ASSISTANCE_DATABASE_TARGET_CLASS === 'safe-local-completion-assistance-disposable';
if (enabled && databaseUrl !== undefined) {
  const url = new URL(databaseUrl);
  if (url.protocol !== 'postgresql:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || !url.pathname.endsWith('_disposable')) throw new Error('Completion integration requires a named disposable loopback database');
}
const describeDatabase = enabled && databaseUrl !== undefined ? describe : describe.skip;
const base = Date.parse('2030-09-17T12:00:00.000Z');
const iso = (offset: number) => new Date(base + offset).toISOString();
const day = 86_400_000;

describeDatabase('completion assistance PostgreSQL transactions', () => {
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl ?? 'postgresql://disabled@127.0.0.1:1/disabled' });
  // Fixtures are intentionally retained: append-only audit records must never be deleted.
  afterAll(async () => { await prisma.$disconnect(); });

  async function fixture(options: { worker?: boolean; neighbor?: boolean; accuracy?: number; gap?: boolean } = {}) {
    const suffix = randomUUID();
    const shop = await prisma.shop.create({ data: { shopDomain: `completion-${suffix}.myshopify.com`, appId: 'clever' } });
    const account = await prisma.driverAccount.create({ data: { phone: `completion-${suffix}` } });
    const driver = await prisma.driver.create({ data: { accountId: account.id, displayName: 'Completion integration', shopId: shop.id } });
    const route = await prisma.routePlan.create({ data: { shopId: shop.id, driverId: driver.id, name: 'Completion integration', planDate: new Date(base), constraints: {}, metrics: {}, optimizerVersion: 'integration', status: 'IN_PROGRESS' } });
    const grouping = await prisma.routeGrouping.create({ data: { shopId: shop.id, name: 'Completion integration', planDate: new Date(base) } });
    const groupingVersion = await prisma.routeGroupingVersion.create({ data: { shopId: shop.id, groupingId: grouping.id, version: 1 } });
    const version = await prisma.routeGroupingChildVersion.create({ data: { shopId: shop.id, groupingId: grouping.id, groupingVersionId: groupingVersion.id, routePlanId: route.id, driverId: driver.id, version: 1, snapshot: {} } });
    const stops = [];
    for (let index = 0; index < (options.neighbor ? 2 : 1); index += 1) {
      const order = await prisma.order.create({ data: { name: `#${index}`, rawPayload: {}, shopId: shop.id, shopifyOrderGid: `gid://shopify/Order/${suffix}-${index}` } });
      const stop = await prisma.deliveryStop.create({ data: { orderId: order.id, shopId: shop.id, status: index === 0 ? 'ARRIVED' : 'DELIVERED', latitude: 37, longitude: 127, geocodeStatus: 'RESOLVED' } });
      await prisma.routePlanStop.create({ data: { shopId: shop.id, routePlanId: route.id, deliveryStopId: stop.id, sequence: index + 1 } });
      stops.push(stop);
    }
    const stop = stops[0]!;
    const policy: CompletionPolicy = { version: suffix, maxAccuracyMeters: 20, enterRadiusMeters: 50, exitRadiusMeters: 100, dwellMs: 60_000, maxGapMs: 30_000, minDwellSamples: 3, ambiguityRadiusMeters: 200 };
    const env = { COMPLETION_ASSISTANCE_POLICY_JSON: JSON.stringify(policy), COMPLETION_ASSISTANCE_ACCOUNT_IDS: account.id, COMPLETION_ASSISTANCE_DETECTION_ENABLED: 'true', COMPLETION_ASSISTANCE_WORKER_ENABLED: options.worker === false ? 'false' : 'true', COMPLETION_ASSISTANCE_ACTIVATION_ID: suffix, COMPLETION_ASSISTANCE_ACTIVATED_AT: iso(-60_000) };
    let clock = base;
    const service = new PrismaCompletionAssistanceService(prisma, { env, now: () => new Date(clock) });
    const run = (await service.snapshot(account.id)).runs[0]!;
    expect(run).toBeDefined();
    const identity = { runId: run.runId, routePlanId: route.id, assignmentGeneration: run.assignmentGeneration, expectedRouteVersionId: version.id };
    const evidence = [0, 30_000, 60_000, 90_000, options.gap ? 150_000 : 120_000].map((time, index) => ({ latitude: index === 0 || index === 4 ? 37.002 : 37, longitude: 127, accuracyMeters: options.accuracy ?? 5, occurredAt: iso(time) }));
    for (const point of evidence) await prisma.driverEvent.create({ data: { shopId: shop.id, driverId: driver.id, routePlanId: route.id, routeVersionId: version.id, expectedRouteVersionId: version.id, assignmentGeneration: route.assignmentGeneration, eventType: 'LOCATION_UPDATED', occurredAt: new Date(point.occurredAt), createdAt: new Date(point.occurredAt), latitude: point.latitude, longitude: point.longitude, payload: { accuracyMeters: point.accuracyMeters } } });
    clock = Date.parse(evidence.at(-1)!.occurredAt) + 1000;
    const candidate: CompletionCandidate = { ...identity, candidateId: randomUUID(), deliveryStopId: stop.id, arrivalAt: iso(30_000), dwellCompletedAt: iso(90_000), exitAt: evidence.at(-1)!.occurredAt, evidence, policyVersion: policy.version, status: 'awaiting_response', revision: 0 };
    const register: CompletionCommand = { kind: 'candidate', commandId: randomUUID(), candidate, occurredAt: candidate.exitAt };
    const response = (value: 'completed' | 'failed' | 'not_completed', revision = 0, previous?: string): Extract<CompletionCommand, { kind: 'response' }> => ({ ...identity, kind: 'response', commandId: randomUUID(), candidateId: candidate.candidateId, deliveryStopId: stop.id, response: value, expectedRevision: revision, occurredAt: iso(130_000 + revision), ...(previous === undefined ? {} : { previousResponseCommandId: previous }) });
    const setTime = (value: number) => { clock = value; };
    const stopState = () => prisma.deliveryStop.findUniqueOrThrow({ where: { id: stop.id } });
    return { shop, account, driver, route, version, stop, service, env, identity, candidate, register, response, setTime, stopState };
  }

  test('exact 24h boundary, inference and consecutive offline corrections preserve real ARRIVED and immutable receipts', async () => {
    const f = await fixture();
    const orderBefore = await prisma.order.findUniqueOrThrow({ where: { id: f.stop.orderId } });
    const initial = await f.service.command(f.account.id, f.register);
    expect(initial.candidate).toMatchObject({ status: 'awaiting_response', revision: 0, responseDeadlineAt: iso(120_000 + day) });
    f.setTime(base + 120_000 + day - 1);
    expect(await f.service.processDue()).toBe(0);
    expect((await f.stopState()).status).toBe('ARRIVED');
    f.setTime(base + 120_000 + day);
    expect(await f.service.processDue()).toBe(1);
    expect(await f.service.processDue()).toBe(0);
    expect(await f.stopState()).toMatchObject({ status: 'DELIVERED', completionAssistanceCandidateId: f.candidate.candidateId, completionAssistanceRevision: 1 });
    const completed = f.response('completed');
    const firstAck = await f.service.command(f.account.id, completed);
    expect(firstAck.candidate).toMatchObject({ response: 'completed', responseAt: completed.occurredAt, revision: 2 });
    const failed = f.response('failed', 1, completed.commandId);
    expect((await f.service.command(f.account.id, failed)).candidate).toMatchObject({ response: 'failed', revision: 3 });
    expect((await f.stopState()).status).toBe('FAILED');
    expect(await f.service.command(f.account.id, completed)).toEqual({ ...firstAck, status: 'duplicate' });
    expect(await f.service.command(f.account.id, { ...completed, response: 'failed' })).toMatchObject({ status: 'rejected', reason: 'command_payload_mismatch' });
    expect(await f.service.command(f.account.id, f.response('completed', 2, completed.commandId))).toMatchObject({ status: 'rejected', reason: 'response_predecessor_conflict' });
    expect((await f.service.command(f.account.id, f.response('not_completed', 2, failed.commandId))).candidate).toMatchObject({ response: 'not_completed', revision: 4 });
    expect(await f.stopState()).toMatchObject({ status: 'ARRIVED', completionAssistanceCandidateId: null });
    expect(await prisma.driverCompletionOutcome.count({ where: { candidateId: f.candidate.candidateId } })).toBe(5);
    expect(await prisma.order.findUniqueOrThrow({ where: { id: f.stop.orderId } })).toEqual(orderBefore);
  });

  test.each(['STOP_FAILED', 'STOP_DELIVERED'] as const)('manual %s wins concurrent worker and blocks correction', async (eventType) => {
    const f = await fixture();
    await f.service.command(f.account.id, f.register);
    f.setTime(base + 120_000 + day);
    const repository = new PrismaDriverEventRepository(prisma);
    await Promise.all([f.service.processDue(), repository.recordDriverEvent({ shopId: f.shop.id, shopDomain: f.shop.shopDomain, driverId: f.driver.id, routePlanId: f.route.id, deliveryStopId: f.stop.id, clientEventId: randomUUID(), eventType, occurredAt: new Date(base + 120_000 + day), latitude: null, longitude: null, payload: eventType === 'STOP_FAILED' ? { failureReason: 'OTHER' } : {} })]);
    expect(await f.stopState()).toMatchObject({ status: eventType === 'STOP_FAILED' ? 'FAILED' : 'DELIVERED', completionAssistanceCandidateId: null });
    expect(await f.service.command(f.account.id, f.response('not_completed'))).toMatchObject({ status: 'rejected' });
    expect((await f.service.snapshot(f.account.id)).candidates[0]?.status).toBe('invalidated');
  });

  test('direct stop cancellation survives both due worker and explicit correction', async () => {
    const f = await fixture();
    await f.service.command(f.account.id, f.register);
    await prisma.deliveryStop.update({ where: { id: f.stop.id }, data: { status: 'CANCELLED' } });
    f.setTime(base + 120_000 + day);
    expect(await f.service.processDue()).toBe(0);
    expect(await f.service.command(f.account.id, f.response('completed'))).toMatchObject({ status: 'rejected' });
    expect(await f.service.command(f.account.id, f.response('not_completed'))).toMatchObject({ status: 'rejected' });
    expect(await f.stopState()).toMatchObject({ status: 'CANCELLED', completionAssistanceCandidateId: null });
  });

  test('predecessor receipts from another candidate or account cannot replace the current response', async () => {
    const f = await fixture();
    await f.service.command(f.account.id, f.register);
    const completed = f.response('completed');
    const firstAck = await f.service.command(f.account.id, completed);
    const other = await fixture();
    await other.service.command(other.account.id, other.register);
    const otherResponse = other.response('failed');
    await other.service.command(other.account.id, otherResponse);
    expect(await f.service.command(f.account.id, f.response('failed', 1, otherResponse.commandId))).toMatchObject({ status: 'rejected', reason: 'response_predecessor_conflict' });
    // A separate held candidate for the same account still cannot be a causal predecessor.
    const candidate = { ...f.candidate, candidateId: randomUUID(), exitAt: iso(121_000), evidence: [...f.candidate.evidence.slice(0, -1), { ...f.candidate.evidence.at(-1)!, occurredAt: iso(121_000) }] };
    await f.service.command(f.account.id, { kind: 'candidate', commandId: randomUUID(), candidate, occurredAt: candidate.exitAt });
    // The first candidate owns the stop, so a response to the other candidate is rejected and receipted.
    const differentCandidateResponse = { ...f.response('failed'), candidateId: candidate.candidateId };
    expect(await f.service.command(f.account.id, differentCandidateResponse)).toMatchObject({ status: 'rejected' });
    expect(await f.service.command(f.account.id, f.response('failed', 1, differentCandidateResponse.commandId))).toMatchObject({ status: 'rejected', reason: 'response_predecessor_conflict' });
    expect(await f.stopState()).toMatchObject({ status: 'DELIVERED', completionAssistanceCandidateId: f.candidate.candidateId });
    expect((await f.service.snapshot(f.account.id)).candidates.find((row) => row.candidateId === f.candidate.candidateId)).toEqual(firstAck.candidate);
  });

  test('admin confirmation of inferred DELIVERED takes ownership even when terminal status is unchanged', async () => {
    const f = await fixture();
    await f.service.command(f.account.id, f.register);
    f.setTime(base + 120_000 + day);
    expect(await f.service.processDue()).toBe(1);
    expect(await f.stopState()).toMatchObject({ status: 'DELIVERED', completionAssistanceCandidateId: f.candidate.candidateId });
    const idempotencyKey = randomUUID();
    const result = await new PrismaRoutePlanRepository(prisma).transitionAdminRouteStop({
      actor: 'completion-integration-admin', appId: 'clever', shopDomain: f.shop.shopDomain,
      routePlanId: f.route.id, deliveryStopId: f.stop.id,
      payload: { idempotencyKey, status: 'COMPLETED' }
    });
    expect(result).toMatchObject({ duplicate: false, status: { deliveryStopStatus: 'DELIVERED' } });
    expect(await prisma.adminRouteStopActionAudit.findUnique({ where: { idempotencyKey } })).not.toBeNull();
    expect(await f.stopState()).toMatchObject({ status: 'DELIVERED', completionAssistanceCandidateId: null, completionAssistanceRevision: null });
    expect(await f.service.command(f.account.id, f.response('not_completed', 1))).toMatchObject({ status: 'rejected' });
    expect((await f.stopState()).status).toBe('DELIVERED');
  });

  test('closed route and invalid policy preserve responses; return intent leaves closure and deadline intact', async () => {
    const f = await fixture();
    await f.service.command(f.account.id, f.register);
    await prisma.routePlan.update({ where: { id: f.route.id }, data: { status: 'COMPLETED' } });
    f.env.COMPLETION_ASSISTANCE_POLICY_JSON = '{}';
    const snapshot = await f.service.snapshot(f.account.id);
    expect(snapshot.runs[0]?.trackingEndedAt).toBeDefined();
    expect(await f.service.command(f.account.id, { ...f.identity, kind: 'return_intent', commandId: randomUUID(), occurredAt: iso(180_000) })).toMatchObject({ status: 'applied' });
    expect((await f.service.command(f.account.id, f.response('failed'))).candidate).toMatchObject({ response: 'failed', responseDeadlineAt: iso(120_000 + day) });
    expect((await prisma.routePlan.findUniqueOrThrow({ where: { id: f.route.id } })).status).toBe('COMPLETED');
  });

  test.each(['assignment', 'version', 'cancel'] as const)('%s changes invalidate immutable run ownership', async (change) => {
    const f = await fixture();
    await f.service.command(f.account.id, f.register);
    if (change === 'assignment') await prisma.routePlan.update({ where: { id: f.route.id }, data: { assignmentGeneration: { increment: 1 } } });
    if (change === 'cancel') await prisma.routePlan.update({ where: { id: f.route.id }, data: { status: 'CANCELLED' } });
    if (change === 'version') await prisma.routeGroupingChildVersion.update({ where: { id: f.version.id }, data: { status: 'ARCHIVED', supersededAt: new Date() } });
    expect(await f.service.command(f.account.id, f.response('completed'))).toMatchObject({ status: 'rejected' });
    expect((await f.stopState()).status).toBe('ARRIVED');
    const run = await prisma.driverCompletionRun.findUniqueOrThrow({ where: { id: f.identity.runId } });
    expect(run.assignmentGeneration.toString()).toBe(f.identity.assignmentGeneration);
    expect(run.expectedRouteVersionId).toBe(f.version.id);
  });

  test('foreign account cannot read or command original account candidate', async () => {
    const f = await fixture();
    await f.service.command(f.account.id, f.register);
    const other = randomUUID();
    expect((await f.service.snapshot(other)).candidates).toEqual([]);
    await expect(f.service.command(other, f.response('completed'))).rejects.toThrow('not accessible');
  });

  test.each([{ neighbor: true, reason: 'ambiguous_stop' }, { accuracy: 40, reason: 'accuracy_too_low' }, { gap: true, reason: 'sample_gap_exceeded' }])('holds uncertain evidence $reason', async (options) => {
    const f = await fixture(options);
    expect((await f.service.command(f.account.id, f.register)).candidate).toMatchObject({ status: 'held', holdReason: options.reason });
    f.setTime(base + day * 2);
    expect(await f.service.processDue()).toBe(0);
    expect((await f.stopState()).status).toBe('ARRIVED');
  });

  test('disabled-period and late candidates never become a backlog on activation', async () => {
    const disabled = await fixture({ worker: false });
    expect((await disabled.service.command(disabled.account.id, disabled.register)).candidate).toMatchObject({ status: 'held', holdReason: 'automation_not_eligible' });
    disabled.env.COMPLETION_ASSISTANCE_WORKER_ENABLED = 'true';
    disabled.setTime(base + day * 2);
    expect(await disabled.service.processDue()).toBe(0);
    const late = await fixture();
    late.setTime(base + day * 2);
    expect((await late.service.command(late.account.id, late.register)).candidate).toMatchObject({ status: 'held', holdReason: 'late_upload' });
    expect(await late.service.processDue()).toBe(0);
    expect((await disabled.stopState()).status).toBe('ARRIVED');
    expect((await late.stopState()).status).toBe('ARRIVED');
  });

  test.each(['IN_PROGRESS', 'COMPLETED', 'CANCELLED'] as const)('a copied stop assigned to another %s route invalidates retained old membership', async (status) => {
    const f = await fixture();
    await f.service.command(f.account.id, f.register);
    const other = await prisma.routePlan.create({ data: { shopId: f.shop.id, driverId: f.driver.id, name: 'Reassigned', planDate: new Date(base), constraints: {}, metrics: {}, optimizerVersion: 'integration', status: 'IN_PROGRESS' } });
    await prisma.routePlanStop.create({ data: { shopId: f.shop.id, routePlanId: other.id, deliveryStopId: f.stop.id, sequence: 1 } });
    await prisma.routeGroupingChildVersion.create({ data: { shopId: f.shop.id, groupingId: f.version.groupingId, groupingVersionId: f.version.groupingVersionId, routePlanId: other.id, driverId: f.driver.id, version: 2, snapshot: {} } });
    await prisma.routePlan.update({ where: { id: other.id }, data: { status } });
    if (status !== 'IN_PROGRESS') await prisma.routeGroupingChildVersion.updateMany({ where: { routePlanId: other.id }, data: { status: 'ARCHIVED', supersededAt: new Date() } });
    expect(await f.service.command(f.account.id, f.response('completed'))).toMatchObject({ status: 'rejected' });
    expect((await f.stopState()).status).toBe('ARRIVED');
  });

  test('ordinary GPS ingress receives server assignment and version identity without ordered-v2 fields', async () => {
    const f = await fixture();
    const event = await new PrismaDriverEventRepository(prisma).recordDriverEvent({ shopId: f.shop.id, shopDomain: f.shop.shopDomain, driverId: f.driver.id, routePlanId: f.route.id, deliveryStopId: null, clientEventId: randomUUID(), eventType: 'LOCATION_UPDATED', occurredAt: new Date(), latitude: '37', longitude: '127', payload: { accuracyMeters: 5 } });
    expect(await prisma.driverEvent.findUniqueOrThrow({ where: { id: event.eventId } })).toMatchObject({ assignmentGeneration: f.route.assignmentGeneration, expectedRouteVersionId: f.version.id, routeVersionId: f.version.id });
  });

  test('authenticated Fastify contract persists candidate and response, replays receipt, and denies expired account token', async () => {
    const f = await fixture();
    const now = new Date(base + 180_000);
    const secret = 'disposable-integration-test-secret';
    const token = signDriverAccountToken({ accountId: f.account.id, tokenVersion: f.account.tokenVersion, subject: `driver-account:${f.account.id}`, expiresInSeconds: 900 }, { secret, now }).token;
    const expired = signDriverAccountToken({ accountId: f.account.id, tokenVersion: f.account.tokenVersion, subject: `driver-account:${f.account.id}`, expiresInSeconds: 1 }, { secret, now: new Date(base) }).token;
    const app = Fastify();
    registerDriverCompletionAssistanceRoutes(app, { completionAssistanceService: f.service, driverTokenAccessRepository: new PrismaDriverTokenAccessRepository(prisma), jwtSecret: secret, now: () => now });
    const headers = { authorization: `Bearer ${token}` };
    const url = '/driver/completion-assistance';
    try {
      const get = await app.inject({ method: 'GET', url, headers });
      expect(get.statusCode).toBe(200);
      expect(get.headers['cache-control']).toBe('no-store');
      expect(get.json()).toMatchObject({ contractVersion: 1, runs: [{ runId: f.identity.runId }], candidates: [] });
      const candidate = await app.inject({ method: 'POST', url, headers, payload: { contractVersion: 1, command: f.register } });
      expect(candidate.statusCode).toBe(200);
      expect(candidate.json()).toMatchObject({ status: 'applied', candidate: { revision: 0 } });
      const command = f.response('failed');
      const applied = await app.inject({ method: 'POST', url, headers, payload: { contractVersion: 1, command } });
      expect(applied.statusCode).toBe(200);
      expect(applied.headers['cache-control']).toBe('no-store');
      expect(applied.json()).toMatchObject({ status: 'applied', candidate: { revision: 1, response: 'failed', responseAt: command.occurredAt } });
      expect((await f.stopState()).status).toBe('FAILED');
      const replay = await app.inject({ method: 'POST', url, headers, payload: { contractVersion: 1, command } });
      expect(replay.json()).toEqual({ ...applied.json(), status: 'duplicate' });
      const denied = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${expired}` } });
      expect(denied.statusCode).toBe(401);
      expect(denied.headers['cache-control']).toBe('no-store');
    } finally { await app.close(); }
  });

  test('buffered GPS from before run issuance cannot be validated by later assignment stamps', async () => {
    const f = await fixture();
    const evidence = f.candidate.evidence.map((point) => ({ ...point, occurredAt: new Date(Date.parse(point.occurredAt) - 300_000).toISOString() }));
    for (const point of evidence) await prisma.driverEvent.create({ data: { shopId: f.shop.id, driverId: f.driver.id, routePlanId: f.route.id, routeVersionId: f.version.id, expectedRouteVersionId: f.version.id, assignmentGeneration: f.route.assignmentGeneration, eventType: 'LOCATION_UPDATED', occurredAt: new Date(point.occurredAt), createdAt: new Date(base + 120_000), latitude: point.latitude, longitude: point.longitude, payload: { accuracyMeters: point.accuracyMeters } } });
    const candidate = { ...f.candidate, evidence, arrivalAt: iso(-270_000), dwellCompletedAt: iso(-210_000), exitAt: iso(-180_000) };
    const command: CompletionCommand = { kind: 'candidate', commandId: randomUUID(), candidate, occurredAt: candidate.exitAt };
    expect((await f.service.command(f.account.id, command)).candidate).toMatchObject({ status: 'held', holdReason: 'server_evidence_sequence_mismatch' });
    f.setTime(base + day * 2);
    expect(await f.service.processDue()).toBe(0);
    expect((await f.stopState()).status).toBe('ARRIVED');
  });

  test('invalid policy preserves explicit correction and immutable receipt, releasing ownership for a separate visit', async () => {
    const f = await fixture();
    await f.service.command(f.account.id, f.register);
    const savedPolicy = f.env.COMPLETION_ASSISTANCE_POLICY_JSON;
    f.env.COMPLETION_ASSISTANCE_POLICY_JSON = '{}';
    const completed = f.response('completed');
    const firstAck = await f.service.command(f.account.id, completed);
    expect(firstAck.candidate).toMatchObject({ status: 'responded', response: 'completed', revision: 1 });
    f.env.COMPLETION_ASSISTANCE_POLICY_JSON = '';
    expect((await f.service.command(f.account.id, f.response('not_completed', 1, completed.commandId))).candidate).toMatchObject({ response: 'not_completed', revision: 2 });
    expect(await f.stopState()).toMatchObject({ status: 'ARRIVED', completionAssistanceCandidateId: null, completionAssistanceRevision: null });
    expect(await f.service.command(f.account.id, completed)).toEqual({ ...firstAck, status: 'duplicate' });
    f.env.COMPLETION_ASSISTANCE_POLICY_JSON = savedPolicy;
    const evidence = f.candidate.evidence.map((point) => ({ ...point, occurredAt: new Date(Date.parse(point.occurredAt) + 300_000).toISOString() }));
    for (const point of evidence) await prisma.driverEvent.create({ data: { shopId: f.shop.id, driverId: f.driver.id, routePlanId: f.route.id, routeVersionId: f.version.id, expectedRouteVersionId: f.version.id, assignmentGeneration: f.route.assignmentGeneration, eventType: 'LOCATION_UPDATED', occurredAt: new Date(point.occurredAt), createdAt: new Date(point.occurredAt), latitude: point.latitude, longitude: point.longitude, payload: { accuracyMeters: point.accuracyMeters } } });
    f.setTime(base + 421_000);
    const candidate = { ...f.candidate, candidateId: randomUUID(), evidence, arrivalAt: iso(330_000), dwellCompletedAt: iso(390_000), exitAt: iso(420_000) };
    const command: CompletionCommand = { kind: 'candidate', commandId: randomUUID(), candidate, occurredAt: candidate.exitAt };
    expect((await f.service.command(f.account.id, command)).candidate).toMatchObject({ status: 'awaiting_response', revision: 0 });
    const nextResponse = { ...f.response('completed'), candidateId: candidate.candidateId, occurredAt: iso(421_000) };
    expect((await f.service.command(f.account.id, nextResponse)).candidate).toMatchObject({ response: 'completed', revision: 1 });
    expect(await f.stopState()).toMatchObject({ status: 'DELIVERED', completionAssistanceCandidateId: candidate.candidateId });
  });

  test('outbox insertion failure rolls candidate, stop, event, outcome and receipt back together', async () => {
    const f = await fixture();
    await f.service.command(f.account.id, f.register);
    const before = await prisma.driverCompletionCandidate.findUniqueOrThrow({ where: { id: f.candidate.candidateId } });
    const command = f.response('completed');
    const failing = prisma.$extends({ query: { customerRouteNotificationFact: { create() { return Promise.reject(new Error('injected outbox failure')); } } } });
    const service = new PrismaCompletionAssistanceService(failing as unknown as PrismaClient, { env: f.env, now: () => new Date(base + 150_000) });
    await expect(service.command(f.account.id, command)).rejects.toThrow('injected outbox failure');
    expect(await prisma.driverCompletionCandidate.findUniqueOrThrow({ where: { id: f.candidate.candidateId } })).toEqual(before);
    expect((await f.stopState()).status).toBe('ARRIVED');
    expect(await prisma.driverCompletionReceipt.count({ where: { accountId: f.account.id, commandId: command.commandId } })).toBe(0);
    expect(await prisma.driverCompletionOutcome.count({ where: { candidateId: f.candidate.candidateId } })).toBe(1);
    expect(await prisma.driverEvent.count({ where: { routePlanId: f.route.id, eventType: 'STOP_DELIVERED' } })).toBe(0);
    expect((await f.service.command(f.account.id, command)).status).toBe('applied');
  });
});
