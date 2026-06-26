import type { Prisma, PrismaClient } from '@prisma/client';

import { aggregateOrderItems, toOrderItemDto, type OrderItemDto } from '../order-items/order-items.js';
import { appScopedShopWhere } from '../shopify/shopify-app-scope.js';
import { InventoryValidationError, type CreateInventoryInput, type InventoryChangeItemDto, type InventoryDto, type InventoryService, type UpdateInventoryOrdersInput } from './inventory.types.js';

type InventoryPrismaClient = Pick<
  PrismaClient,
  '$transaction' | 'inventory' | 'inventoryEvent' | 'inventoryOrder' | 'order' | 'shop'
>;

type Tx = Parameters<Parameters<InventoryPrismaClient['$transaction']>[0]>[0];
type LoadedInventory = Prisma.InventoryGetPayload<{ include: ReturnType<typeof inventoryInclude> }>;
type LoadedInventoryEvent = Prisma.InventoryEventGetPayload<object>;
type LoadedOrder = Prisma.OrderGetPayload<{ include: { orderItems: true } }>;

export class PrismaInventoryService implements InventoryService {
  constructor(private readonly prisma: InventoryPrismaClient) {}

  async createInventory(input: CreateInventoryInput): Promise<InventoryDto> {
    const orderIds = normalizeIds(input.orderIds ?? []);
    const inventoryId = await this.prisma.$transaction(async (tx) => {
      const shop = await findShop(tx, input);
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
      if (orderIds.length > 0) await addInventoryOrders(tx, shop.id, inventory.id, orderIds, input.actor);
      return inventory.id;
    });
    const inventory = await this.getInventory({ appId: input.appId, inventoryId, shopDomain: input.shopDomain });
    if (inventory === null) throw new InventoryValidationError(['inventory not found after create']);
    return inventory;
  }

  async deleteInventory(input: { appId?: string | undefined; inventoryId: string; shopDomain: string }): Promise<{ deleted: boolean; inventoryId: string }> {
    const shop = await this.prisma.shop.findUnique({ select: { id: true }, where: appScopedShopWhere({ appId: input.appId, shopDomain: normalizeShopDomain(input.shopDomain) }) });
    if (shop === null) return { deleted: false, inventoryId: input.inventoryId };
    const deleted = await this.prisma.inventory.deleteMany({ where: { id: input.inventoryId, shopId: shop.id } });
    return { deleted: deleted.count === 1, inventoryId: input.inventoryId };
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
    const addOrderIds = normalizeIds(input.addOrderIds ?? []);
    const removeOrderIds = normalizeIds(input.removeOrderIds ?? []);
    if (addOrderIds.length === 0 && removeOrderIds.length === 0) {
      return this.getInventory({ appId: input.appId, inventoryId: input.inventoryId, shopDomain: input.shopDomain });
    }

    const inventoryId = await this.prisma.$transaction(async (tx) => {
      const shop = await findShop(tx, input);
      if (shop === null) return null;
      const inventory = await tx.inventory.findFirst({ select: { id: true }, where: { id: input.inventoryId, shopId: shop.id } });
      if (inventory === null) return null;
      if (removeOrderIds.length > 0) await removeInventoryOrders(tx, shop.id, inventory.id, removeOrderIds, input.actor);
      if (addOrderIds.length > 0) await addInventoryOrders(tx, shop.id, inventory.id, addOrderIds, input.actor);
      await tx.inventory.update({ data: { updatedAt: new Date() }, where: { id: inventory.id } });
      return inventory.id;
    });
    if (inventoryId === null) return null;
    return this.getInventory({ appId: input.appId, inventoryId, shopDomain: input.shopDomain });
  }
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

async function findShop(tx: Tx, input: { appId?: string | undefined; shopDomain: string }): Promise<{ id: string } | null> {
  return tx.shop.findUnique({ select: { id: true }, where: appScopedShopWhere({ appId: input.appId, shopDomain: normalizeShopDomain(input.shopDomain) }) });
}

async function addInventoryOrders(tx: Tx, shopId: string, inventoryId: string, orderIds: string[], actor: string): Promise<void> {
  const existing = new Set((await tx.inventoryOrder.findMany({ select: { orderId: true }, where: { inventoryId, orderId: { in: orderIds }, shopId } })).map((row) => row.orderId));
  const orderIdsToAdd = orderIds.filter((orderId) => !existing.has(orderId));
  if (orderIdsToAdd.length === 0) return;
  const orders = await loadOrders(tx, shopId, orderIdsToAdd);
  await tx.inventoryOrder.createMany({
    data: orders.map((order) => ({ addedBy: actor, inventoryId, orderId: order.id, shopId }))
  });
  await createInventoryEvents(tx, shopId, inventoryId, orders, 'ADD', actor);
}

async function removeInventoryOrders(tx: Tx, shopId: string, inventoryId: string, orderIds: string[], actor: string): Promise<void> {
  const rows = await tx.inventoryOrder.findMany({ select: { orderId: true }, where: { inventoryId, orderId: { in: orderIds }, shopId } });
  const orderIdsToRemove = rows.map((row) => row.orderId);
  if (orderIdsToRemove.length === 0) return;
  const orders = await loadOrders(tx, shopId, orderIdsToRemove);
  await createInventoryEvents(tx, shopId, inventoryId, orders, 'REMOVE', actor);
  await tx.inventoryOrder.deleteMany({ where: { inventoryId, orderId: { in: orderIdsToRemove }, shopId } });
}

async function loadOrders(tx: Tx, shopId: string, orderIds: string[]): Promise<LoadedOrder[]> {
  const orders = await tx.order.findMany({ include: { orderItems: { orderBy: { lineIndex: 'asc' } } }, where: { id: { in: orderIds }, shopId } });
  if (orders.length !== orderIds.length) throw new InventoryValidationError(['orders must belong to the current shop']);
  const byId = new Map(orders.map((order) => [order.id, order]));
  return orderIds.map((orderId) => {
    const order = byId.get(orderId);
    if (order === undefined) throw new InventoryValidationError(['orders must belong to the current shop']);
    return order;
  });
}

async function createInventoryEvents(tx: Tx, shopId: string, inventoryId: string, orders: LoadedOrder[], action: 'ADD' | 'REMOVE', actor: string): Promise<void> {
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
    ordersCount: orderIds.length,
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
    action: event.action === 'REMOVE' ? 'REMOVE' : 'ADD',
    orderId: event.orderId,
    quantityDelta: event.action === 'REMOVE' ? -event.quantity : event.quantity
  };
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
