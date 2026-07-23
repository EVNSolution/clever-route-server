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
    domainCounts: {
      customers: 0,
      destinations: 0,
      orders: 0,
      customerLinkedOrders: 0,
      destinationLinkedOrders: 0,
      customerAndDestinationLinkedOrders: 0
    },
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
    const hasOrders = await tableExists(client, 'orders');
    const hasOrdersCustomerId = await columnExists(client, 'orders', 'customerId');
    const hasOrdersDestinationId = await columnExists(client, 'orders', 'destinationId');
    const hasOrdersSellerOrderKey = await columnExists(client, 'orders', 'sellerOrderKey');
    const hasDispatchRows = await tableExists(client, 'dsv_dispatch_import_rows');
    const hasCustomers = await tableExists(client, 'customers');
    const hasDestinations = await tableExists(client, 'delivery_customer_profiles');
    const customers = hasCustomers ? await countRows(client, 'SELECT COUNT(*)::text AS count FROM "customers"') : 0;
    const destinations = hasDestinations
      ? await countRows(client, 'SELECT COUNT(*)::text AS count FROM "delivery_customer_profiles"')
      : 0;
    const orders = hasOrders ? await countRows(client, 'SELECT COUNT(*)::text AS count FROM "orders"') : 0;
    const customerLinkedOrders =
      hasOrders && hasOrdersCustomerId
        ? await countRows(client, 'SELECT COUNT(*)::text AS count FROM "orders" WHERE "customerId" IS NOT NULL')
        : 0;
    const destinationLinkedOrders =
      hasOrders && hasOrdersDestinationId
        ? await countRows(client, 'SELECT COUNT(*)::text AS count FROM "orders" WHERE "destinationId" IS NOT NULL')
        : 0;
    const customerAndDestinationLinkedOrders =
      hasOrders && hasOrdersCustomerId && hasOrdersDestinationId
        ? await countRows(
            client,
            'SELECT COUNT(*)::text AS count FROM "orders" WHERE "customerId" IS NOT NULL AND "destinationId" IS NOT NULL'
          )
        : 0;
    const ordersWithoutCustomer = hasOrders
      ? await countRows(
          client,
          hasOrdersCustomerId
            ? 'SELECT COUNT(*)::text AS count FROM "orders" WHERE "customerId" IS NULL'
            : 'SELECT COUNT(*)::text AS count FROM "orders"'
        )
      : 0;
    const ordersWithoutDestination = hasOrders
      ? await countRows(
          client,
          hasOrdersDestinationId
            ? 'SELECT COUNT(*)::text AS count FROM "orders" WHERE "destinationId" IS NULL'
            : 'SELECT COUNT(*)::text AS count FROM "orders"'
        )
      : 0;
    const dispatchRowsWithoutCanonicalOrder = hasDispatchRows
      ? await countRows(
          client,
          hasOrders && hasOrdersSellerOrderKey
            ? `SELECT COUNT(*)::text AS count
                 FROM "dsv_dispatch_import_rows" r
                 LEFT JOIN "orders" o
                   ON o."shopId" = r."shopId"
                  AND o."sellerOrderKey" = r."sellerOrderKey"
                WHERE o."id" IS NULL`
            : 'SELECT COUNT(*)::text AS count FROM "dsv_dispatch_import_rows"'
        )
      : 0;
    const duplicateSellerOrderKeys = hasDispatchRows
      ? await sampleRows(
          client,
          `SELECT "shopId", "sellerOrderKey", COUNT(*)::int AS "rowCount"
             FROM "dsv_dispatch_import_rows"
            GROUP BY "shopId", "sellerOrderKey"
           HAVING COUNT(*) > 1
            ORDER BY "rowCount" DESC, "sellerOrderKey"
            LIMIT 50`
        )
      : [];
    const duplicateCustomerCodes = hasDispatchRows
      ? await sampleRows(
          client,
          `SELECT "shopId", "customerCode", COUNT(*)::int AS "rowCount"
             FROM "dsv_dispatch_import_rows"
            GROUP BY "shopId", "customerCode"
           HAVING COUNT(*) > 1
            ORDER BY "rowCount" DESC, "customerCode"
            LIMIT 50`
        )
      : [];
    const sharedDestinationCandidates = hasDispatchRows
      ? await sampleRows(
          client,
          `SELECT "shopId", "address", COUNT(DISTINCT "customerCode")::int AS "customerCount"
             FROM "dsv_dispatch_import_rows"
            GROUP BY "shopId", "address"
           HAVING COUNT(DISTINCT "customerCode") > 1
            ORDER BY "customerCount" DESC, "address"
            LIMIT 50`
        )
      : [];
    await client.query('ROLLBACK');

    return {
      goal: 'G002',
      mode: 'dry-run',
      databaseTargetClass: process.env.G002_DATABASE_TARGET_CLASS ?? 'local-or-production-like-clone',
      wroteDatabaseRows: false,
      schemaReadiness: {
        hasOrders,
        hasOrdersCustomerId,
        hasOrdersDestinationId,
        hasOrdersSellerOrderKey,
        hasDispatchRows,
        hasCustomers,
        hasDestinations
      },
      domainCounts: {
        customers,
        destinations,
        orders,
        customerLinkedOrders,
        destinationLinkedOrders,
        customerAndDestinationLinkedOrders
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
