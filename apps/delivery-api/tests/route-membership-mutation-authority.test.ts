import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';
import ts from 'typescript';

const sourceRoot = join(process.cwd(), 'src');
const authorizedMembershipWriters = [
  'modules/dsv/dsv-assignment-command.service.ts',
  'modules/dsv/dsv-dispatch-import.service.ts',
  'modules/route-grouping/route-grouping.service.ts',
  'modules/route-plans/route-plan.repository.ts'
];

const reviewedMutationInventory = [
  'modules/driver/driver-event.repository.ts:routePlanStop.update:2',
  'modules/dsv/dsv-assignment-command.service.ts:routePlanStop.updateMany:1',
  'modules/dsv/dsv-dispatch-import.service.ts:routePlanStop.updateMany:1',
  'modules/route-grouping/route-grouping.service.ts:routeGroupingChildVersion.create:6',
  'modules/route-grouping/route-grouping.service.ts:routeGroupingChildVersion.delete:2',
  'modules/route-grouping/route-grouping.service.ts:routeGroupingChildVersion.update:3',
  'modules/route-grouping/route-grouping.service.ts:routeGroupingChildVersion.updateMany:2',
  'modules/route-grouping/route-grouping.service.ts:routePlanStop.create:1',
  'modules/route-grouping/route-grouping.service.ts:routePlanStop.createMany:4',
  'modules/route-grouping/route-grouping.service.ts:routePlanStop.deleteMany:5',
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
      [source.slice(source.indexOf('async saveDraft('), source.indexOf('async saveDraftInTransaction(')), 'routePlanStop.deleteMany('],
      [source.slice(source.indexOf('async saveDraftInTransaction('), source.indexOf('async publishGrouping(')), 'syncRoutePlanStopsPreservingRows('],
      [source.slice(source.indexOf('async function archiveCurrentChildren('), source.indexOf('function assertNoInProgressCurrentChildren(')), 'routePlanStop.deleteMany(']
    ];
    for (const [body, mutation] of guardedBodies) {
      expect(body).toContain('lockRoutePlanAssignment(');
      expect(body.indexOf('lockRoutePlanAssignment(')).toBeLessThan(body.indexOf(mutation));
    }
    const lock = source.slice(source.indexOf('async function lockRoutePlanAssignment('), source.indexOf('function normalizeDraftRoutes('));
    expect(lock).toContain('SELECT "driverId", "status"');
    expect(lock).toContain('FOR UPDATE');
    expect(lock).toContain("routePlan.status === 'IN_PROGRESS'");
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
