import { PrismaClient } from '@prisma/client';

import { centerTimezoneFromCoordinates } from '../modules/route-ops/route-timezone.js';

// One-off: fill shops.defaultDepotTimezone for centers saved before the column existed.
// New saves compute it themselves. Only rows whose value differs are touched.
// Default is dry-run. Pass --apply to write.

export type ShopCenterTimezoneChange = {
  appId: string;
  from: string | null;
  id: string;
  shopDomain: string;
  to: string;
};

type BackfillPrisma = Pick<PrismaClient, 'shop'>;

export async function planShopCenterTimezoneChanges(prisma: BackfillPrisma): Promise<ShopCenterTimezoneChange[]> {
  const shops = await prisma.shop.findMany({
    orderBy: [{ appId: 'asc' }, { shopDomain: 'asc' }],
    select: {
      appId: true,
      defaultDepotLatitude: true,
      defaultDepotLongitude: true,
      defaultDepotTimezone: true,
      id: true,
      shopDomain: true
    },
    where: { defaultDepotLatitude: { not: null }, defaultDepotLongitude: { not: null } }
  });
  return shops.flatMap((shop): ShopCenterTimezoneChange[] => {
    const to = centerTimezoneFromCoordinates(Number(shop.defaultDepotLatitude), Number(shop.defaultDepotLongitude));
    return to === null || to === shop.defaultDepotTimezone
      ? []
      : [{ appId: shop.appId, from: shop.defaultDepotTimezone, id: shop.id, shopDomain: shop.shopDomain, to }];
  });
}

export async function runShopCenterTimezoneBackfill(
  prisma: BackfillPrisma,
  options: { apply: boolean },
  log: (line: string) => void = console.log
): Promise<ShopCenterTimezoneChange[]> {
  const changes = await planShopCenterTimezoneChanges(prisma);
  for (const change of changes) {
    log(`${options.apply ? 'set' : 'would set'} ${change.appId} ${change.shopDomain}: ${change.from ?? 'null'} -> ${change.to}`);
    if (options.apply) {
      await prisma.shop.update({ data: { defaultDepotTimezone: change.to }, where: { id: change.id } });
    }
  }
  log(`${changes.length} shop(s) ${options.apply ? 'updated' : 'would change (dry-run, pass --apply to write)'}`);
  return changes;
}

if (process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], 'file:').href) {
  const unknown = process.argv.slice(2).filter((flag) => flag !== '--apply');
  if (unknown.length > 0) throw new Error(`Unknown flag ${unknown[0]}`);
  const prisma = new PrismaClient();
  try {
    await runShopCenterTimezoneBackfill(prisma, { apply: process.argv.includes('--apply') });
  } finally {
    await prisma.$disconnect();
  }
}
