import type { Prisma, PrismaClient } from '@prisma/client';

import { aggregateOrderItems, toOrderItemDto, type OrderItemDto } from '../order-items/order-items.js';
import { appScopedShopWhere } from '../shopify/shopify-app-scope.js';
import { InventoryValidationError, type CreateInventoryInput, type InventoryChangeItemDto, type InventoryDto, type InventoryService, type UpdateInventoryOrdersInput } from './inventory.types.js';

type InventoryPrismaClient = Pick<
  PrismaClient,
  '$transaction' | 'inventory' | 'inventoryEvent' | 'inventoryOrder' | 'order' | 'shop'
>;

type InventoryBaseWriteClient = Pick<PrismaClient, 'inventory' | 'inventoryEvent' | 'inventoryOrder' | 'order'>;
type InventoryWriteClient = InventoryBaseWriteClient & Pick<PrismaClient, 'routeGroupingOrder'>;
type LoadedInventory = Prisma.InventoryGetPayload<{ include: ReturnType<typeof inventoryInclude> }>;
type LoadedInventoryEvent = Prisma.InventoryEventGetPayload<object>;
type LoadedOrder = Prisma.OrderGetPayload<{ include: { orderItems: true } }>;
type InventoryItemRecord = OrderItemDto & { id?: string | null };

export class PrismaInventoryService implements InventoryService {
  constructor(private readonly prisma: InventoryPrismaClient) {}

  async createInventory(input: CreateInventoryInput): Promise<InventoryDto> {
    const shopDomain = normalizeShopDomain(input.shopDomain);
    const inventoryId = await this.prisma.$transaction(async (tx) => {
      const shop = await tx.shop.findUnique({ select: { id: true }, where: appScopedShopWhere({ appId: input.appId, shopDomain }) });
      if (shop === null) throw new InventoryValidationError(['shop not found']);

      const inventory = await tx.inventory.create({
        data: {
          createdBy: input.actor,
          name: requireText(input.name, 'name'),
          note: normalizeOptionalText(input.note),
          shopId: shop.id
        },
        select: { id: true }
      });
      await addInventoryOrders(tx, shop.id, inventory.id, normalizeIds(input.orderIds ?? []), input.actor);
      await tx.inventory.update({ data: { updatedAt: new Date() }, where: { id: inventory.id } });
      return inventory.id;
    });
    const inventory = await this.getInventory({ appId: input.appId, inventoryId, shopDomain });
    if (inventory === null) throw new InventoryValidationError(['created inventory not found']);
    return inventory;
  }

  async deleteInventory(input: { appId?: string | undefined; inventoryId: string; shopDomain: string }): Promise<{ deleted: boolean; inventoryId: string }> {
    const shop = await this.prisma.shop.findUnique({ select: { id: true }, where: appScopedShopWhere({ appId: input.appId, shopDomain: normalizeShopDomain(input.shopDomain) }) });
    if (shop === null) return { deleted: false, inventoryId: input.inventoryId };
    const inventory = await this.prisma.inventory.findFirst({ select: { routeGroupingId: true }, where: { id: input.inventoryId, shopId: shop.id } });
    if (inventory?.routeGroupingId) throw new InventoryValidationError(['route group inventory is managed by route groups']);
    const deleted = await this.prisma.inventory.deleteMany({ where: { id: input.inventoryId, routeGroupingId: null, shopId: shop.id } });
    return { deleted: deleted.count > 0, inventoryId: input.inventoryId };
  }

  async getInventory(input: { appId?: string | undefined; inventoryId: string; shopDomain: string }): Promise<InventoryDto | null> {
    const shop = await this.prisma.shop.findUnique({ select: { id: true }, where: appScopedShopWhere({ appId: input.appId, shopDomain: normalizeShopDomain(input.shopDomain) }) });
    if (shop === null) return null;
    const inventory = await this.prisma.inventory.findFirst({ include: inventoryInclude(), where: { id: input.inventoryId, shopId: shop.id } });
    return inventory === null ? null : toInventoryDto(inventory);
  }

  async listInventories(input: { appId?: string | undefined; shopDomain: string }): Promise<InventoryDto[]> {
    const shop = await this.prisma.shop.findUnique({ select: { id: true }, where: appScopedShopWhere({ appId: input.appId, shopDomain: normalizeShopDomain(input.shopDomain) }) });
    if (shop === null) return [];
    const inventories = await this.prisma.inventory.findMany({ include: inventoryInclude(), orderBy: { createdAt: 'desc' }, where: { shopId: shop.id } });
    return inventories.map(toInventoryDto);
  }

  async updateInventoryOrders(input: UpdateInventoryOrdersInput): Promise<InventoryDto | null> {
    const shopDomain = normalizeShopDomain(input.shopDomain);
    const inventoryId = await this.prisma.$transaction(async (tx) => {
      const shop = await tx.shop.findUnique({ select: { id: true }, where: appScopedShopWhere({ appId: input.appId, shopDomain }) });
      if (shop === null) return null;
      const inventory = await tx.inventory.findFirst({ select: { id: true, routeGroupingId: true }, where: { id: input.inventoryId, shopId: shop.id } });
      if (inventory === null) return null;
      if (inventory.routeGroupingId) throw new InventoryValidationError(['route group inventory is managed by route groups']);

      await removeInventoryOrders(tx, shop.id, inventory.id, normalizeIds(input.removeOrderIds ?? []), input.actor);
      await addInventoryOrders(tx, shop.id, inventory.id, normalizeIds(input.addOrderIds ?? []), input.actor);
      await tx.inventory.update({ data: { updatedAt: new Date() }, where: { id: inventory.id } });
      return inventory.id;
    });
    if (inventoryId === null) return null;
    return this.getInventory({ appId: input.appId, inventoryId, shopDomain });
  }
}

export async function createRouteGroupingInventory(
  tx: InventoryWriteClient,
  input: { actor: string; groupingId: string; name: string; orderIds: string[]; shopId: string }
): Promise<string> {
  const inventory = await tx.inventory.upsert({
    create: {
      createdBy: input.actor,
      name: requireText(input.name, 'name'),
      routeGroupingId: input.groupingId,
      shopId: input.shopId
    },
    select: { id: true },
    update: { name: requireText(input.name, 'name') },
    where: { routeGroupingId: input.groupingId }
  });
  await addInventoryOrders(tx, input.shopId, inventory.id, normalizeIds(input.orderIds), input.actor);
  await tx.inventory.update({ data: { updatedAt: new Date() }, where: { id: inventory.id } });
  return inventory.id;
}

export async function syncRouteGroupingInventoryOrders(
  tx: InventoryWriteClient,
  input: { actor: string; addOrderIds: string[]; groupingId: string; name: string; removeOrderIds: string[]; shopId: string }
): Promise<string> {
  const existing = await tx.inventory.findUnique({ select: { id: true }, where: { routeGroupingId: input.groupingId } });
  if (existing === null) {
    const currentMembership = await tx.routeGroupingOrder.findMany({
      orderBy: { sourceSequence: 'asc' },
      select: { orderId: true },
      where: { groupingId: input.groupingId, shopId: input.shopId }
    });
    return createRouteGroupingInventory(tx, {
      actor: input.actor,
      groupingId: input.groupingId,
      name: input.name,
      orderIds: currentMembership.map((row) => row.orderId),
      shopId: input.shopId
    });
  }
  const addOrderIds = normalizeIds(input.addOrderIds);
  const removeOrderIds = normalizeIds(input.removeOrderIds);
  if (removeOrderIds.length > 0) await removeInventoryOrders(tx, input.shopId, existing.id, removeOrderIds, input.actor);
  if (addOrderIds.length > 0) await addInventoryOrders(tx, input.shopId, existing.id, addOrderIds, input.actor);
  await tx.inventory.update({ data: { name: requireText(input.name, 'name'), updatedAt: new Date() }, where: { id: existing.id } });
  return existing.id;
}

export async function recordInventorySourceItemDeltas(
  tx: InventoryBaseWriteClient,
  input: { actor: string; currentItems: InventoryItemRecord[]; orderId: string; previousItems: InventoryItemRecord[]; shopId: string }
): Promise<void> {
  const memberships = await tx.inventoryOrder.findMany({
    select: { inventoryId: true },
    where: { orderId: input.orderId, shopId: input.shopId }
  });
  const inventoryIds = [...new Set(memberships.map((membership) => membership.inventoryId))];
  if (inventoryIds.length === 0) return;

  const previous = aggregateInventoryItemsByKey(input.previousItems);
  const current = aggregateInventoryItemsByKey(input.currentItems);
  const events: Prisma.InventoryEventCreateManyInput[] = [];

  for (const key of new Set([...previous.keys(), ...current.keys()])) {
    const before = previous.get(key);
    const after = current.get(key);
    const delta = (after?.quantity ?? 0) - (before?.quantity ?? 0);
    if (delta === 0) continue;
    const item = after ?? before;
    if (item === undefined) continue;
    for (const inventoryId of inventoryIds) {
      events.push({
        action: before === undefined ? 'ADD' : after === undefined ? 'REMOVE' : 'CHANGE',
        actor: input.actor,
        inventoryId,
        name: item.name,
        options: item.options,
        orderId: input.orderId,
        orderItemId: after?.id ?? null,
        productId: item.productId,
        quantity: Math.abs(delta),
        quantityDelta: delta,
        shopId: input.shopId,
        sku: item.sku,
        variationId: item.variationId
      });
    }
  }

  if (events.length === 0) return;
  await tx.inventoryEvent.createMany({ data: events });
  await tx.inventory.updateMany({ data: { updatedAt: new Date() }, where: { id: { in: inventoryIds }, shopId: input.shopId } });
}

function inventoryInclude() {
  return {
    events: { orderBy: { createdAt: 'desc' as const }, take: 50 },
    orders: {
      include: { order: { include: { orderItems: { orderBy: { lineIndex: 'asc' as const } } } } },
      orderBy: { createdAt: 'asc' as const }
    }
  } satisfies Prisma.InventoryInclude;
}

async function addInventoryOrders(tx: InventoryBaseWriteClient, shopId: string, inventoryId: string, orderIds: string[], actor: string): Promise<void> {
  const existing = new Set((await tx.inventoryOrder.findMany({ select: { orderId: true }, where: { inventoryId, orderId: { in: orderIds }, shopId } })).map((row) => row.orderId));
  const orderIdsToAdd = orderIds.filter((orderId) => !existing.has(orderId));
  if (orderIdsToAdd.length === 0) return;
  const orders = await loadOrders(tx, shopId, orderIdsToAdd);
  await tx.inventoryOrder.createMany({
    data: orders.map((order) => ({ addedBy: actor, inventoryId, orderId: order.id, shopId }))
  });
  await createInventoryEvents(tx, shopId, inventoryId, orders, 'ADD', actor);
}

async function removeInventoryOrders(tx: InventoryBaseWriteClient, shopId: string, inventoryId: string, orderIds: string[], actor: string): Promise<void> {
  const rows = await tx.inventoryOrder.findMany({ select: { orderId: true }, where: { inventoryId, orderId: { in: orderIds }, shopId } });
  const orderIdsToRemove = rows.map((row) => row.orderId);
  if (orderIdsToRemove.length === 0) return;
  const orders = await loadOrders(tx, shopId, orderIdsToRemove);
  await createInventoryEvents(tx, shopId, inventoryId, orders, 'REMOVE', actor);
  await tx.inventoryOrder.deleteMany({ where: { inventoryId, orderId: { in: orderIdsToRemove }, shopId } });
}

async function loadOrders(tx: InventoryBaseWriteClient, shopId: string, orderIds: string[]): Promise<LoadedOrder[]> {
  const orders = await tx.order.findMany({ include: { orderItems: { orderBy: { lineIndex: 'asc' } } }, where: { id: { in: orderIds }, shopId } });
  if (orders.length !== orderIds.length) throw new InventoryValidationError(['orders must belong to the current shop']);
  const byId = new Map(orders.map((order) => [order.id, order]));
  return orderIds.map((orderId) => {
    const order = byId.get(orderId);
    if (order === undefined) throw new InventoryValidationError(['orders must belong to the current shop']);
    return order;
  });
}

async function createInventoryEvents(tx: InventoryBaseWriteClient, shopId: string, inventoryId: string, orders: LoadedOrder[], action: 'ADD' | 'REMOVE', actor: string): Promise<void> {
  const sign = action === 'REMOVE' ? -1 : 1;
  const data = orders.flatMap((order) => order.orderItems.map((item) => ({
    action,
    actor,
    inventoryId,
    name: item.name,
    options: item.options as Prisma.InputJsonValue,
    orderId: order.id,
    orderItemId: item.id,
    productId: item.productId,
    quantity: item.quantity,
    quantityDelta: sign * item.quantity,
    shopId,
    sku: item.sku,
    variationId: item.variationId
  })));
  if (data.length > 0) await tx.inventoryEvent.createMany({ data });
}

function toInventoryDto(inventory: LoadedInventory): InventoryDto {
  const orderIds = inventory.orders.map((entry) => entry.orderId);
  const items = inventory.orders.flatMap((entry) => entry.order.orderItems.map(toOrderItemDto));
  return {
    createdAt: inventory.createdAt.toISOString(),
    id: inventory.id,
    itemSummary: aggregateOrderItems(items),
    lastChange: inventory.events.map(toChangeItemDto),
    name: inventory.name,
    note: inventory.note,
    orderIds,
    orders: inventory.orders.map((entry) => ({
      id: entry.orderId,
      items: entry.order.orderItems.map(toOrderItemDto),
      name: entry.order.name
    })),
    ordersCount: orderIds.length,
    routeGroupingId: inventory.routeGroupingId,
    updatedAt: inventory.updatedAt.toISOString()
  };
}

function toChangeItemDto(event: LoadedInventoryEvent): InventoryChangeItemDto {
  const item: OrderItemDto = {
    name: event.name,
    options: readOrderItemOptions(event.options),
    productId: event.productId,
    quantity: event.quantity,
    sku: event.sku,
    variationId: event.variationId
  };
  return {
    ...item,
    action: event.action === 'REMOVE' ? 'REMOVE' : event.action === 'CHANGE' ? 'CHANGE' : 'ADD',
    createdAt: event.createdAt.toISOString(),
    orderId: event.orderId,
    quantityDelta: event.quantityDelta ?? (event.action === 'REMOVE' ? -event.quantity : event.quantity)
  };
}

function aggregateInventoryItemsByKey(items: InventoryItemRecord[]): Map<string, InventoryItemRecord> {
  const grouped = new Map<string, InventoryItemRecord>();
  for (const item of items) {
    const key = inventoryItemKey(item);
    const existing = grouped.get(key);
    if (existing === undefined) {
      grouped.set(key, { ...item });
      continue;
    }
    existing.quantity += item.quantity;
    if ((existing.id === undefined || existing.id === null) && item.id != null) existing.id = item.id;
  }
  return grouped;
}

function inventoryItemKey(item: OrderItemDto): string {
  return JSON.stringify({
    options: canonicalInventoryOptions(item.options),
    productId: item.productId,
    variationId: item.variationId
  });
}

function canonicalInventoryOptions(options: OrderItemDto['options']): OrderItemDto['options'] {
  return options
    .flatMap((option) => {
      const key = normalizeOptionalText(option.key);
      const value = normalizeOptionalText(option.value);
      return key === null || value === null ? [] : [{ key, value }];
    })
    .sort((left, right) => left.key.localeCompare(right.key) || left.value.localeCompare(right.value));
}

function readOrderItemOptions(value: unknown): OrderItemDto['options'] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (item === null || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    return typeof record.key === 'string' && typeof record.value === 'string' ? [{ key: record.key, value: record.value }] : [];
  });
}

function normalizeIds(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value !== ''))];
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const normalized = value.trim();
  return normalized === '' ? null : normalized;
}

function normalizeShopDomain(value: string): string {
  return value.trim().toLowerCase();
}

function requireText(value: string, field: string): string {
  const normalized = normalizeOptionalText(value);
  if (normalized === null) throw new InventoryValidationError([`${field} is required`]);
  return normalized;
}
