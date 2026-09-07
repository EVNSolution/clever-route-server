import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';

// This repair classifies the existing two-stop Play review fixture; it never creates accounts or resets credentials.
const prisma = new PrismaClient();
const shopId = requiredUuid('STORE_REVIEW_SHOP_ID');
const driverId = requiredUuid('STORE_REVIEW_DRIVER_ID');
const accountId = requiredUuid('STORE_REVIEW_ACCOUNT_ID');
const apply = process.argv.includes('--apply');

try {
  const result = await prisma.$transaction(async (tx) => {
    const account = await tx.driverAccount.findUnique({
      where: { id: accountId }, select: { id: true, isStoreReviewAccount: true, drivers: { select: { id: true }, orderBy: { id: 'asc' } } },
    });
    const driver = await tx.driver.findFirst({
      where: { id: driverId, accountId, shopId }, select: { id: true, accountId: true, isStoreReviewData: true },
    });
    if (account === null || driver === null || account.drivers.length !== 1 || account.drivers[0]?.id !== driverId) {
      throw new Error('The explicitly selected review account must own exactly the selected driver');
    }
    const orders = await tx.order.findMany({
      where: { shopId, sellerOrderKey: { startsWith: 'STORE-REVIEW-SYNTHETIC-' } },
      select: { id: true, customerId: true, destinationId: true, isStoreReviewData: true }, orderBy: { id: 'asc' },
    });
    if (orders.length !== 2 || orders.some((order) => order.customerId === null || order.destinationId === null)) {
      throw new Error('Expected exactly two linked synthetic review orders');
    }
    const orderIds = orders.map((order) => order.id);
    const customerIds = [...new Set(orders.map((order) => order.customerId!))];
    const destinationIds = [...new Set(orders.map((order) => order.destinationId!))];
    if (customerIds.length !== 1 || destinationIds.length !== 2) throw new Error('Unexpected review customer/destination graph');
    const sharedOrders = await tx.order.count({ where: {
      shopId, id: { notIn: orderIds }, OR: [{ customerId: { in: customerIds } }, { destinationId: { in: destinationIds } }],
    } });
    if (sharedOrders !== 0) throw new Error('Review targets are shared with unrelated orders');
    const [customers, destinations, routes, imports] = await Promise.all([
      tx.customer.findMany({ where: { shopId, id: { in: customerIds } }, select: { id: true, isStoreReviewData: true }, orderBy: { id: 'asc' } }),
      tx.deliveryCustomerProfile.findMany({ where: { shopId, id: { in: destinationIds }, mergedIntoProfileId: null }, select: { id: true, isStoreReviewData: true }, orderBy: { id: 'asc' } }),
      tx.routePlan.findMany({ where: { shopId, OR: [{ driverId }, { routeStops: { some: { deliveryStop: { orderId: { in: orderIds } } } } }] },
        select: { id: true, driverId: true, vehicleId: true, isStoreReviewData: true, routeStops: { select: { deliveryStop: { select: { orderId: true } } }, orderBy: { id: 'asc' } } }, orderBy: { id: 'asc' } }),
      tx.dsvDispatchImport.findMany({ where: { shopId, rows: { some: { sellerOrderId: { in: orderIds } } } },
        select: { id: true, isStoreReviewData: true, rows: { select: { sellerOrderId: true, driverId: true, vehicleId: true }, orderBy: { id: 'asc' } } }, orderBy: { id: 'asc' } }),
    ]);
    if (customers.length !== 1 || destinations.length !== 2 || routes.length === 0 || imports.length === 0) {
      throw new Error('Review fixture graph is incomplete');
    }
    if (routes.some((route) => route.vehicleId !== null) || imports.some((record) => record.rows.some((row) => row.vehicleId !== null))
      || await tx.dsvVehicleDriverAssignment.count({ where: { shopId, driverId } }) !== 0) {
      throw new Error('This two-stop review repair must not classify operational vehicle telemetry');
    }
    if (routes.some((route) => route.driverId !== driverId || route.routeStops.some((stop) => !orderIds.includes(stop.deliveryStop.orderId)))
      || imports.some((record) => record.rows.some((row) => row.driverId !== driverId || row.sellerOrderId === null || !orderIds.includes(row.sellerOrderId)))) {
      throw new Error('Review fixture is mixed with unrelated data; no changes applied');
    }
    const snapshot = { account, driver, orders, customers, destinations, routes, imports, shopId };
    const fingerprint = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
    const summary = { fingerprint, accounts: 1, drivers: 1, orders: orders.length, customers: customers.length,
      destinations: destinations.length, routes: routes.length, imports: imports.length };
    if (!apply) {
      return { mode: 'dry-run', ...summary, alreadyIsolated: account.isStoreReviewAccount
        && [driver, ...orders, ...customers, ...destinations, ...routes, ...imports].every((row) => row.isStoreReviewData) };
    }
    if (process.env.STORE_REVIEW_EXPECTED_FINGERPRINT !== fingerprint) throw new Error('Dry-run fingerprint changed or missing');
    const snapshotPath = process.env.STORE_REVIEW_SNAPSHOT_PATH;
    if (!snapshotPath || !isAbsolute(snapshotPath)) throw new Error('An absolute rollback snapshot path is required');
    await writeFile(snapshotPath, JSON.stringify(snapshot, null, 2), { flag: 'wx', mode: 0o600 });
    await tx.driverAccount.update({ where: { id: accountId }, data: { isStoreReviewAccount: true } });
    await tx.driver.update({ where: { id: driverId }, data: { isStoreReviewData: true } });
    const data = { isStoreReviewData: true };
    const updates = [
      [await tx.order.updateMany({ where: { shopId, id: { in: orderIds } }, data }), orders.length],
      [await tx.customer.updateMany({ where: { shopId, id: { in: customerIds } }, data }), customers.length],
      [await tx.deliveryCustomerProfile.updateMany({ where: { shopId, id: { in: destinationIds } }, data }), destinations.length],
      [await tx.routePlan.updateMany({ where: { shopId, id: { in: routes.map((route) => route.id) } }, data }), routes.length],
      [await tx.dsvDispatchImport.updateMany({ where: { shopId, id: { in: imports.map((record) => record.id) } }, data }), imports.length],
    ] as const;
    if (updates.some(([updated, expected]) => updated.count !== expected)) throw new Error('Fixture update count changed; rolling back');
    return { mode: 'apply', ...summary, snapshotWritten: true };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await prisma.$disconnect();
}

function requiredUuid(name: string): string {
  const value = process.env[name] ?? '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new Error(`${name} must explicitly identify the approved fixture`);
  }
  return value;
}
