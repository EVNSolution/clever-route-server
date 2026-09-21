import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Prisma, type PrismaClient, type DriverCompletionRun, type DriverCompletionCandidate, type DeliveryStop } from '@prisma/client';
import { parseCompletionPolicy, type CompletionPolicy, type CompletionRun, type CompletionCandidate, type CompletionCommand, type CompletionSample, type CompletionAcknowledgement } from './completion-assistance.contract.js';
import { validateVisitEvidence } from './completion-assistance.evidence.js';

const DAY_MS = 86_400_000;
const NONTERMINAL = new Set(['PENDING', 'ASSIGNED', 'EN_ROUTE', 'ARRIVED']);
type Tx = Prisma.TransactionClient;
type Env = Partial<Record<string, string>>;
type Identity = Pick<CompletionRun, 'runId' | 'routePlanId' | 'assignmentGeneration' | 'expectedRouteVersionId'>;

export class CompletionAssistanceScopeError extends Error {
  constructor() { super('Completion assistance identity is not accessible'); }
}

// Invalid settings stop new detection/inference, never access to durable commands.
export function completionAssistanceSettings(env: Env) {
  let policy: CompletionPolicy | null = null;
  try { policy = parseCompletionPolicy(JSON.parse(env.COMPLETION_ASSISTANCE_POLICY_JSON ?? 'null')); } catch { /* disabled */ }
  const accounts = new Set((env.COMPLETION_ASSISTANCE_ACCOUNT_IDS ?? '').split(',').map((id) => id.trim()).filter(Boolean));
  const activationId = env.COMPLETION_ASSISTANCE_ACTIVATION_ID?.trim() || null;
  const activatedAt = new Date(env.COMPLETION_ASSISTANCE_ACTIVATED_AT ?? '');
  const detectionEnabled = env.COMPLETION_ASSISTANCE_DETECTION_ENABLED === 'true' && policy !== null && accounts.size > 0;
  const workerEnabled = detectionEnabled && env.COMPLETION_ASSISTANCE_WORKER_ENABLED === 'true'
    && activationId !== null && Number.isFinite(activatedAt.getTime());
  return { policy, accounts, activationId, activatedAt, detectionEnabled, workerEnabled };
}

export class PrismaCompletionAssistanceService {
  private readonly now: () => Date;
  private readonly env: Env;
  constructor(private readonly prisma: PrismaClient, options: { env: Env; now?: () => Date }) {
    this.now = options.now ?? (() => new Date());
    this.env = options.env;
  }

  async snapshot(accountId: string): Promise<{ contractVersion: 1; serverTime: string; runs: CompletionRun[]; candidates: CompletionCandidate[] }> {
    const now = this.now();
    const settings = completionAssistanceSettings(this.env);
    if (settings.detectionEnabled && settings.accounts.has(accountId)) {
      const routes = await this.prisma.routePlan.findMany({
        where: { driver: { accountId, status: 'ACTIVE' }, shop: { appId: 'clever', shopDomain: { endsWith: '.myshopify.com' } }, status: { in: ['IN_PROGRESS', 'READY', 'ASSIGNED', 'PUBLISHED'] } },
        select: { id: true }, orderBy: { id: 'asc' }
      });
      for (const route of routes) await this.issueRun(accountId, route.id, settings, now);
    }
    const records = await this.prisma.driverCompletionRun.findMany({ where: { accountId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    const runs: CompletionRun[] = [];
    const candidates: CompletionCandidate[] = [];
    for (const record of records) {
      const state = await this.prisma.$transaction(async (tx) => {
        await lockRoute(tx, record);
        await lockStops(tx, record);
        const run = await this.reconcileRun(tx, record, now);
        const stops = await currentStops(tx, run);
        const rows = await tx.driverCompletionCandidate.findMany({ where: { runId: run.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
        // null is deliberately an invalid detection policy, accepted as run context by app v1.
        const versions = run.policyVersions as string[];
        const lastPolicy = versions.at(-1);
        const stored = lastPolicy === undefined ? null : await tx.driverCompletionPolicy.findUnique({ where: { version: lastPolicy } });
        const validSettings = settings.detectionEnabled && settings.accounts.has(accountId) && run.invalidatedAt === null;
        const policy = validSettings && stored !== null && settings.policy?.version === stored.version
          && isDeepStrictEqual(stored.policy, settings.policy) ? stored.policy as CompletionPolicy : null;
        return {
          run: { runId: run.id, routePlanId: run.routePlanId, assignmentGeneration: run.assignmentGeneration.toString(), expectedRouteVersionId: run.expectedRouteVersionId,
            routeName: run.routeName, policy: policy as CompletionPolicy, stops,
            ...(run.trackingEndedAt === null ? {} : { trackingEndedAt: run.trackingEndedAt.toISOString() }) },
          candidates: rows.map(projection)
        };
      });
      runs.push(state.run);
      candidates.push(...state.candidates);
    }
    return { contractVersion: 1, serverTime: now.toISOString(), runs, candidates };
  }

  async command(accountId: string, command: CompletionCommand): Promise<CompletionAcknowledgement> {
    const identity = command.kind === 'candidate' ? command.candidate : command;
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(identity.runId)) throw new CompletionAssistanceScopeError();
    return this.prisma.$transaction(async (tx) => {
      // Receipt lock covers commands across routes; never serialize unrelated accounts.
      await tx.$queryRaw`SELECT TRUE AS locked FROM pg_advisory_xact_lock(295001, hashtext(${accountId + ':' + command.commandId}))`;
      const storedRun = await tx.driverCompletionRun.findFirst({ where: { id: identity.runId, accountId } });
      if (storedRun === null || !sameIdentity(storedRun, identity)) throw new CompletionAssistanceScopeError();
      const receipt = await tx.driverCompletionReceipt.findUnique({ where: { accountId_commandId: { accountId, commandId: command.commandId } } });
      if (receipt !== null) {
        if (!isDeepStrictEqual(receipt.request, json(command))) {
          const candidate = command.kind === 'response' ? await this.ownedCandidate(tx, storedRun, command.candidateId, command.deliveryStopId) : null;
          return ack(command, 'rejected', candidate, 'command_payload_mismatch');
        }
        const original = receipt.result as unknown as CompletionAcknowledgement;
        return { ...original, status: original.status === 'applied' ? 'duplicate' : original.status };
      }
      await lockRoute(tx, storedRun);
      await lockStops(tx, storedRun);
      const now = this.now();
      const run = await this.reconcileRun(tx, storedRun, now);
      let result: CompletionAcknowledgement;
      if (command.kind === 'candidate') result = await this.registerCandidate(tx, run, command, now);
      else if (command.kind === 'response') result = await this.respond(tx, run, command, now);
      else result = ack(command, run.invalidatedAt === null ? 'applied' : 'rejected', null, run.invalidatedAt === null ? undefined : 'run_invalidated');
      await tx.driverCompletionReceipt.create({ data: {
        accountId, commandId: command.commandId, runId: run.id,
        candidateId: result.candidate?.candidateId ?? null,
        kind: command.kind, request: json(command), result: json(result), createdAt: now
      } });
      return result;
    }, { timeout: 15_000 });
  }

  async processDue(): Promise<number> {
    const settings = completionAssistanceSettings(this.env);
    if (!settings.workerEnabled) return 0;
    const due = await this.prisma.driverCompletionCandidate.findMany({
      where: { status: 'awaiting_response', responseDeadlineAt: { lte: this.now() }, run: { accountId: { in: [...settings.accounts] } } },
      select: { id: true, runId: true }, orderBy: [{ responseDeadlineAt: 'asc' }, { id: 'asc' }], take: 100
    });
    let applied = 0;
    for (const item of due) {
      applied += await this.prisma.$transaction(async (tx) => {
        const storedRun = await tx.driverCompletionRun.findUniqueOrThrow({ where: { id: item.runId } });
        await lockRoute(tx, storedRun);
        await lockStops(tx, storedRun);
        const now = this.now();
        const run = await this.reconcileRun(tx, storedRun, now);
        const row = await tx.driverCompletionCandidate.findUniqueOrThrow({ where: { id: item.id } });
        if (row.status !== 'awaiting_response' || row.response !== null || row.responseDeadlineAt === null || row.responseDeadlineAt > now) return 0;
        const liveSettings = completionAssistanceSettings(this.env);
        if (!liveSettings.workerEnabled || !liveSettings.accounts.has(run.accountId)) return 0;
        if (row.automationActivationId !== liveSettings.activationId || run.activationId !== liveSettings.activationId
          || row.verifiedExitAt === null || row.verifiedExitAt < liveSettings.activatedAt) {
          await this.transition(tx, row, { ...projection(row), status: 'held', revision: row.revision + 1, holdReason: 'automation_not_eligible' }, 'POLICY_HOLD', now);
          return 0;
        }
        const stop = await tx.deliveryStop.findUniqueOrThrow({ where: { id: row.deliveryStopId } });
        if (!NONTERMINAL.has(stop.status) || stop.completionAssistanceCandidateId !== null && stop.completionAssistanceCandidateId !== row.id) {
          await this.invalidate(tx, row, 'stop_outcome_conflict', now);
          return 0;
        }
        // Revalidate immutable evidence under its original policy inside the same lock.
        const policy = await tx.driverCompletionPolicy.findUnique({ where: { version: row.policyVersion } });
        const parsed = parseCompletionPolicy(policy?.policy);
        const proof = parsed === null ? { holdReason: 'policy_unavailable' } : validateVisitEvidence(projection(row), parsed, run.stops as CompletionRun['stops'], await serverSamples(tx, run, projection(row), now), now);
        if (proof.verifiedExitAt?.getTime() !== row.verifiedExitAt.getTime()) {
          await this.transition(tx, row, { ...projection(row), status: 'held', revision: row.revision + 1, holdReason: proof.holdReason ?? 'evidence_changed' }, 'EVIDENCE_HOLD', now);
          return 0;
        }
        await this.applyOutcome(tx, run, row, stop, { ...projection(row), status: 'inferred_completed', revision: row.revision + 1, autoCompletedAt: now.toISOString() }, 'LOCATION_INFERENCE', now);
        return 1;
      }, { timeout: 15_000 });
    }
    return applied;
  }

  private async issueRun(accountId: string, routePlanId: string, settings: ReturnType<typeof completionAssistanceSettings>, now: Date) {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM route_plans WHERE id = ${routePlanId}::uuid FOR UPDATE`;
      const route = await tx.routePlan.findFirst({ where: { id: routePlanId, driver: { accountId, status: 'ACTIVE' } }, include: {
        routeStops: { include: { deliveryStop: true }, orderBy: { sequence: 'asc' } },
        routeGroupingChildVersions: { where: { status: 'CURRENT', supersededAt: null }, take: 2 }
      } });
      if (route === null || route.driverId === null || !['IN_PROGRESS', 'READY', 'ASSIGNED', 'PUBLISHED'].includes(route.status)) return;
      const version = route.routeGroupingChildVersions.length === 1 ? route.routeGroupingChildVersions[0] : undefined;
      if (version === undefined || version.driverId !== route.driverId || settings.policy === null) return;
      // Global version is immutable: reusing a version for changed thresholds disables detection.
      await tx.driverCompletionPolicy.createMany({ data: { version: settings.policy.version, policy: json(settings.policy), createdAt: now }, skipDuplicates: true });
      const existingPolicy = await tx.driverCompletionPolicy.findUniqueOrThrow({ where: { version: settings.policy.version } });
      if (!isDeepStrictEqual(existingPolicy.policy, settings.policy)) return;
      const identity = { routePlanId, assignmentGeneration: route.assignmentGeneration, expectedRouteVersionId: version.id };
      const existing = await tx.driverCompletionRun.findUnique({ where: { routePlanId_assignmentGeneration_expectedRouteVersionId: identity } });
      if (existing !== null) {
        if (existing.accountId !== accountId || existing.driverId !== route.driverId) return;
        const versions = existing.policyVersions as string[];
        if (versions.at(-1) !== settings.policy.version) await tx.driverCompletionRun.update({ where: { id: existing.id }, data: { policyVersions: [...versions, settings.policy.version] } });
        return;
      }
      const ended = await tx.driverEvent.findFirst({ where: { routePlanId, assignmentGeneration: route.assignmentGeneration, eventType: 'ROUTE_COMPLETED' }, select: { id: true } });
      if (ended !== null) return;
      await tx.driverCompletionRun.create({ data: {
        id: randomUUID(), ...identity, accountId, shopId: route.shopId, driverId: route.driverId, routeName: route.name,
        stops: json(route.routeStops.map(({ deliveryStop: stop }) => ({ deliveryStopId: stop.id, status: stop.status,
          coordinates: stop.geocodeStatus === 'RESOLVED' && stop.latitude !== null && stop.longitude !== null ? { latitude: Number(stop.latitude), longitude: Number(stop.longitude) } : null }))),
        policyVersions: [settings.policy.version], activationId: settings.workerEnabled && now >= settings.activatedAt ? settings.activationId : null, createdAt: now
      } });
    });
  }

  private async reconcileRun(tx: Tx, original: DriverCompletionRun, now: Date): Promise<DriverCompletionRun> {
    let run = await tx.driverCompletionRun.findUniqueOrThrow({ where: { id: original.id } });
    const route = await tx.routePlan.findUnique({ where: { id: run.routePlanId }, include: {
      driver: { select: { accountId: true } }, routeGroupingChildVersions: { where: { status: 'CURRENT', supersededAt: null }, select: { id: true, createdAt: true } },
      routeStops: { select: { deliveryStopId: true } }
    } });
    const ids = (run.stops as CompletionRun['stops']).map((stop) => stop.deliveryStopId).sort();
    const originalVersion = await tx.routeGroupingChildVersion.findUnique({ where: { id: run.expectedRouteVersionId }, select: { createdAt: true } });
    // Copied stops can retain old membership. That alone cannot authorize
    // changing a shared stop now assigned through another current route.
    const overlappingAssignment = await tx.routePlanStop.findFirst({ where: {
      deliveryStopId: { in: ids }, routePlanId: { not: run.routePlanId },
      routePlan: { shopId: run.shopId, OR: [
        { driverId: { not: null }, status: { in: ['IN_PROGRESS', 'READY', 'ASSIGNED', 'PUBLISHED'] },
          routeGroupingChildVersions: { some: { status: 'CURRENT', supersededAt: null } } },
        // A later assignment remains an ownership conflict after completion,
        // cancellation, or version archival; those events cannot revive this run.
        { routeGroupingChildVersions: { some: { driverId: { not: null }, createdAt: { gte: originalVersion?.createdAt ?? run.createdAt } } } }
      ] }
    }, select: { id: true } });
    const invalid = overlappingAssignment !== null || route === null || route.status === 'CANCELLED' || route.shopId !== run.shopId || route.driverId !== run.driverId
      || route.driver?.accountId !== run.accountId || route.assignmentGeneration !== run.assignmentGeneration
      || route.routeGroupingChildVersions.length !== 1 || route.routeGroupingChildVersions[0]?.id !== run.expectedRouteVersionId
      || !isDeepStrictEqual(ids, route.routeStops.map((stop) => stop.deliveryStopId).sort());
    if (invalid || run.invalidatedAt !== null) {
      if (run.invalidatedAt === null) run = await tx.driverCompletionRun.update({ where: { id: run.id }, data: { invalidatedAt: now, trackingEndedAt: run.trackingEndedAt ?? now } });
      const candidates = await tx.driverCompletionCandidate.findMany({ where: { runId: run.id, status: { not: 'invalidated' } } });
      for (const candidate of candidates) await this.invalidate(tx, candidate, 'run_invalidated', now);
    } else if (run.trackingEndedAt === null) {
      const end = await tx.driverEvent.findFirst({ where: { routePlanId: run.routePlanId, driverId: run.driverId, eventType: 'ROUTE_COMPLETED',
        OR: [{ assignmentGeneration: run.assignmentGeneration }, { assignmentGeneration: null, createdAt: { gte: run.createdAt } }] }, orderBy: { occurredAt: 'asc' } });
      if (route.status === 'COMPLETED' || end !== null) run = await tx.driverCompletionRun.update({ where: { id: run.id }, data: { trackingEndedAt: end?.occurredAt ?? now } });
    }
    return run;
  }

  private async registerCandidate(tx: Tx, run: DriverCompletionRun, command: Extract<CompletionCommand, { kind: 'candidate' }>, now: Date): Promise<CompletionAcknowledgement> {
    const candidate = command.candidate;
    if (!(run.stops as CompletionRun['stops']).some((stop) => stop.deliveryStopId === candidate.deliveryStopId)) throw new CompletionAssistanceScopeError();
    const exists = await tx.driverCompletionCandidate.findUnique({ where: { id: candidate.candidateId } });
    if (exists !== null) {
      if (exists.runId !== run.id || exists.deliveryStopId !== candidate.deliveryStopId) throw new CompletionAssistanceScopeError();
      return ack(command, 'rejected', exists, 'candidate_already_registered');
    }
    const visit = await tx.driverCompletionCandidate.findFirst({ where: { runId: run.id, deliveryStopId: candidate.deliveryStopId, proposedExitAt: new Date(candidate.exitAt) } });
    if (visit !== null) return ack(command, 'rejected', null, 'visit_already_registered');
    const policyRow = (run.policyVersions as string[]).includes(candidate.policyVersion) ? await tx.driverCompletionPolicy.findUnique({ where: { version: candidate.policyVersion } }) : null;
    if (policyRow === null) return ack(command, 'rejected', null, 'policy_version_unknown');
    const policy = parseCompletionPolicy(policyRow?.policy);
    const proof = policy === null ? { holdReason: 'policy_unavailable' } : validateVisitEvidence(candidate, policy, run.stops as CompletionRun['stops'], await serverSamples(tx, run, candidate, now), now);
    const verifiedExitAt = proof.verifiedExitAt ?? null;
    const deadline = verifiedExitAt === null ? null : new Date(verifiedExitAt.getTime() + DAY_MS);
    const stop = await tx.deliveryStop.findUniqueOrThrow({ where: { id: candidate.deliveryStopId } });
    const settings = completionAssistanceSettings(this.env);
    const eligible = settings.workerEnabled && settings.accounts.has(run.accountId) && run.activationId === settings.activationId
      && verifiedExitAt !== null && verifiedExitAt >= settings.activatedAt;
    const reason = run.invalidatedAt !== null ? 'run_invalidated'
      : !NONTERMINAL.has(stop.status) ? 'stop_outcome_conflict'
      : proof.holdReason ?? (deadline !== null && deadline <= now ? 'late_upload' : !eligible ? 'automation_not_eligible' : undefined);
    const value: CompletionCandidate = {
      candidateId: candidate.candidateId, runId: run.id, routePlanId: run.routePlanId, assignmentGeneration: run.assignmentGeneration.toString(), expectedRouteVersionId: run.expectedRouteVersionId,
      deliveryStopId: candidate.deliveryStopId, arrivalAt: candidate.arrivalAt, dwellCompletedAt: candidate.dwellCompletedAt,
      exitAt: verifiedExitAt?.toISOString() ?? candidate.exitAt, evidence: candidate.evidence, policyVersion: candidate.policyVersion,
      status: reason === 'run_invalidated' || reason === 'stop_outcome_conflict' ? 'invalidated' : reason === undefined ? 'awaiting_response' : 'held', revision: 0,
      ...(deadline === null ? {} : { responseDeadlineAt: deadline.toISOString() }), ...(reason === undefined ? {} : { holdReason: reason })
    };
    const row = await tx.driverCompletionCandidate.create({ data: {
      id: candidate.candidateId, runId: run.id, deliveryStopId: candidate.deliveryStopId, originalCommand: json(command), projection: json(value),
      proposedExitAt: new Date(candidate.exitAt), verifiedExitAt, responseDeadlineAt: deadline, verifiedAt: verifiedExitAt === null ? null : now,
      policyVersion: candidate.policyVersion, status: value.status, revision: 0, automationActivationId: eligible && reason === undefined ? settings.activationId : null, createdAt: now
    } });
    await tx.driverCompletionOutcome.create({ data: { candidateId: row.id, revision: 0, source: 'CANDIDATE_VALIDATED', commandId: command.commandId, previousProjection: {}, projection: json(value), createdAt: now } });
    return ack(command, 'applied', row);
  }

  private async ownedCandidate(tx: Tx, run: DriverCompletionRun, candidateId: string, deliveryStopId: string) {
    if (!(run.stops as CompletionRun['stops']).some((stop) => stop.deliveryStopId === deliveryStopId)) throw new CompletionAssistanceScopeError();
    const candidate = await tx.driverCompletionCandidate.findFirst({ where: { id: candidateId, runId: run.id, deliveryStopId } });
    if (candidate === null) throw new CompletionAssistanceScopeError();
    return candidate;
  }

  private async respond(tx: Tx, run: DriverCompletionRun, command: Extract<CompletionCommand, { kind: 'response' }>, now: Date) {
    const row = await this.ownedCandidate(tx, run, command.candidateId, command.deliveryStopId);
    if (run.invalidatedAt !== null || row.status === 'invalidated') return ack(command, 'rejected', row, 'candidate_invalidated');
    const stop = await tx.deliveryStop.findUniqueOrThrow({ where: { id: row.deliveryStopId } });
    const ownOutcome = stop.completionAssistanceCandidateId === row.id && stop.completionAssistanceRevision === row.revision;
    if ((!NONTERMINAL.has(stop.status) || stop.completionAssistanceCandidateId !== null) && !ownOutcome) return ack(command, 'rejected', row, 'stop_outcome_conflict');
    if (command.previousResponseCommandId !== undefined) {
      const predecessor = await tx.driverCompletionReceipt.findUnique({ where: { accountId_commandId: { accountId: run.accountId, commandId: command.previousResponseCommandId } } });
      const result = predecessor?.result as unknown as CompletionAcknowledgement | undefined;
      if (predecessor?.kind !== 'response' || predecessor.runId !== run.id || predecessor.candidateId !== row.id
        || result?.status !== 'applied' || row.lastResponseCommandId !== command.previousResponseCommandId || result.candidate?.revision !== row.revision)
        return ack(command, 'rejected', row, 'response_predecessor_conflict');
    } else {
      const inferenceOnlyDrift = (row.status === 'inferred_completed' || row.status === 'held')
        && row.lastResponseCommandId === null && command.expectedRevision <= row.revision;
      if (command.expectedRevision !== row.revision && !inferenceOnlyDrift) return ack(command, 'rejected', row, 'revision_conflict');
    }
    if (command.expectedRevision > row.revision) return ack(command, 'rejected', row, 'revision_conflict');
    if (command.response === 'not_completed' && !NONTERMINAL.has(stop.status)
      && (row.statusBeforeCandidateOutcome === null || !NONTERMINAL.has(row.statusBeforeCandidateOutcome))) return ack(command, 'rejected', row, 'restore_state_unavailable');
    const next: CompletionCandidate = { ...projection(row), status: 'responded', response: command.response, responseAt: command.occurredAt, revision: row.revision + 1 };
    delete next.holdReason;
    const updated = await this.applyOutcome(tx, run, row, stop, next, 'DRIVER_EXPLICIT', now, command);
    return ack(command, 'applied', updated);
  }

  private async applyOutcome(tx: Tx, run: DriverCompletionRun, row: DriverCompletionCandidate, stop: DeliveryStop, next: CompletionCandidate,
    source: 'LOCATION_INFERENCE' | 'DRIVER_EXPLICIT', now: Date, command?: Extract<CompletionCommand, { kind: 'response' }>) {
    const target = next.status === 'inferred_completed' || next.response === 'completed' ? 'DELIVERED'
      : next.response === 'failed' ? 'FAILED' : NONTERMINAL.has(stop.status) ? stop.status : row.statusBeforeCandidateOutcome as DeliveryStop['status'];
    const before = row.statusBeforeCandidateOutcome ?? (NONTERMINAL.has(stop.status) && !NONTERMINAL.has(target) ? stop.status : null);
    const updated = await this.transition(tx, row, next, source, now, { commandId: command?.commandId, previousStatus: stop.status, nextStatus: target,
      data: { statusBeforeCandidateOutcome: before, ...(command === undefined ? {} : { lastResponseCommandId: command.commandId }) } });
    await tx.deliveryStop.update({ where: { id: stop.id }, data: { status: target,
      completionAssistanceCandidateId: NONTERMINAL.has(target) ? null : row.id,
      completionAssistanceRevision: NONTERMINAL.has(target) ? null : next.revision } });
    // Unique append-only operational event and outbox fact share the receipt transaction.
    const eventId = randomUUID();
    await tx.driverEvent.create({ data: {
      id: eventId, shopId: run.shopId, driverId: run.driverId, routePlanId: run.routePlanId, routeVersionId: run.expectedRouteVersionId,
      expectedRouteVersionId: run.expectedRouteVersionId, assignmentGeneration: run.assignmentGeneration, deliveryStopId: stop.id,
      clientEventId: `completion-assistance:${row.id}:${next.revision}`, driverContractVersion: 2,
      eventType: target === 'DELIVERED' ? 'STOP_DELIVERED' : target === 'FAILED' ? 'STOP_FAILED' : 'NOTE_ADDED',
      occurredAt: command === undefined ? now : new Date(command.occurredAt),
      payload: { source, completionCandidateId: row.id, revision: next.revision, arrivalAt: next.arrivalAt, exitAt: next.exitAt,
        processedAt: now.toISOString(), ...(target === 'FAILED' ? { failureReason: 'OTHER' } : {}), previousStatus: stop.status, nextStatus: target }
    } });
    await tx.customerRouteNotificationFact.create({ data: {
      shopId: run.shopId, routePlanId: run.routePlanId, deliveryStopId: stop.id, orderId: stop.orderId,
      idempotencyKey: `completion-assistance:${row.id}:${next.revision}`, source: 'COMPLETION_ASSISTANCE',
      requestedUiStatus: NONTERMINAL.has(target) ? 'IN_PROGRESS' : 'COMPLETED', occurredAt: now, status: 'SKIPPED',
      errorCode: 'COMPLETION_ASSISTANCE_NOTIFICATIONS_DISABLED',
      metadata: { driverEventId: eventId, candidateId: row.id, revision: next.revision, source, previousStatus: stop.status, nextStatus: target }
    } });
    return updated;
  }

  private async transition(tx: Tx, row: DriverCompletionCandidate, next: CompletionCandidate, source: string, now: Date,
    extra: { commandId?: string | undefined; previousStatus?: string; nextStatus?: string; data?: Prisma.DriverCompletionCandidateUpdateInput } = {}) {
    const updated = await tx.driverCompletionCandidate.update({ where: { id: row.id }, data: {
      ...extra.data, status: next.status, revision: next.revision, projection: json(next), response: next.response ?? null,
      responseAt: next.responseAt === undefined ? null : new Date(next.responseAt), autoCompletedAt: next.autoCompletedAt === undefined ? null : new Date(next.autoCompletedAt)
    } });
    await tx.driverCompletionOutcome.create({ data: { candidateId: row.id, revision: next.revision, source,
      commandId: extra.commandId ?? null, previousStatus: extra.previousStatus ?? null, nextStatus: extra.nextStatus ?? null,
      previousProjection: row.projection as Prisma.InputJsonValue, projection: json(next), createdAt: now } });
    return updated;
  }

  private async invalidate(tx: Tx, row: DriverCompletionCandidate, reason: string, now: Date) {
    return this.transition(tx, row, { ...projection(row), status: 'invalidated', revision: row.revision + 1, holdReason: reason }, 'INVALIDATED', now);
  }
}

function json(value: unknown): Prisma.InputJsonValue { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue; }
function projection(row: DriverCompletionCandidate): CompletionCandidate { return row.projection as unknown as CompletionCandidate; }
function sameIdentity(run: DriverCompletionRun, input: Identity) {
  return input.runId === run.id && input.routePlanId === run.routePlanId && input.assignmentGeneration === run.assignmentGeneration.toString() && input.expectedRouteVersionId === run.expectedRouteVersionId;
}
function ack(command: CompletionCommand, status: CompletionAcknowledgement['status'], candidate: DriverCompletionCandidate | null, reason?: string): CompletionAcknowledgement {
  return { contractVersion: 1, commandId: command.commandId, status, ...(candidate === null ? {} : { candidate: projection(candidate) }), ...(reason === undefined ? {} : { reason }) };
}
async function lockRoute(tx: Tx, run: DriverCompletionRun) {
  await tx.$queryRaw`SELECT id FROM route_plans WHERE id = ${run.routePlanId}::uuid AND "shopId" = ${run.shopId}::uuid FOR UPDATE`;
}
async function lockStops(tx: Tx, run: DriverCompletionRun) {
  const ids = (run.stops as CompletionRun['stops']).map((stop) => stop.deliveryStopId).sort();
  if (ids.length > 0) await tx.$queryRaw(Prisma.sql`SELECT id FROM delivery_stops WHERE id::text IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`);
}
async function currentStops(tx: Tx, run: DriverCompletionRun): Promise<CompletionRun['stops']> {
  const snapshots = run.stops as CompletionRun['stops'];
  const current = await tx.deliveryStop.findMany({ where: { shopId: run.shopId, id: { in: snapshots.map((stop) => stop.deliveryStopId) } }, select: { id: true, status: true } });
  const statusById = new Map(current.map((stop) => [stop.id, stop.status]));
  return snapshots.map((stop) => ({ ...stop, status: statusById.get(stop.deliveryStopId) ?? 'CANCELLED' }));
}
async function serverSamples(tx: Tx, run: DriverCompletionRun, candidate: CompletionCandidate, now: Date): Promise<CompletionSample[]> {
  const first = candidate.evidence[0]?.occurredAt ?? candidate.arrivalAt;
  const events = await tx.driverEvent.findMany({ where: {
    shopId: run.shopId, driverId: run.driverId, routePlanId: run.routePlanId, expectedRouteVersionId: run.expectedRouteVersionId,
    assignmentGeneration: run.assignmentGeneration, eventType: 'LOCATION_UPDATED',
    // Legacy GPS can arrive late without a client assignment identity. Never
    // retroactively attach samples from before this immutable run was issued.
    occurredAt: { gte: new Date(Math.max(Date.parse(first), run.createdAt.getTime())), lte: new Date(candidate.exitAt) }, createdAt: { lte: now }
  }, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }], take: 1000 });
  return events.map((event) => {
    const payload = event.payload as Record<string, unknown> | null;
    const nested = payload?.location as Record<string, unknown> | null | undefined;
    const accuracy = payload?.accuracyMeters ?? payload?.accuracy ?? nested?.accuracyMeters;
    // No clock correction: even corroborated samples with impossible server receipt time are held.
    const usable = event.latitude !== null && event.longitude !== null && typeof accuracy === 'number' && Number.isFinite(accuracy)
      && event.occurredAt <= event.createdAt;
    // Keep unusable intervening observations in the sequence: dropping them
    // could manufacture continuous high-quality dwell from a broken GPS trace.
    return { latitude: event.latitude === null ? Number.NaN : Number(event.latitude), longitude: event.longitude === null ? Number.NaN : Number(event.longitude),
      accuracyMeters: usable ? accuracy : Number.POSITIVE_INFINITY, occurredAt: event.occurredAt.toISOString() };
  });
}
