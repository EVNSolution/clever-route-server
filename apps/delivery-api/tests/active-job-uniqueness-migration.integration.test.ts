import { readFile } from 'node:fs/promises';

import pg from 'pg';
import { describe, expect, test } from 'vitest';

const databaseUrl = process.env.ACTIVE_JOB_UNIQUENESS_DATABASE_URL ?? '';
const live = databaseUrl === '' ? test.skip : test;
const migrationPath = new URL(
  '../prisma/migrations/20260907000000_restore_active_job_uniqueness/migration.sql',
  import.meta.url
);

const shopId = '91000000-0000-4000-8000-000000000001';
const connectionId = '92000000-0000-4000-8000-000000000001';
const routePlanId = '93000000-0000-4000-8000-000000000001';
const commerceIndex = 'commerce_sync_runs_one_active_per_connection_idx';
const routeIndex = 'route_optimization_jobs_one_active_per_route_idx';

describe('active job uniqueness restoration migration', () => {
  test('uses bounded locks and contains no data-rewriting or destructive SQL', async () => {
    const sql = await readFile(migrationPath, 'utf8');

    expect(sql).toContain("SET LOCAL lock_timeout = '5s'");
    expect(sql).toContain("SET LOCAL statement_timeout = '30s'");
    expect(sql.indexOf('LOCK TABLE "commerce_sync_runs" IN SHARE MODE')).toBeLessThan(
      sql.indexOf('LOCK TABLE "route_optimization_jobs" IN SHARE MODE')
    );
    expect(sql).not.toMatch(/\b(?:DELETE|DROP|TRUNCATE|UPDATE)\b/iu);
  });

  live('restores and enforces both partial unique indexes without changing existing rows', async () => {
    assertDisposableDatabase();
    const sql = await readFile(migrationPath, 'utf8');
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();

    try {
      await cleanup(client);
      await restoreIndexes(client, sql);
      await expectIndexes(client, true);

      await expect(client.query(sql)).resolves.toBeDefined();
      await expectIndexes(client, true);

      await dropIndexes(client);
      await client.query(`CREATE INDEX "${commerceIndex}" ON "commerce_sync_runs"("status")`);
      await client.query(`CREATE INDEX "${routeIndex}" ON "route_optimization_jobs"("status")`);
      const beforeWrongDefinition = await fixtureCounts(client);
      await expectMigrationFailure(client, sql, /unexpected definition/u);
      expect(await fixtureCounts(client)).toEqual(beforeWrongDefinition);
      await expectIndexes(client, false);
      await dropIndexes(client);

      await seedParents(client);
      await insertCommerceRun(client, '94000000-0000-4000-8000-000000000001', 'QUEUED');
      await insertCommerceRun(client, '94000000-0000-4000-8000-000000000002', 'RUNNING');
      await insertRouteJob(client, '95000000-0000-4000-8000-000000000001', 'QUEUED');
      await insertRouteJob(client, '95000000-0000-4000-8000-000000000002', 'RUNNING');
      const beforeDuplicatePreflight = await fixtureCounts(client);
      await expectMigrationFailure(client, sql, /duplicate active/u);
      expect(await fixtureCounts(client)).toEqual(beforeDuplicatePreflight);
      await expectIndexes(client, null);

      await client.query('DELETE FROM "commerce_sync_runs" WHERE "shopId" = $1', [shopId]);
      await client.query('DELETE FROM "route_optimization_jobs" WHERE "shopId" = $1', [shopId]);

      const blocker = new pg.Client({ connectionString: databaseUrl });
      await blocker.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query('LOCK TABLE "commerce_sync_runs" IN ACCESS EXCLUSIVE MODE');
        await expectMigrationFailure(client, sql, /lock timeout/u, '55P03');
        await expectIndexes(client, null);
      } finally {
        await blocker.query('ROLLBACK');
        await blocker.end();
      }

      await restoreIndexes(client, sql);
      await expectIndexes(client, true);

      const commerceAttempts = await Promise.allSettled([
        insertCommerceRun(client, '94000000-0000-4000-8000-000000000003', 'QUEUED'),
        insertCommerceRun(new pg.Client({ connectionString: databaseUrl }), '94000000-0000-4000-8000-000000000004', 'RUNNING', true)
      ]);
      expect(commerceAttempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(commerceAttempts.filter((result) => result.status === 'rejected')).toHaveLength(1);

      const routeAttempts = await Promise.allSettled([
        insertRouteJob(client, '95000000-0000-4000-8000-000000000003', 'QUEUED'),
        insertRouteJob(new pg.Client({ connectionString: databaseUrl }), '95000000-0000-4000-8000-000000000004', 'RUNNING', true)
      ]);
      expect(routeAttempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(routeAttempts.filter((result) => result.status === 'rejected')).toHaveLength(1);

      await insertCommerceRun(client, '94000000-0000-4000-8000-000000000005', 'SUCCEEDED');
      await insertCommerceRun(client, '94000000-0000-4000-8000-000000000006', 'FAILED');
      await insertRouteJob(client, '95000000-0000-4000-8000-000000000005', 'APPLIED');
      await insertRouteJob(client, '95000000-0000-4000-8000-000000000006', 'CANCELLED');

      expect(await fixtureCounts(client)).toEqual({ commerce: 3, routes: 3 });
    } finally {
      await cleanup(client);
      await restoreIndexes(client, sql);
      await client.end();
    }
  }, 30_000);
});

function assertDisposableDatabase(): void {
  const url = new URL(databaseUrl);
  const isG006Runner = url.hostname === '127.0.0.1' && url.port === '55490' && url.pathname === '/clever_g006';
  const isDedicatedLocal =
    url.hostname === '127.0.0.1' &&
    url.port === '55496' &&
    url.pathname === '/clever_g007_empty_inquiry_queue';

  expect(isG006Runner || isDedicatedLocal).toBe(true);
  if (isG006Runner) expect(process.env.G006_DATABASE_TARGET_CLASS).toBe('safe-local-g006-disposable');
}

async function seedParents(client: pg.Client): Promise<void> {
  await client.query(
    `INSERT INTO "shops" ("id", "shopDomain", "updatedAt")
     VALUES ($1, 'active-job-uniqueness.invalid', now())`,
    [shopId]
  );
  await client.query(
    `INSERT INTO "commerce_connections" (
       "id", "shopId", "platform", "siteUrl", "shopDomain", "consumerKeyCiphertext",
       "consumerSecretCiphertext", "webhookSecretCiphertext", "updatedAt"
     ) VALUES ($1, $2, 'WOOCOMMERCE', 'https://active-job-uniqueness.invalid',
       'active-job-uniqueness.invalid', 'fixture', 'fixture', 'fixture', now())`,
    [connectionId, shopId]
  );
  await client.query(
    `INSERT INTO "route_plans" (
       "id", "shopId", "name", "planDate", "optimizerVersion", "constraints", "metrics", "updatedAt"
     ) VALUES ($1, $2, 'active-job-uniqueness', DATE '2026-09-07', 'fixture', '{}'::jsonb, '{}'::jsonb, now())`,
    [routePlanId, shopId]
  );
}

async function insertCommerceRun(
  client: pg.Client,
  id: string,
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED',
  ownsClient = false
): Promise<void> {
  if (ownsClient) await client.connect();
  try {
    await client.query(
      `INSERT INTO "commerce_sync_runs" (
         "id", "shopId", "commerceConnectionId", "platform", "trigger", "status", "requestPayload", "updatedAt"
       ) VALUES ($1, $2, $3, 'WOOCOMMERCE', 'fixture', $4, '{}'::jsonb, now())`,
      [id, shopId, connectionId, status]
    );
  } finally {
    if (ownsClient) await client.end();
  }
}

async function insertRouteJob(
  client: pg.Client,
  id: string,
  status: 'QUEUED' | 'RUNNING' | 'APPLIED' | 'CANCELLED',
  ownsClient = false
): Promise<void> {
  if (ownsClient) await client.connect();
  try {
    await client.query(
      `INSERT INTO "route_optimization_jobs" (
         "id", "shopId", "routePlanId", "status", "timeoutBudgetMs", "traceId"
       ) VALUES ($1, $2, $3, $4, 1000, 'fixture')`,
      [id, shopId, routePlanId, status]
    );
  } finally {
    if (ownsClient) await client.end();
  }
}

async function cleanup(client: pg.Client): Promise<void> {
  await client.query('DELETE FROM "shops" WHERE "id" = $1', [shopId]);
}

async function dropIndexes(client: pg.Client): Promise<void> {
  await client.query(`DROP INDEX IF EXISTS "${commerceIndex}"`);
  await client.query(`DROP INDEX IF EXISTS "${routeIndex}"`);
}

async function restoreIndexes(client: pg.Client, sql: string): Promise<void> {
  await dropIndexes(client);
  await client.query(sql);
}

async function expectMigrationFailure(
  client: pg.Client,
  sql: string,
  message: RegExp,
  code?: string
): Promise<void> {
  let failure: unknown;
  try {
    await client.query(sql);
  } catch (error: unknown) {
    failure = error;
  } finally {
    await client.query('ROLLBACK');
  }

  expect(failure).toBeInstanceOf(Error);
  const postgresFailure = failure as Error & { code?: unknown };
  expect(postgresFailure.message).toMatch(message);
  if (code !== undefined) expect(postgresFailure.code).toBe(code);
}

async function fixtureCounts(client: pg.Client): Promise<{ commerce: number; routes: number }> {
  const result = await client.query<{ commerce: number; routes: number }>(
    `SELECT
       (SELECT count(*)::integer FROM "commerce_sync_runs" WHERE "shopId" = $1) AS commerce,
       (SELECT count(*)::integer FROM "route_optimization_jobs" WHERE "shopId" = $1) AS routes`,
    [shopId]
  );
  return result.rows[0] ?? { commerce: -1, routes: -1 };
}

async function expectIndexes(client: pg.Client, valid: boolean | null): Promise<void> {
  const result = await client.query<{ index_name: string; valid: boolean }>(
    `SELECT index_class.relname AS index_name,
            index_meta.indisvalid AND index_meta.indisready AND index_meta.indisunique AS valid
     FROM pg_index index_meta
     JOIN pg_class index_class ON index_class.oid = index_meta.indexrelid
     WHERE index_class.relname = ANY($1::text[])
     ORDER BY index_class.relname`,
    [[commerceIndex, routeIndex]]
  );

  if (valid === null) expect(result.rows).toEqual([]);
  else expect(result.rows).toEqual([
    { index_name: commerceIndex, valid },
    { index_name: routeIndex, valid }
  ]);
}
