import { PrismaClient, type Prisma } from '@prisma/client';

import { dsvDestinationIdentity, dsvRoadAddressBase, hasDsvRoadAddress } from '../modules/dsv/dsv-destination-identity.js';

import {
  buildCanonicalDestinationProjection,
  canonicalDestinationProfileSelect,
  fromDriverDestinationNotes,
  type CanonicalDestinationProfileRecord,
  type DriverDestinationNotes
} from '../modules/driver/driver-destination-notes.repository.js';

// Backfill after an identity-key change: legacy duplicate DSV destination
// profiles (same shop, same dsvDestinationIdentity key) collapse into the
// oldest profile. New imports already match by that key, so this only
// repairs rows written before the key changed. The driver app
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

export type RoadAddressRewrite = {
  fromAddress: string;
  id: string;
  shopId: string;
  toAddress: string;
};

export type DestinationMergeReport = DestinationMergeGroup & {
  orderCounts: Record<string, number>;
  shopDomain: string;
};

export type DestinationMergePrisma = Pick<PrismaClient, 'shop' | 'deliveryCustomerProfile' | 'order' | '$transaction'>;
type MergeTx = Pick<Prisma.TransactionClient, 'deliveryCustomerProfile' | 'order' | 'dsvDispatchImportRow' | 'destinationTip'>;


// The survivor is the most-used spelling (most orders), then the oldest, so
// the destination list keeps showing the address drivers already know.
export function planDestinationMerges(
  shopId: string,
  profiles: CanonicalDestinationProfileRecord[],
  orderCount: (id: string) => number = () => 0
): DestinationMergeGroup[] {
  const groups: DestinationMergeGroup[] = [];
  const seen = new Set<string>();
  for (const projection of buildCanonicalDestinationProjection(profiles).values()) {
    if (projection.memberIds.length < 2 || seen.has(projection.destinationId)) continue;
    seen.add(projection.destinationId);
    const survivorId = projection.memberIds.reduce((best, id) => orderCount(id) > orderCount(best) ? id : best);
    groups.push({ mergedIds: projection.memberIds.filter((id) => id !== survivorId), notes: projection.notes, shopId, survivorId });
  }
  return groups;
}

// Repoints the FKs that drive today's UI (orders, import rows, tips) and keeps
// dsv_audit_events / profile order links on the old id: audit rows are history and
// order links already follow mergedIntoProfileId chains in the profile service.
// Legacy jibun-only rows (stored before imports re-resolved them to road
// addresses) cannot share an identity key with their road-address twin. A row
// is rewritten only when exactly one road address with the same name carries
// the same 동/리 lot number as its geocoded jibun.
export function planRoadAddressRewrites(shopId: string, profiles: CanonicalDestinationProfileRecord[]): RoadAddressRewrite[] {
  const roadRows = profiles.filter((profile) => hasDsvRoadAddress(addressOf(profile).address));
  return profiles.flatMap((profile) => {
    const { address } = addressOf(profile);
    const parcel = parcelKey(address);
    if (address === '' || hasDsvRoadAddress(address) || parcel === null) return [];
    const name = identityOf(profile).name;
    const twins = roadRows.filter((row) => row.isStoreReviewData === profile.isStoreReviewData
      && identityOf(row).name === name && parcelKey(addressOf(row).jibunAddress) === parcel);
    const twin = twins[0];
    if (twin === undefined || new Set(twins.map((row) => identityOf(row).address)).size !== 1) return [];
    const toAddress = dsvRoadAddressBase(addressOf(twin).address);
    return toAddress === null ? [] : [{ fromAddress: address, id: profile.id, shopId, toAddress }];
  });
}

function withRewrites(profiles: CanonicalDestinationProfileRecord[], rewrites: RoadAddressRewrite[]): CanonicalDestinationProfileRecord[] {
  const byId = new Map(rewrites.map((rewrite) => [rewrite.id, rewrite]));
  return profiles.map((profile) => {
    const rewrite = byId.get(profile.id);
    return rewrite === undefined ? profile : { ...profile, normalizedAddress: rewrittenAddress(profile.normalizedAddress, rewrite) };
  });
}

function rewrittenAddress(value: unknown, rewrite: RoadAddressRewrite): Prisma.InputJsonObject {
  return { ...jsonRecord(value), address: rewrite.toAddress, jibunAddress: rewrite.fromAddress };
}

const parcelPattern = /([가-힣]+(?:동|리))\s*([0-9]+가)?\s*(산\s*)?([0-9]+(?:-[0-9]+)?)/u;

function parcelKey(text: string | null): string | null {
  const match = parcelPattern.exec((text ?? '').normalize('NFKC'));
  return match === null ? null : `${match[1]}${match[2] ?? ''}${match[3] === undefined ? '' : '산'}${match[4]}`;
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function addressOf(profile: CanonicalDestinationProfileRecord): { address: string; detailAddress: string | null; jibunAddress: string | null; name: string | null } {
  const row = jsonRecord(profile.normalizedAddress);
  const text = (key: string): string | null => typeof row[key] === 'string' && row[key].trim() !== '' ? row[key].trim() : null;
  return {
    address: text('address') ?? text('address1') ?? '',
    detailAddress: text('detailAddress') ?? text('address2'),
    jibunAddress: text('jibunAddress'),
    name: text('name')
  };
}

function identityOf(profile: CanonicalDestinationProfileRecord): { address: string; name: string } {
  const address = addressOf(profile);
  return dsvDestinationIdentity({
    address: address.address,
    detailAddress: address.detailAddress,
    destinationName: profile.canonicalName ?? address.name ?? profile.id
  });
}

export async function applyDestinationMerge(tx: MergeTx, group: DestinationMergeGroup): Promise<{ importRows: number; orders: number; tips: number }> {
  const where = { destinationId: { in: group.mergedIds }, shopId: group.shopId };
  const data = { destinationId: group.survivorId };
  const [orders, importRows, tips] = await Promise.all([
    tx.order.updateMany({ data, where }),
    tx.dsvDispatchImportRow.updateMany({ data, where }),
    tx.destinationTip.updateMany({ data, where })
  ]);
  // Rows merged earlier into one of these ids follow them to the new survivor,
  // so every merge chain stays one step long.
  await tx.deliveryCustomerProfile.updateMany({
    data: { mergedIntoProfileId: group.survivorId },
    where: { OR: [{ id: { in: group.mergedIds } }, { mergedIntoProfileId: { in: group.mergedIds } }], shopId: group.shopId }
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
  let rewriteCount = 0;
  for (const shop of shops) {
    const profiles = await prisma.deliveryCustomerProfile.findMany({
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: canonicalDestinationProfileSelect,
      where: { mergedIntoProfileId: null, shopId: shop.id }
    });
    const counted = await prisma.order.groupBy({
      _count: { _all: true },
      by: ['destinationId'],
      where: { destinationId: { in: profiles.map((profile) => profile.id) }, shopId: shop.id }
    });
    const orderCount = new Map(counted.map((row) => [row.destinationId, row._count._all]));
    const rewrites = planRoadAddressRewrites(shop.id, profiles);
    const groups = planDestinationMerges(shop.id, withRewrites(profiles, rewrites), (id) => orderCount.get(id) ?? 0);
    for (const rewrite of rewrites) write(JSON.stringify({ mode: input.apply ? 'apply' : 'dry-run', rewrite }));
    rewriteCount += rewrites.length;
    if (groups.length === 0 && rewrites.length === 0) continue;
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
      const rewritten = new Map(profiles.map((profile) => [profile.id, profile.normalizedAddress]));
      await prisma.$transaction(async (tx) => {
        for (const rewrite of rewrites) {
          await tx.deliveryCustomerProfile.update({
            data: { normalizedAddress: rewrittenAddress(rewritten.get(rewrite.id), rewrite) },
            where: { id: rewrite.id }
          });
        }
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
    roadAddressRewrites: rewriteCount,
    shops: shops.length,
    wroteDatabaseRows: input.apply && (reports.length > 0 || rewriteCount > 0)
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
