import { describe, expect, test, vi } from 'vitest';

import { runShopCenterTimezoneBackfill } from '../src/scripts/backfill-shop-center-timezone.js';

function prismaWith(shops: Array<Record<string, unknown>>) {
  return {
    shop: {
      findMany: vi.fn(() => Promise.resolve(shops)),
      update: vi.fn(() => Promise.resolve({}))
    }
  };
}

const seoul = { appId: 'clever', defaultDepotLatitude: '37.3329463', defaultDepotLongitude: '126.9381069', defaultDepotTimezone: null, id: 'shop-seoul', shopDomain: 'dsv-demo.local' };
const toronto = { appId: 'clever-route-kfood', defaultDepotLatitude: '43.7638824', defaultDepotLongitude: '-79.4760912', defaultDepotTimezone: null, id: 'shop-toronto', shopDomain: '7hrud1-xq.myshopify.com' };
const done = { ...toronto, defaultDepotTimezone: 'America/Toronto', id: 'shop-done' };

describe('shop center timezone backfill', () => {
  test('dry-run reports changes and writes nothing', async () => {
    const prisma = prismaWith([seoul, toronto, done]);
    const changes = await runShopCenterTimezoneBackfill(prisma as never, { apply: false }, () => undefined);
    expect(changes.map((change) => [change.id, change.to])).toEqual([['shop-seoul', 'Asia/Seoul'], ['shop-toronto', 'America/Toronto']]);
    expect(prisma.shop.update).not.toHaveBeenCalled();
  });

  test('apply writes only the shops whose value differs', async () => {
    const prisma = prismaWith([seoul, done]);
    await runShopCenterTimezoneBackfill(prisma as never, { apply: true }, () => undefined);
    expect(prisma.shop.update).toHaveBeenCalledOnce();
    expect(prisma.shop.update).toHaveBeenCalledWith({ data: { defaultDepotTimezone: 'Asia/Seoul' }, where: { id: 'shop-seoul' } });
  });
});
