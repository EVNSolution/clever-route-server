import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { Client } from 'pg';

type CountRow = {
  count: string;
};

type SampleRow = Record<string, unknown>;

const reportPath = process.env.G002_BACKFILL_REPORT_PATH ?? 'docs/evidence/g002/backfill-dry-run-report.json';
const databaseUrl = process.env.DATABASE_URL ?? 'postgresql://clever:clever@localhost:5432/clever_route';

const report =
  process.argv.includes('--empty-fixture') || process.env.G002_BACKFILL_EMPTY_FIXTURE === '1'
    ? createEmptyFixtureReport()
    : await createDatabaseReport(databaseUrl);

await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(reportPath);

function createEmptyFixtureReport() {
  return {
    goal: 'G002',
    mode: 'dry-run',
    databaseTargetClass: 'empty-schema-fixture',
    wroteDatabaseRows: false,
    ambiguity: {
      duplicateSellerOrderKeys: [],
      duplicateCustomerCodes: [],
      sharedDestinationCandidates: []
    },
    missingLinkage: {
      ordersWithoutCustomer: 0,
      ordersWithoutDestination: 0,
      dispatchRowsWithoutCanonicalOrder: 0
    }
  };
}

async function createDatabaseReport(connectionString: string) {
  const client = new Client({ connectionString });
  await client.connect();

  try {
    await client.query('BEGIN READ ONLY');
    const hasOrdersCustomerId = await columnExists(client, 'orders', 'customerId');
    const hasOrdersDestinationId = await columnExists(client, 'orders', 'destinationId');
    const hasOrdersSellerOrderKey = await columnExists(client, 'orders', 'sellerOrderKey');
    const hasDispatchRows = await tableExists(client, 'dsv_dispatch_import_rows');
    const [
      ordersWithoutCustomer,
      ordersWithoutDestination,
      dispatchRowsWithoutCanonicalOrder,
      duplicateSellerOrderKeys,
      duplicateCustomerCodes,
      sharedDestinationCandidates
    ] = await Promise.all([
      countRows(
        client,
        hasOrdersCustomerId
          ? 'SELECT COUNT(*)::text AS count FROM "orders" WHERE "customerId" IS NULL'
          : 'SELECT COUNT(*)::text AS count FROM "orders"'
      ),
      countRows(
        client,
        hasOrdersDestinationId
          ? 'SELECT COUNT(*)::text AS count FROM "orders" WHERE "destinationId" IS NULL'
          : 'SELECT COUNT(*)::text AS count FROM "orders"'
      ),
      hasDispatchRows
        ? countRows(
            client,
            hasOrdersSellerOrderKey
              ? `SELECT COUNT(*)::text AS count
                   FROM "dsv_dispatch_import_rows" r
                   LEFT JOIN "orders" o
                     ON o."shopId" = r."shopId"
                    AND o."sellerOrderKey" = r."sellerOrderKey"
                  WHERE o."id" IS NULL`
              : 'SELECT COUNT(*)::text AS count FROM "dsv_dispatch_import_rows"'
          )
        : Promise.resolve(0),
      hasDispatchRows
        ? sampleRows(
            client,
            `SELECT "shopId", "sellerOrderKey", COUNT(*)::int AS "rowCount"
               FROM "dsv_dispatch_import_rows"
              GROUP BY "shopId", "sellerOrderKey"
             HAVING COUNT(*) > 1
              ORDER BY "rowCount" DESC, "sellerOrderKey"
              LIMIT 50`
          )
        : Promise.resolve([]),
      hasDispatchRows
        ? sampleRows(
            client,
            `SELECT "shopId", "customerCode", COUNT(*)::int AS "rowCount"
               FROM "dsv_dispatch_import_rows"
              GROUP BY "shopId", "customerCode"
             HAVING COUNT(*) > 1
              ORDER BY "rowCount" DESC, "customerCode"
              LIMIT 50`
          )
        : Promise.resolve([]),
      hasDispatchRows
        ? sampleRows(
            client,
            `SELECT "shopId", "address", COUNT(DISTINCT "customerCode")::int AS "customerCount"
               FROM "dsv_dispatch_import_rows"
              GROUP BY "shopId", "address"
             HAVING COUNT(DISTINCT "customerCode") > 1
              ORDER BY "customerCount" DESC, "address"
              LIMIT 50`
          )
        : Promise.resolve([])
    ]);
    await client.query('ROLLBACK');

    return {
      goal: 'G002',
      mode: 'dry-run',
      databaseTargetClass: process.env.G002_DATABASE_TARGET_CLASS ?? 'local-or-production-like-clone',
      wroteDatabaseRows: false,
      schemaReadiness: {
        hasOrdersCustomerId,
        hasOrdersDestinationId,
        hasOrdersSellerOrderKey,
        hasDispatchRows
      },
      ambiguity: {
        duplicateSellerOrderKeys,
        duplicateCustomerCodes,
        sharedDestinationCandidates
      },
      missingLinkage: {
        ordersWithoutCustomer,
        ordersWithoutDestination,
        dispatchRowsWithoutCanonicalOrder
      }
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

async function countRows(client: Client, sql: string): Promise<number> {
  const result = await client.query<CountRow>(sql);
  return Number(result.rows[0]?.count ?? 0);
}

async function sampleRows(client: Client, sql: string): Promise<SampleRow[]> {
  const result = await client.query<SampleRow>(sql);
  return result.rows;
}

async function tableExists(client: Client, tableName: string): Promise<boolean> {
  const result = await client.query<CountRow>(
    `SELECT COUNT(*)::text AS count
       FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = $1`,
    [tableName]
  );
  return Number(result.rows[0]?.count ?? 0) > 0;
}

async function columnExists(client: Client, tableName: string, columnName: string): Promise<boolean> {
  const result = await client.query<CountRow>(
    `SELECT COUNT(*)::text AS count
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
        AND column_name = $2`,
    [tableName, columnName]
  );
  return Number(result.rows[0]?.count ?? 0) > 0;
}
