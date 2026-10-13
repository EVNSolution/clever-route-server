import { PrismaClient, type Prisma } from '@prisma/client';

import {
  buildCanonicalDestinationProjection,
  canonicalDestinationProfileSelect,
  fromDriverDestinationNotes,
  type CanonicalDestinationProfileRecord,
  type DriverDestinationNotes
} from '../modules/driver/driver-destination-notes.repository.js';

// One-off repair: legacy duplicate DSV destination profiles (same shop, same
// dsvDestinationIdentity key) collapse into the oldest profile. The driver app
// already projects duplicates onto that profile in memory
// (buildCanonicalDestinationProjection); this script persists the same choice so
// the control page, which groups stops by orders.destinationId, stops splitting them.
// Default is dry-run. Pass --apply to write.

export type DestinationMergeGroup = {
  mergedIds: string[];
  notes: DriverDestinationNotes;
  shopId: string;
  survivorId: string;
};

export type DestinationMergeReport = DestinationMergeGroup & {
  orderCounts: Record<string, number>;
  shopDomain: string;
};

export type DestinationMergePrisma = Pick<PrismaClient, 'shop' | 'deliveryCustomerProfile' | 'order' | '$transaction'>;
type MergeTx = Pick<Prisma.TransactionClient, 'deliveryCustomerProfile' | 'order' | 'dsvDispatchImportRow' | 'destinationTip'>;

export function planDestinationMerges(shopId: string, profiles: CanonicalDestinationProfileRecord[]): DestinationMergeGroup[] {
  const groups: DestinationMergeGroup[] = [];
  const seen = new Set<string>();
  for (const projection of buildCanonicalDestinationProjection(profiles).values()) {
    if (projection.memberIds.length < 2 || seen.has(projection.destinationId)) continue;
    seen.add(projection.destinationId);
    groups.push({ mergedIds: projection.memberIds.slice(1), notes: projection.notes, shopId, survivorId: projection.destinationId });
  }
  return groups;
}

// Repoints the FKs that drive today's UI (orders, import rows, tips) and keeps
// dsv_audit_events / profile order links on the old id: audit rows are history and
// order links already follow mergedIntoProfileId chains in the profile service.
export async function applyDestinationMerge(tx: MergeTx, group: DestinationMergeGroup): Promise<{ importRows: number; orders: number; tips: number }> {
  const where = { destinationId: { in: group.mergedIds }, shopId: group.shopId };
  const data = { destinationId: group.survivorId };
  const [orders, importRows, tips] = await Promise.all([
    tx.order.updateMany({ data, where }),
    tx.dsvDispatchImportRow.updateMany({ data, where }),
    tx.destinationTip.updateMany({ data, where })
  ]);
  await tx.deliveryCustomerProfile.updateMany({
    data: { mergedIntoProfileId: group.survivorId },
    where: { id: { in: group.mergedIds }, shopId: group.shopId }
  });
  const { id, ...notes } = fromDriverDestinationNotes(group.notes, group.survivorId);
  await tx.deliveryCustomerProfile.update({ data: notes, where: { id } });
  return { importRows: importRows.count, orders: orders.count, tips: tips.count };
}

export async function runDestinationMergeRepair(
  prisma: DestinationMergePrisma,
  input: { apply: boolean; shopIds: string[] },
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`)
): Promise<DestinationMergeReport[]> {
  const shops = await prisma.shop.findMany({
    orderBy: { id: 'asc' },
    select: { id: true, shopDomain: true },
    where: input.shopIds.length > 0 ? { id: { in: input.shopIds } } : {}
  });
  const reports: DestinationMergeReport[] = [];
  for (const shop of shops) {
    const profiles = await prisma.deliveryCustomerProfile.findMany({
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: canonicalDestinationProfileSelect,
      where: { mergedIntoProfileId: null, shopId: shop.id }
    });
    const groups = planDestinationMerges(shop.id, profiles);
    if (groups.length === 0) continue;
    const counted = await prisma.order.groupBy({
      _count: { _all: true },
      by: ['destinationId'],
      where: { destinationId: { in: groups.flatMap((group) => [group.survivorId, ...group.mergedIds]) }, shopId: shop.id }
    });
    const orderCount = new Map(counted.map((row) => [row.destinationId, row._count._all]));
    for (const group of groups) {
      const report = {
        ...group,
        orderCounts: Object.fromEntries([group.survivorId, ...group.mergedIds].map((id) => [id, orderCount.get(id) ?? 0])),
        shopDomain: shop.shopDomain
      };
      reports.push(report);
      write(JSON.stringify({ mode: input.apply ? 'apply' : 'dry-run', ...report }));
    }
    if (input.apply) {
      await prisma.$transaction(async (tx) => {
        for (const group of groups) {
          write(JSON.stringify({ applied: await applyDestinationMerge(tx, group), survivorId: group.survivorId }));
        }
      });
    }
  }
  write(JSON.stringify({
    groups: reports.length,
    mergedProfiles: reports.reduce((sum, report) => sum + report.mergedIds.length, 0),
    mode: input.apply ? 'apply' : 'dry-run',
    shops: shops.length,
    wroteDatabaseRows: input.apply && reports.length > 0
  }));
  return reports;
}

export function parseFlags(argv: string[]): { apply: boolean; shopIds: string[] } {
  const flags = { apply: false, shopIds: [] as string[] };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--apply') { flags.apply = true; continue; }
    if (key === '--dry-run') continue;
    if (key === '--shop-id') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error('Missing value for --shop-id');
      flags.shopIds.push(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown flag ${key}`);
  }
  return flags;
}

if (process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], 'file:').href) {
  const prisma = new PrismaClient();
  try {
    await runDestinationMergeRepair(prisma, parseFlags(process.argv.slice(2)));
  } finally {
    await prisma.$disconnect();
  }
}
