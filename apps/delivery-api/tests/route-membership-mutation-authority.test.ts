import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';
import ts from 'typescript';

const sourceRoot = join(process.cwd(), 'src');
const authorizedMembershipWriters = [
  'modules/driver/rolling-eta-backfill.ts',
  'modules/dsv/dsv-assignment-command.service.ts',
  'modules/dsv/dsv-dispatch-import.service.ts',
  'modules/route-grouping/route-grouping.service.ts',
  'modules/route-plans/route-plan.repository.ts'
];

const reviewedMutationInventory = [
  'modules/driver/driver-event.repository.ts:routePlanStop.update:2',
  'modules/driver/rolling-eta-backfill.ts:routePlanStop.updateMany:1',
  'modules/dsv/dsv-assignment-command.service.ts:routePlanStop.updateMany:1',
  'modules/dsv/dsv-dispatch-import.service.ts:routePlanStop.updateMany:1',
  'modules/route-grouping/route-grouping.service.ts:routeGroupingChildVersion.create:7',
  'modules/route-grouping/route-grouping.service.ts:routeGroupingChildVersion.update:4',
  'modules/route-grouping/route-grouping.service.ts:routeGroupingChildVersion.updateMany:2',
  'modules/route-grouping/route-grouping.service.ts:routePlanStop.create:1',
  'modules/route-grouping/route-grouping.service.ts:routePlanStop.createMany:4',
  'modules/route-grouping/route-grouping.service.ts:routePlanStop.deleteMany:4',
  'modules/route-grouping/route-grouping.service.ts:routePlanStop.updateMany:2',
  'modules/route-plans/route-plan.repository.ts:routeGroupingChildVersion.updateMany:3',
  'modules/route-plans/route-plan.repository.ts:routePlanStop.createMany:4',
  'modules/route-plans/route-plan.repository.ts:routePlanStop.deleteMany:4',
  'modules/route-plans/route-plan.repository.ts:routePlanStop.updateMany:2'
];

const reviewedAssignmentPointerInventory = [
  'modules/dsv/dsv-assignment-command.service.ts:order.updateMany:3',
  'modules/dsv/dsv-dispatch-import.service.ts:order.updateMany:1',
  'modules/route-grouping/route-grouping.service.ts:order.updateMany:1'
];

describe('route membership mutation authority', () => {
  test('requires review of every repository-wide membership writer', () => {
    const writers = typescriptFiles(sourceRoot)
      .filter((file) => {
        const source = readFileSync(file, 'utf8');
        return /routePlanStop\.(?:create|createMany|deleteMany|updateMany)\(/u.test(source)
          || /data:\s*\{\s*currentRouteVersionId:/u.test(source);
      })
      .map((file) => relative(sourceRoot, file))
      .sort();

    expect(writers).toEqual(authorizedMembershipWriters);
  });

  test('inventories every stop and child-version mutation operation, not only writer filenames', () => {
    const inventory = mutationInventory(['routeGroupingChildVersion', 'routePlanStop']);

    expect(inventory).toEqual(reviewedMutationInventory);
  });

  test('inventories assignment pointer writes by operation and data payload', () => {
    expect(mutationInventory(['order'], true)).toEqual(reviewedAssignmentPointerInventory);
  });

  test('inventories raw SQL mutations and prohibits model writer aliases', () => {
    const rawMutations = typescriptFiles(sourceRoot).flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      const calls = [...source.matchAll(/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?(route_plan_stops|route_grouping_child_versions)"?/giu)]
        .map((match) => `${relative(sourceRoot, file)}:${match[1]!.toUpperCase().replace(/\s+/gu, '_')}:${match[2]}`);
      expect(source).not.toMatch(/(?:const|let|var)\s+\w+\s*=\s*\w+\.(?:routePlanStop|routeGroupingChildVersion)\b/gu);
      expect(source).not.toMatch(/\[['"](?:routePlanStop|routeGroupingChildVersion)['"]\]/gu);
      return calls;
    }).sort();
    expect(rawMutations).toEqual([
      'modules/driver/driver-event.repository.ts:UPDATE:route_plan_stops',
      'modules/driver/driver-event.repository.ts:UPDATE:route_plan_stops'
    ]);
  });

  test('locks route rows before grouping stop deletion or replacement', () => {
    const source = readFileSync(join(sourceRoot, 'modules/route-grouping/route-grouping.service.ts'), 'utf8');
    const guardedBodies: Array<[string, string]> = [
      [source.slice(source.indexOf('async deleteGrouping('), source.indexOf('async saveDraft(')), 'routePlanStop.deleteMany('],
      [source.slice(source.indexOf('async function archiveCurrentChildren('), source.indexOf('function assertNoInProgressCurrentChildren(')), 'routePlanStop.deleteMany(']
    ];
    for (const [body, mutation] of guardedBodies) {
      expect(body).toContain('lockReadyRoutePlanMembership(');
      expect(body.indexOf('lockReadyRoutePlanMembership(')).toBeLessThan(body.indexOf(mutation));
    }
    const lock = source.slice(source.indexOf('async function lockRoutePlanMembership('), source.indexOf('function normalizeDraftRoutes('));
    expect(lock).toContain('currentRouteVersionId');
    expect(lock).toContain('route_plan."constraints"');
    expect(lock).toContain('route_plan."name"');
    expect(lock).toContain('route_plan."updatedAt"');
    expect(lock).toContain('route_plan."vehicleId"');
    expect(lock).toContain('FOR UPDATE OF route_plan');
    expect(lock).toContain("routePlan.status !== 'READY'");
    const transactionalDraft = source.slice(source.indexOf('async saveDraftInTransaction('), source.indexOf('async publishGrouping('));
    expect(transactionalDraft).toContain('await lockRoutePlanMembership(');
    expect(transactionalDraft.indexOf('await lockRoutePlanMembership('))
      .toBeLessThan(transactionalDraft.indexOf('syncRoutePlanStopsPreservingRows('));
    expect(transactionalDraft).toContain('assertLockedRoutePlanChildAuthority(lockedRoutePlan, targetChild.id, route.expectedRoutePlanUpdatedAt)');
    expect(transactionalDraft).toContain('assertLockedRoutePlanSuccessorPolicy({');
    expect(transactionalDraft).toContain('lockedRoutePlan?.constraints ?? targetChild.routePlan?.constraints');
  });

  test('inventories every immutable successor caller and pins its lock policy', () => {
    const source = readFileSync(join(sourceRoot, 'modules/route-grouping/route-grouping.service.ts'), 'utf8');
    expect(callSiteInventory(source, 'replaceCurrentRouteGroupingChildVersion')).toEqual([
      'PrismaRouteGroupingService.deleteCustomStop',
      'PrismaRouteGroupingService.reOptimizeRoutes',
      'PrismaRouteGroupingService.saveDraft',
      'PrismaRouteGroupingService.saveDraftInTransaction',
      'appendGroupingOrdersToChildRoute',
      'invalidateCustomStopChildRoutes'
    ]);
    const policies: Array<[string, string, string]> = [
      ['async deleteCustomStop(', 'async previewOptimization(', 'lockReadyRoutePlanMembership('],
      ['async saveDraft(', 'async saveDraftInTransaction(', 'assertLockedRoutePlanSuccessorPolicy({'],
      ['async saveDraftInTransaction(', 'async publishGrouping(', 'assertLockedRoutePlanSuccessorPolicy({'],
      ['async reOptimizeRoutes(', 'private async prepareDraftRouteOptimizations(', 'assertLockedRoutePlanSuccessorPolicy({'],
      ['async function invalidateCustomStopChildRoutes(', 'function groupingInclude(', 'lockReadyRoutePlanMembership('],
      ['async function appendGroupingOrdersToChildRoute(', 'async function rewriteRoutePlanStops(', 'assertLockedRoutePlanChildAuthority(lockedRoutePlan, targetChild.id)']
    ];
    for (const [start, end, policy] of policies) {
      const body = source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
      expect(body).toContain(policy);
      expect(body.indexOf(policy)).toBeLessThan(body.indexOf('replaceCurrentRouteGroupingChildVersion(tx, {'));
    }
    const publicDraft = source.slice(source.indexOf('async saveDraft('), source.indexOf('async saveDraftInTransaction('));
    expect(publicDraft).toContain("draftOptimization !== undefined && input.mode !== 'MANUAL_ORDER'");
    const reOptimization = source.slice(source.indexOf('async reOptimizeRoutes('), source.indexOf('private maxChildRouteStopDistanceFromDepotMeters('));
    expect(reOptimization).toContain('driverId: lockedRoutePlan.driverId');
    expect(reOptimization).toContain('name: lockedRoutePlan.name');
    expect(reOptimization).toContain('mergeRouteConstraintsForReoptimization(');
    expect(reOptimization).toContain('lockedRoutePlan.constraints');
    expect(reOptimization).not.toContain('assignmentGeneration: { increment: 1 }');
    const groupingOrders = source.slice(source.indexOf('async updateGroupingOrders('), source.indexOf('async createCustomStop('));
    expect(groupingOrders.indexOf('await lockRoutePlanMembership(')).toBeLessThan(groupingOrders.indexOf('routeGroupingOrder.deleteMany('));
    expect(groupingOrders.indexOf('assertLockedRoutePlanSuccessorPolicy({')).toBeLessThan(groupingOrders.indexOf('routeGroupingOrder.deleteMany('));
    const assignmentAuthority = source.slice(source.indexOf('function currentChildAssignments('), source.indexOf('async function appendGroupingOrdersToChildRoute('));
    expect(assignmentAuthority).toContain("throw new RouteGroupingValidationError(['current route membership snapshot could not be resolved'])");
    expect(assignmentAuthority).toContain("throw new RouteGroupingValidationError(['current route membership snapshot is malformed'])");
    expect(assignmentAuthority).toContain("throw new RouteGroupingValidationError(['current route membership snapshot tuple does not match grouping authority'])");
    expect(assignmentAuthority).toContain("throw new RouteGroupingValidationError(['current route membership snapshot does not match bound route authority'])");
    expect(assignmentAuthority).toContain('currentRouteBindingAuthorityState(child.id, snapshotOrderIds, group.orders)');
    expect(assignmentAuthority).toContain("return resolveChildSnapshotAssignments(group, child, 'CURRENT')");
    expect(assignmentAuthority).toContain("return resolveChildSnapshotAssignments(group, child, 'CURRENT_READ')");
    expect(assignmentAuthority).not.toContain('.filter((assignment)');
    const bindingAuthority = source.slice(
      source.indexOf('export function currentRouteBindingAuthorityState('),
      source.indexOf('type OptimizedDraftRoute =')
    );
    expect(bindingAuthority).toContain('order.currentRouteVersionId === childVersionId');
    expect(bindingAuthority).toContain('boundOrderIds.length === 0');
    expect(bindingAuthority).toContain('order.currentRouteVersionId === null');
    expect(bindingAuthority).toContain("return entirelyUnbound ? 'LEGACY_UNBOUND' : 'MISMATCH'");
    expect(source.match(/readCurrentChildAssignments\(/gu)).toHaveLength(3);
    const childDto = source.slice(source.indexOf('function toChildDto('), source.indexOf('function readChildRouteGeometry('));
    const childGeometry = source.slice(source.indexOf('function readChildRouteGeometry('), source.indexOf('function readExactChildRouteMetricsFromRoutePlan('));
    expect(childDto).toContain('const assignments = readCurrentChildAssignments(group, child)');
    expect(childGeometry).toContain('assignments: readCurrentChildAssignments(group, child)');
    const archiveCurrent = source.slice(
      source.indexOf('async function archiveCurrentChildren('),
      source.indexOf('function assertNoInProgressCurrentChildren(')
    );
    expect(archiveCurrent).toContain('for (const child of current) currentChildAssignments(group, child)');
    expect(archiveCurrent.indexOf('currentChildAssignments(group, child)'))
      .toBeLessThan(archiveCurrent.indexOf('tx.routePlan.updateMany('));
    expect(archiveCurrent.indexOf('currentChildAssignments(group, child)'))
      .toBeLessThan(archiveCurrent.indexOf('tx.routeGroupingChildVersion.update('));
    const rebindAuthority = source.slice(
      source.indexOf('export async function rebindCurrentOrdersToRouteVersion('),
      source.indexOf('export async function replaceCurrentRouteGroupingChildVersion(')
    );
    expect(rebindAuthority).toContain('if (result.count !== orderIds.length)');
    expect(source.match(/await rebindCurrentOrdersToRouteVersion\(/gu)).toHaveLength(5);
    const rebindCallerBodies = [
      source.slice(source.indexOf('export async function replaceCurrentRouteGroupingChildVersion('), source.indexOf('export class PrismaRouteGroupingService')),
      source.slice(source.indexOf('async generateChildRoutes('), source.indexOf('async reOptimizeRoutes(')),
      source.slice(source.indexOf('async reOptimizeRoutes('), source.indexOf('async deleteBranch(')),
      source.slice(source.indexOf('async rollback('), source.indexOf('private async refreshChildRouteGeometry(')),
      source.slice(source.indexOf('async function createDraftChildRoutePlan('), source.indexOf('async function createChildRoutePlan('))
    ];
    for (const body of rebindCallerBodies) {
      expect(body).toContain('routeGroupingChildVersion.create(');
      expect(body).toContain('await rebindCurrentOrdersToRouteVersion(');
    }
    const rollbackBody = rebindCallerBodies[3] ?? '';
    expect(rollbackBody).toContain('assignments: archivedChildAssignments(loaded, child)');
    expect(rollbackBody).toContain('snapshot: canonicalSnapshot');
    expect(rollbackBody).not.toContain('snapshot: { ...snapshot');
    expect(rollbackBody).toContain('selectTerminalArchivedChildren(archivedCandidates)');
    expect(rollbackBody).toContain('assertRollbackMembershipDisjoint(rollbackSources)');
    expect(rollbackBody.indexOf('assertRollbackMembershipDisjoint(rollbackSources)'))
      .toBeLessThan(rollbackBody.indexOf('await archiveCurrentChildren('));
    expect(source).toContain("throw new RouteGroupingValidationError(['archived legacy route membership cannot be restored safely'])");
  });

  test('locks every serialized progress or completion contract before reading its immutable snapshot', () => {
    const source = readFileSync(join(sourceRoot, 'modules/driver/driver-event.repository.ts'), 'utf8');
    const transaction = source.slice(
      source.indexOf('const result = await this.prisma.$transaction('),
      source.indexOf('const sequenceDeviation = await detectStopSequenceDeviation')
    );

    expect(transaction).toContain('await lockRoutePlanForSerializedEvent(transaction, input)');
    expect(transaction.indexOf('await lockRoutePlanForSerializedEvent(transaction, input)'))
      .toBeLessThan(transaction.indexOf('await validateVersionedOrderedContract(transaction, input)'));
    expect(transaction.indexOf('await lockRoutePlanForSerializedEvent(transaction, input)'))
      .toBeLessThan(transaction.indexOf('await evaluateCompletionInvariant(transaction, input'));
  });

  test('serializes grouped deletion and preserves canonical grouped stop authority', () => {
    const groupingSource = readFileSync(join(sourceRoot, 'modules/route-grouping/route-grouping.service.ts'), 'utf8');
    const routePlanSource = readFileSync(join(sourceRoot, 'modules/route-plans/route-plan.repository.ts'), 'utf8');
    const rollback = groupingSource.slice(groupingSource.indexOf('async rollback('), groupingSource.indexOf('private async refreshChildRouteGeometry'));
    expect(groupingSource.match(/await archiveDeletedRouteGroupingChildMembership\(tx, child\)/gu)).toHaveLength(2);
    expect(rollback).toContain('deletedArchivedRouteSlots(loaded.childVersions)');
    expect(rollback.indexOf('deletedArchivedRouteSlots(loaded.childVersions)'))
      .toBeLessThan(rollback.indexOf('await archiveCurrentChildren('));

    const deleteRoute = routePlanSource.slice(routePlanSource.indexOf('async deleteRoutePlan('), routePlanSource.indexOf('async updateRoutePlanOptions('));
    expect(deleteRoute.indexOf('FROM "route_groupings"')).toBeLessThan(deleteRoute.indexOf('FROM "route_plans"'));
    expect(deleteRoute).toContain('selectRoutePlanDeletionLineageTerminals(routePlanChildren)');
    expect(deleteRoute).toContain("routePlanChildren.filter((child) => child.status === 'CURRENT'");
    expect(deleteRoute.indexOf('await archiveDeletedRouteGroupingChildMembership(tx, child)'))
      .toBeLessThan(deleteRoute.indexOf('await clearRouteGroupingChildVersionRoutePlanRefs(tx, {'));
    const saveRoute = routePlanSource.slice(routePlanSource.indexOf('async saveRoutePlan('), routePlanSource.indexOf('async deleteRoutePlan('));
    expect(saveRoute).toContain('hasCurrentRouteGroupingChild(tx, routePlan.id)');
    const updateStops = routePlanSource.slice(routePlanSource.indexOf('async updateRoutePlanStops('));
    expect(updateStops).toContain("input.mutationContext?.source !== 'route_optimization_job'");
    expect(updateStops).toContain('sameUniqueStringSet(boundOrderIds, nextOrderIds)');
    expect(updateStops).toContain('await replaceCurrentRouteGroupingChildVersion(tx, {');
  });

  test('keeps driver acknowledgement outside direct membership mutation authority', () => {
    const source = readFileSync(join(sourceRoot, 'modules/driver/driver-event.repository.ts'), 'utf8');
    const acknowledgement = source.slice(
      source.indexOf('async function applyDispatchChangeRequestAck('),
      source.indexOf('async function detectStopSequenceDeviation(')
    );

    expect(acknowledgement).not.toMatch(/routePlanStop\.(?:create|createMany|deleteMany|updateMany)\(/u);
    expect(acknowledgement).not.toMatch(/data:\s*\{\s*currentRouteVersionId:/u);
    expect(acknowledgement).toContain("request.type === 'ACTIVE_ROUTE_ORDER_REMOVAL'");
    expect(acknowledgement).toContain('throw new DriverEventExecutionConflictError(routePlanId, request.deliveryStopId)');
  });
});

function typescriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return typescriptFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

function mutationInventory(models: string[], requireAssignmentPointer = false): string[] {
  const writeOperations = new Set(['create', 'createMany', 'delete', 'deleteMany', 'update', 'updateMany', 'upsert']);
  return typescriptFiles(sourceRoot).flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const counts = new Map<string, number>();
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && ts.isPropertyAccessExpression(node.expression.expression)) {
        const model = node.expression.expression.name.text;
        const operation = node.expression.name.text;
        const firstArgument = node.arguments[0];
        const dataProperty = firstArgument !== undefined && ts.isObjectLiteralExpression(firstArgument)
          ? firstArgument.properties.find((property) => property.name?.getText(sourceFile) === 'data')
          : undefined;
        const includesAssignmentPointer = dataProperty?.getText(sourceFile).includes('currentRouteVersionId') === true;
        if (models.includes(model) && writeOperations.has(operation) && (!requireAssignmentPointer || includesAssignmentPointer)) {
          const key = `${model}.${operation}`;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return [...counts].map(([operation, count]) => `${relative(sourceRoot, file)}:${operation}:${count}`);
  }).sort();
}

function callSiteInventory(source: string, calleeName: string): string[] {
  const sourceFile = ts.createSourceFile('route-grouping.service.ts', source, ts.ScriptTarget.Latest, true);
  const callers = new Set<string>();
  const visit = (node: ts.Node, scope: string | null): void => {
    let nextScope = scope;
    if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
      nextScope = `PrismaRouteGroupingService.${node.name.text}`;
    } else if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      nextScope = node.name.text;
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === calleeName) {
      if (nextScope === null) throw new Error(`Unscoped ${calleeName} call`);
      callers.add(nextScope);
    }
    node.forEachChild((child) => visit(child, nextScope));
  };
  visit(sourceFile, null);
  return [...callers].sort();
}
