import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import { afterAll, describe, expect, test } from 'vitest';

const databaseUrl = process.env.SHOPIFY_WEBHOOK_DURABILITY_DATABASE_URL;
const enabled = process.env.SHOP_PRIVACY_INVARIANT_DATABASE_TARGET_CLASS === 'safe-local-disposable'
  && databaseUrl?.includes('127.0.0.1') === true;
const describeDatabase = enabled ? describe : describe.skip;
const migrationPath = new URL(
  '../prisma/migrations/20260825120000_enforce_shop_privacy_tombstone/migration.sql',
  import.meta.url
);
const clients: Client[] = [];

describeDatabase('shop privacy database invariant', () => {
  afterAll(async () => {
    await Promise.all(clients.map((client) => client.end()));
  });

  test('canonicalizes case, protocol, whitespace, and trailing slashes on both boundaries', async () => {
    const schema = await createIsolatedSchema();
    const client = await connect(schema);
    await installMigration(client);

    await client.query(`INSERT INTO shopify_shop_redaction_tombstones
      (id, "appId", "shopDomain", "reinstalledAt") VALUES ($1, $2, $3, NULL)`,
    [randomUUID(), ' Clever ', ' HTTPS://Case-Guard.MyShopify.Com/// ']);

    await expect(commitInsertShop(client, 'clever', 'case-guard.myshopify.com/private-path'))
      .rejects.toThrow('Shop write blocked by active privacy tombstone');

    await client.query(`INSERT INTO shops (id, "appId", "shopDomain") VALUES ($1, $2, $3)`,
      [randomUUID(), 'clever', 'second-guard.myshopify.com']);
    await expect(commitInsertTombstone(client, ' CLEVER ', 'https://SECOND-GUARD.myshopify.com/'))
      .rejects.toThrow('Shop write blocked by active privacy tombstone');

    await client.query(`INSERT INTO shopify_shop_redaction_tombstones
      (id, "appId", "shopDomain", "reinstalledAt") VALUES ($1, 'clever', 'second-guard.myshopify.com', now())`,
    [randomUUID()]);
    await client.query('BEGIN');
    await client.query(`UPDATE shopify_shop_redaction_tombstones SET "reinstalledAt" = NULL
      WHERE "shopDomain" = 'second-guard.myshopify.com'`);
    await expect(client.query('COMMIT')).rejects.toThrow('Shop write blocked by active privacy tombstone');

    const updateDomain = 'shop-update-guard.myshopify.com';
    await client.query(`INSERT INTO shops (id, "appId", "shopDomain") VALUES ($1, 'clever', $2)`,
      [randomUUID(), updateDomain]);
    // Bootstrap an impossible post-migration state with owner-only DDL so the
    // Shop UPDATE boundary itself is exercised, then immediately remove it.
    await client.query('ALTER TABLE shopify_shop_redaction_tombstones DISABLE TRIGGER shop_tombstones_privacy_identity_consistency');
    await client.query(`INSERT INTO shopify_shop_redaction_tombstones
      (id, "appId", "shopDomain", "reinstalledAt") VALUES ($1, 'clever', $2, NULL)`,
    [randomUUID(), updateDomain]);
    await client.query('ALTER TABLE shopify_shop_redaction_tombstones ENABLE TRIGGER shop_tombstones_privacy_identity_consistency');
    await client.query('BEGIN');
    await client.query(`UPDATE shops SET locale = 'en' WHERE "shopDomain" = $1`, [updateDomain]);
    await expect(client.query('COMMIT')).rejects.toThrow('Shop write blocked by active privacy tombstone');
    await client.query(`DELETE FROM shopify_shop_redaction_tombstones WHERE "shopDomain" = $1`, [updateDomain]);
  });

  test('serializes tombstone-first and Shop-first concurrent transactions', async () => {
    const schema = await createIsolatedSchema();
    const first = await connect(schema);
    const second = await connect(schema);
    const observer = await connect(schema);
    await installMigration(first);

    await first.query('BEGIN');
    await first.query(`INSERT INTO shopify_shop_redaction_tombstones
      (id, "appId", "shopDomain", "reinstalledAt") VALUES ($1, 'clever', 'tombstone-first.myshopify.com', NULL)`,
    [randomUUID()]);
    await second.query('BEGIN');
    const secondPid = Number((await second.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid);
    const blockedShopInsert = second.query(`INSERT INTO shops (id, "appId", "shopDomain")
      VALUES ($1, 'clever', 'TOMBSTONE-FIRST.myshopify.com')`, [randomUUID()]);
    await waitForLock(observer, secondPid);
    await first.query('COMMIT');
    await blockedShopInsert;
    await expect(second.query('COMMIT')).rejects.toThrow('Shop write blocked by active privacy tombstone');

    await first.query('BEGIN');
    await first.query(`INSERT INTO shops (id, "appId", "shopDomain")
      VALUES ($1, 'clever', 'shop-first.myshopify.com')`, [randomUUID()]);
    await second.query('ROLLBACK');
    await second.query('BEGIN');
    const blockedTombstoneInsert = second.query(`INSERT INTO shopify_shop_redaction_tombstones
      (id, "appId", "shopDomain", "reinstalledAt")
      VALUES ($1, 'clever', 'https://SHOP-FIRST.myshopify.com/', NULL)`, [randomUUID()]);
    await waitForLock(observer, secondPid);
    await first.query('COMMIT');
    await blockedTombstoneInsert;
    await expect(second.query('COMMIT')).rejects.toThrow('Shop write blocked by active privacy tombstone');

    const overlap = await observer.query<{ count: number }>(`SELECT count(*)::integer AS count
      FROM shops AS shop
      INNER JOIN shopify_shop_redaction_tombstones AS tombstone
        ON lower(btrim(shop."appId")) = lower(btrim(tombstone."appId"))
        AND regexp_replace(regexp_replace(lower(btrim(shop."shopDomain")), '^https?://', '', 'i'), '/.*$', '')
          = regexp_replace(regexp_replace(lower(btrim(tombstone."shopDomain")), '^https?://', '', 'i'), '/.*$', '')
      WHERE tombstone."reinstalledAt" IS NULL`);
    expect(overlap.rows[0]?.count).toBe(0);
  });

  test('locks both tables while installing the migration so queued writes cannot cross the gap', async () => {
    const schema = await createIsolatedSchema();
    const blocker = await connect(schema);
    const migrator = await connect(schema);
    const writer = await connect(schema);
    const observer = await connect(schema);

    await blocker.query('BEGIN');
    await blocker.query(`INSERT INTO shopify_shop_redaction_tombstones
      (id, "appId", "shopDomain", "reinstalledAt") VALUES ($1, 'clever', 'install-gap.myshopify.com', NULL)`,
    [randomUUID()]);

    const migratorPid = Number((await migrator.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid);
    const migration = installMigration(migrator);
    await waitForLock(observer, migratorPid);

    await writer.query('BEGIN');
    const writerPid = Number((await writer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid);
    const queuedWrite = writer.query(`INSERT INTO shops (id, "appId", "shopDomain")
      VALUES ($1, 'clever', 'INSTALL-GAP.myshopify.com/')`, [randomUUID()]);
    await waitForLock(observer, writerPid);

    await blocker.query('COMMIT');
    await migration;
    await queuedWrite;
    await expect(writer.query('COMMIT')).rejects.toThrow('Shop write blocked by active privacy tombstone');
  });

  test('fails populated migration closed on a canonical pre-existing overlap', async () => {
    const schema = await createIsolatedSchema();
    const client = await connect(schema);
    await client.query(`INSERT INTO shops (id, "appId", "shopDomain")
      VALUES ($1, 'clever', 'precheck-guard.myshopify.com')`, [randomUUID()]);
    await client.query(`INSERT INTO shopify_shop_redaction_tombstones
      (id, "appId", "shopDomain", "reinstalledAt")
      VALUES ($1, ' CLEVER ', 'HTTPS://PRECHECK-GUARD.MyShopify.Com/private/', NULL)`, [randomUUID()]);

    await expect(installMigration(client))
      .rejects.toThrow('Cannot enforce Shop privacy invariant while an active tombstone has a Shop row');
  });
});

async function createIsolatedSchema(): Promise<string> {
  const schema = `privacy_${randomUUID().replaceAll('-', '')}`;
  const client = await connect();
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET search_path TO "${schema}"`);
  await client.query(`CREATE TABLE shops (
    id UUID PRIMARY KEY,
    "appId" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    locale TEXT
  )`);
  await client.query(`CREATE TABLE shopify_shop_redaction_tombstones (
    id UUID PRIMARY KEY,
    "appId" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "reinstalledAt" TIMESTAMPTZ
  )`);
  return schema;
}

async function connect(schema?: string): Promise<Client> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  clients.push(client);
  if (schema !== undefined) await client.query(`SET search_path TO "${schema}"`);
  return client;
}

async function installMigration(client: Client): Promise<void> {
  const sql = await readFile(migrationPath, 'utf8');
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function commitInsertShop(client: Client, appId: string, shopDomain: string): Promise<void> {
  await client.query('BEGIN');
  await client.query(`INSERT INTO shops (id, "appId", "shopDomain") VALUES ($1, $2, $3)`,
    [randomUUID(), appId, shopDomain]);
  await client.query('COMMIT');
}

async function commitInsertTombstone(client: Client, appId: string, shopDomain: string): Promise<void> {
  await client.query('BEGIN');
  await client.query(`INSERT INTO shopify_shop_redaction_tombstones
    (id, "appId", "shopDomain", "reinstalledAt") VALUES ($1, $2, $3, NULL)`,
  [randomUUID(), appId, shopDomain]);
  await client.query('COMMIT');
}

async function waitForLock(observer: Client, pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await observer.query<{ wait_event_type: string | null }>(
      `SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1`,
      [pid]
    );
    if (result.rows[0]?.wait_event_type === 'Lock') return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Backend ${pid} did not block on the privacy identity lock`);
}
