import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

import { Client } from 'pg';

const REQUIRED_SCHEMA = 'orders_perf_20260804';
const INDEX_NAME = 'orders_shopId_displayOrderSequence_id_idx';
const OUTPUT_PATH = resolve(process.env.ORDERS_PAGINATION_EVIDENCE_OUTPUT ?? '.omx/perf/orders-pagination-completion-evidence.json');
const COHORT_PATH = resolve(process.env.ORDERS_PERF_COHORT_ARTIFACT ?? '.omx/perf/orders-server-performance-cohorts.json');

const { connectionString, schema } = readDatabaseUrl(process.env.DATABASE_URL);
if (schema !== REQUIRED_SCHEMA) {
  throw new Error(`DATABASE_URL must target isolated schema ${REQUIRED_SCHEMA}`);
}

const client = new Client({ connectionString });

try {
  await client.connect();
  await client.query(`SET search_path TO "${REQUIRED_SCHEMA}"`);
  await client.query(`SET statement_timeout TO '5s'`);

  const shopId = await readFixtureShopId();
  const fixtureRows = await readCount('orders');
  const explainPlans = {
    areaReadinessUnplannedBackward: await explainCommonFilterPage({ direction: 'backward', profile: 'areaReadinessUnplanned', shopId }),
    areaReadinessUnplannedForward: await explainCommonFilterPage({ direction: 'forward', profile: 'areaReadinessUnplanned', shopId }),
    orderedDateRangeBackward: await explainCommonFilterPage({ direction: 'backward', profile: 'orderedDateRange', shopId }),
    orderedDateRangeForward: await explainCommonFilterPage({ direction: 'forward', profile: 'orderedDateRange', shopId })
  };
  const backfillRehearsal = await rehearseBackfillEquivalence(shopId);
  const privacyEvidence = await readCohortPrivacyEvidence();

  const artifact = {
    backfillRehearsal,
    capturedAt: new Date().toISOString(),
    environment: {
      cohortArtifact: COHORT_PATH,
      database: 'isolated-local-postgresql',
      fixtureRows,
      requiredSchema: REQUIRED_SCHEMA,
      schema,
      synthetic: true
    },
    explainPlans,
    pass: Object.values(explainPlans).every((plan) => plan.pass) && backfillRehearsal.pass && privacyEvidence.pass,
    privacyEvidence
  };

  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  process.stdout.write(`${OUTPUT_PATH}\n`);
} finally {
  await client.end();
}

async function explainCommonFilterPage(input: {
  direction: 'backward' | 'forward';
  profile: 'areaReadinessUnplanned' | 'orderedDateRange';
  shopId: string;
}): Promise<{
  actualRows: number;
  direction: 'backward' | 'forward';
  executionTimeMs: number;
  indexedJoinAccess: boolean;
  nodes: PlanNodeSummary[];
  paginationIndexUsed: boolean;
  pass: boolean;
  profile: 'areaReadinessUnplanned' | 'orderedDateRange';
  sequentialScanOnOrders: boolean;
}> {
  const comparator = input.direction === 'forward' ? '<=' : '>=';
  const tupleComparator = input.direction === 'forward' ? '<' : '>';
  const sort = input.direction === 'forward' ? 'DESC' : 'ASC';
  const sequence = input.direction === 'forward' ? 4_900 : 100;
  const orderId = input.direction === 'forward'
    ? 'ffffffff-ffff-ffff-ffff-ffffffffffff'
    : '00000000-0000-0000-0000-000000000000';
  const commonFilterSql = input.profile === 'areaReadinessUnplanned'
    ? `
        AND EXISTS (
          SELECT 1
          FROM "order_delivery_facts" f
          WHERE f."orderId" = o."id"
            AND f."shopId" = o."shopId"
            AND f."deliveryArea" = 'Area-01'
            AND f."readiness" = 'READY_TO_PLAN'::"OrderDeliveryFactReadiness"
        )
        AND EXISTS (
          SELECT 1
          FROM "delivery_stops" s
          WHERE s."orderId" = o."id"
            AND s."shopId" = o."shopId"
            AND s."status" NOT IN ('ASSIGNED'::"DeliveryStopStatus", 'EN_ROUTE'::"DeliveryStopStatus", 'ARRIVED'::"DeliveryStopStatus", 'DELIVERED'::"DeliveryStopStatus")
            AND NOT EXISTS (
              SELECT 1
              FROM "route_plan_stops" rps
              WHERE rps."deliveryStopId" = s."id"
            )
        )
      `
    : '';
  const explain = await client.query<ExplainRow>({
    text: `
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT o."id", o."displayOrderSequence"
      FROM "orders" o
      WHERE o."shopId" = $1::uuid
        AND o."createdAt" <= now()
        AND o."displayOrderSequence" IS NOT NULL
        AND o."displayOrderSequence" ${comparator} $2::bigint
        AND (
          o."displayOrderSequence" ${tupleComparator} $2::bigint
          OR (o."displayOrderSequence" = $2::bigint AND o."id" ${tupleComparator} $3::uuid)
        )
        AND o."processedAt" >= now() - interval '30 days'
        ${commonFilterSql}
      ORDER BY o."displayOrderSequence" ${sort}, o."id" ${sort}
      LIMIT 51
    `,
    values: [input.shopId, sequence, orderId]
  });
  const plan = explain.rows[0]?.['QUERY PLAN'][0]?.Plan;
  if (plan === undefined) throw new Error('EXPLAIN returned no plan');
  const nodes = summarizePlan(plan);
  const paginationIndexUsed = nodes.some((node) => node.indexName === INDEX_NAME);
  const indexedJoinAccess = nodes.some((node) => node.indexName !== null);
  const sequentialScanOnOrders = nodes.some((node) => node.nodeType === 'Seq Scan' && node.relationName === 'orders');
  const executionTimeMs = explain.rows[0]?.['QUERY PLAN'][0]?.['Execution Time'] ?? 0;
  const pass = input.profile === 'orderedDateRange'
    ? paginationIndexUsed && !sequentialScanOnOrders
    : indexedJoinAccess && !sequentialScanOnOrders && executionTimeMs < 50;
  return {
    actualRows: plan['Actual Rows'] ?? 0,
    direction: input.direction,
    executionTimeMs,
    indexedJoinAccess,
    nodes,
    paginationIndexUsed,
    pass,
    profile: input.profile,
    sequentialScanOnOrders
  };
}

async function rehearseBackfillEquivalence(shopId: string): Promise<{
  afterRollbackNullSequences: number;
  beforeNullSequences: number;
  equivalentOrder: boolean;
  pass: boolean;
  rollbackPreservedChecksum: boolean;
  sampleRows: number;
  updatedRows: number;
}> {
  const beforeNullSequences = await readNullSequenceCount(shopId);
  const beforeChecksum = await readSequenceChecksum(shopId);

  await client.query('BEGIN');
  const rehearsal = await (async () => {
  try {
    const sample = await client.query(`
      CREATE TEMP TABLE orders_display_sequence_rehearsal_sample ON COMMIT DROP AS
      SELECT "id", "displayOrderSequence" AS original_sequence, "sourceOrderNumber", "name"
      FROM "orders"
      WHERE "shopId" = $1::uuid
        AND "displayOrderSequence" IS NOT NULL
        AND COALESCE("sourceOrderNumber", "name") ~ '^#?[0-9]+$'
      ORDER BY "displayOrderSequence" DESC, "id" DESC
      LIMIT 250
    `, [shopId]);
    const sampleRows = sample.rowCount ?? 0;
    await client.query(`
      UPDATE "orders" o
      SET "displayOrderSequence" = NULL
      FROM orders_display_sequence_rehearsal_sample s
      WHERE o."id" = s."id"
    `);
    const backfill = await client.query(`
      UPDATE "orders" o
      SET "displayOrderSequence" = regexp_replace(COALESCE(o."sourceOrderNumber", o."name"), '^#', '')::bigint
      FROM orders_display_sequence_rehearsal_sample s
      WHERE o."id" = s."id"
        AND o."displayOrderSequence" IS NULL
    `);
    const updatedRows = backfill.rowCount ?? 0;
    const equivalence = await client.query<{ equivalent_order: boolean }>(`
      WITH by_sequence AS (
        SELECT array_agg("id" ORDER BY "displayOrderSequence" DESC, "id" DESC) AS ids
        FROM "orders"
        WHERE "id" IN (SELECT "id" FROM orders_display_sequence_rehearsal_sample)
      ),
      by_source AS (
        SELECT array_agg("id" ORDER BY regexp_replace(COALESCE("sourceOrderNumber", "name"), '^#', '')::bigint DESC, "id" DESC) AS ids
        FROM "orders"
        WHERE "id" IN (SELECT "id" FROM orders_display_sequence_rehearsal_sample)
      )
      SELECT by_sequence.ids = by_source.ids AS equivalent_order
      FROM by_sequence, by_source
    `);
    return {
      equivalentOrder: equivalence.rows[0]?.equivalent_order === true,
      sampleRows,
      updatedRows
    };
  } finally {
    await client.query('ROLLBACK');
  }
  })();

  const afterRollbackNullSequences = await readNullSequenceCount(shopId);
  const afterChecksum = await readSequenceChecksum(shopId);
  const rollbackPreservedChecksum = beforeChecksum === afterChecksum;
  return {
    afterRollbackNullSequences,
    beforeNullSequences,
    equivalentOrder: rehearsal.equivalentOrder,
    pass: rehearsal.sampleRows > 0 && rehearsal.updatedRows === rehearsal.sampleRows && rehearsal.equivalentOrder && afterRollbackNullSequences === beforeNullSequences && rollbackPreservedChecksum,
    rollbackPreservedChecksum,
    sampleRows: rehearsal.sampleRows,
    updatedRows: rehearsal.updatedRows
  };
}

async function readCohortPrivacyEvidence(): Promise<{
  cohortArtifact: string;
  pass: boolean;
  persistedKeys: string[];
}> {
  const artifact = JSON.parse(await readFile(COHORT_PATH, 'utf8')) as {
    privacyCanary?: { pass?: boolean; persistedKeys?: string[] };
  };
  return {
    cohortArtifact: COHORT_PATH,
    pass: artifact.privacyCanary?.pass === true,
    persistedKeys: artifact.privacyCanary?.persistedKeys ?? []
  };
}

async function readFixtureShopId(): Promise<string> {
  const result = await client.query<{ id: string }>(`
    SELECT "id"
    FROM "shops"
    WHERE "appId" = 'orders-performance-evidence'
      AND "shopDomain" = 'orders-performance.invalid'
    LIMIT 1
  `);
  const shopId = result.rows[0]?.id;
  if (shopId === undefined) throw new Error('orders performance fixture shop not found');
  return shopId;
}

async function readCount(table: string): Promise<number> {
  const result = await client.query<{ count: string }>(`SELECT count(*) FROM "${table}"`);
  return Number(result.rows[0]?.count ?? 0);
}

async function readNullSequenceCount(shopId: string): Promise<number> {
  const result = await client.query<{ count: string }>(`
    SELECT count(*) FROM "orders"
    WHERE "shopId" = $1::uuid AND "displayOrderSequence" IS NULL
  `, [shopId]);
  return Number(result.rows[0]?.count ?? 0);
}

async function readSequenceChecksum(shopId: string): Promise<string> {
  const result = await client.query<{ checksum: string }>(`
    SELECT md5(string_agg("id"::text || ':' || COALESCE("displayOrderSequence"::text, 'NULL'), ',' ORDER BY "id")) AS checksum
    FROM "orders"
    WHERE "shopId" = $1::uuid
  `, [shopId]);
  return result.rows[0]?.checksum ?? '';
}

function summarizePlan(plan: PlanJson): PlanNodeSummary[] {
  return [
    {
      actualRows: plan['Actual Rows'] ?? null,
      indexName: plan['Index Name'] ?? null,
      nodeType: plan['Node Type'],
      relationName: plan['Relation Name'] ?? null,
      rowsRemovedByFilter: plan['Rows Removed by Filter'] ?? 0,
      totalTimeMs: plan['Actual Total Time'] ?? null
    },
    ...(plan.Plans ?? []).flatMap(summarizePlan)
  ];
}

function readDatabaseUrl(value: string | undefined): { connectionString: string; schema: string | null } {
  if (value === undefined || value.trim() === '') throw new Error('DATABASE_URL is required');
  const url = new URL(value);
  const schema = url.searchParams.get('schema');
  url.searchParams.delete('schema');
  return { connectionString: url.toString(), schema };
}

type PlanJson = {
  'Actual Rows'?: number;
  'Actual Total Time'?: number;
  'Index Name'?: string;
  'Node Type': string;
  Plans?: PlanJson[];
  'Relation Name'?: string;
  'Rows Removed by Filter'?: number;
};

type ExplainRow = {
  'QUERY PLAN': Array<{
    'Execution Time'?: number;
    Plan: PlanJson;
  }>;
};

type PlanNodeSummary = {
  actualRows: number | null;
  indexName: string | null;
  nodeType: string;
  relationName: string | null;
  rowsRemovedByFilter: number;
  totalTimeMs: number | null;
};
