import { statSync } from 'node:fs';

import { PrismaClient } from '@prisma/client';

// One-off: remove leftover test/demo/duplicate shops (and, by foreign-key cascade, every row hanging off them).
// Only the explicit LEFTOVER_SHOPS below can be deleted, and the KEEP_SHOPS must still exist.
// Default is dry-run (counts only, no write). --apply needs --backup <file>: a non-empty pg_dump file made in the
// last 24 hours. Each shop is deleted in its own transaction, so a blocked foreign key rolls that shop back whole.

export type ShopKey = { appId: string; shopDomain: string };

export const KEEP_SHOPS: ShopKey[] = [
  { appId: 'clever', shopDomain: 'dsv-demo.local' },
  { appId: 'clever-route-kfood', shopDomain: '7hrud1-xq.myshopify.com' }
];

export const LEFTOVER_SHOPS: ShopKey[] = [
  { appId: 'clever', shopDomain: 'tomatonofood.com' },
  { appId: 'clever', shopDomain: '7hrud1-xq.myshopify.com' },
  { appId: 'clever-route-kfood-private-demo', shopDomain: '7hrud1-xq.myshopify.com' },
  { appId: 'clever', shopDomain: 'clever-test-syhae28n.myshopify.com' },
  { appId: 'clever-route-dev', shopDomain: 'clever-test-syhae28n.myshopify.com' },
  { appId: 'clever-route-kfood', shopDomain: 'kfood-smoke.myshopify.com' },
  { appId: 'clever', shopDomain: 'cc295-live-contract-12c1906c-8133-411b-985b-27dea1fbe0fc.myshopify.com' }
];

const BACKUP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

type CleanupPrisma = Pick<PrismaClient, 'shop' | '$queryRaw' | '$transaction'>;

export type LeftoverShopReport = ShopKey & { id: string; rows: Array<{ table: string; count: number }> };

const sameShop = (left: ShopKey, right: ShopKey): boolean =>
  left.appId === right.appId && left.shopDomain === right.shopDomain;

export function assertBackupFile(backupFile: string | null, now: Date = new Date()): void {
  if (backupFile === null) throw new Error('--apply needs --backup <pg_dump file>');
  const stat = statSync(backupFile, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isFile() || stat.size === 0) throw new Error(`Backup file is missing or empty: ${backupFile}`);
  if (now.getTime() - stat.mtime.getTime() > BACKUP_MAX_AGE_MS) throw new Error(`Backup file is older than 24 hours: ${backupFile}`);
}

export async function planLeftoverShopCleanup(prisma: CleanupPrisma): Promise<LeftoverShopReport[]> {
  for (const target of LEFTOVER_SHOPS) {
    if (KEEP_SHOPS.some((keep) => sameShop(keep, target))) throw new Error(`Refusing: ${target.appId} ${target.shopDomain} is a kept shop`);
  }
  for (const keep of KEEP_SHOPS) {
    const found = await prisma.shop.findUnique({ select: { id: true }, where: { appId_shopDomain: keep } });
    if (found === null) throw new Error(`Refusing: kept shop ${keep.appId} ${keep.shopDomain} does not exist`);
  }
  const reports: LeftoverShopReport[] = [];
  for (const target of LEFTOVER_SHOPS) {
    const shop = await prisma.shop.findUnique({ select: { id: true }, where: { appId_shopDomain: target } });
    if (shop === null) continue;
    const rows = await prisma.$queryRaw<Array<{ count: number; table: string }>>`
      SELECT fk.t AS "table",
        (xpath('/row/c/text()', query_to_xml(format('select count(*) c from %I where "shopId" = %L', fk.t, ${shop.id}::text), false, true, '')))[1]::text::int AS "count"
      FROM (
        SELECT DISTINCT kcu.table_name AS t
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
        JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name = 'shops' AND kcu.column_name = 'shopId' AND tc.table_schema = 'public'
      ) fk`;
    reports.push({ ...target, id: shop.id, rows: rows.filter((row) => row.count > 0).sort((a, b) => b.count - a.count).map(({ table, count }) => ({ count, table })) });
  }
  return reports;
}

export async function runLeftoverShopCleanup(
  prisma: CleanupPrisma,
  options: { apply: boolean; backupFile: string | null },
  log: (line: string) => void = console.log
): Promise<LeftoverShopReport[]> {
  if (options.apply) assertBackupFile(options.backupFile);
  const reports = await planLeftoverShopCleanup(prisma);
  for (const report of reports) {
    const total = report.rows.reduce((sum, row) => sum + row.count, 0);
    log(`${options.apply ? 'delete' : 'would delete'} ${report.appId} ${report.shopDomain}: ${total} dependent row(s)`);
    log(`  ${report.rows.map((row) => `${row.table}=${row.count}`).join(', ') || '(none)'}`);
    if (options.apply) {
      await prisma.$transaction(async (tx) => { await tx.shop.delete({ where: { id: report.id } }); }, { timeout: 300_000 });
      log('  deleted');
    }
  }
  log(`${reports.length} shop(s) ${options.apply ? 'deleted' : 'would be deleted (dry-run, pass --apply --backup <file> to delete)'}`);
  return reports;
}

function parseArgs(argv: string[]): { apply: boolean; backupFile: string | null } {
  let apply = false;
  let backupFile: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--apply') apply = true;
    else if (flag === '--backup') {
      backupFile = argv[index + 1] ?? null;
      if (backupFile === null || backupFile.startsWith('--')) throw new Error('Missing value for --backup');
      index += 1;
    } else throw new Error(`Unknown flag ${flag}`);
  }
  return { apply, backupFile };
}

if (process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], 'file:').href) {
  const options = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  try {
    await runLeftoverShopCleanup(prisma, options);
  } finally {
    await prisma.$disconnect();
  }
}
