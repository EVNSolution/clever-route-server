import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';

const sourceRoot = join(process.cwd(), 'src');
const authorizedMembershipWriters = [
  'modules/dsv/dsv-assignment-command.service.ts',
  'modules/dsv/dsv-dispatch-import.service.ts',
  'modules/route-grouping/route-grouping.service.ts',
  'modules/route-plans/route-plan.repository.ts'
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
