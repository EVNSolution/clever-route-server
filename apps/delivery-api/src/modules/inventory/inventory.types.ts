import type { OrderItemDto, RouteItemSummary } from '../order-items/order-items.js';

export type InventoryChangeItemDto = OrderItemDto & {
  action: 'ADD' | 'REMOVE';
  orderId: string;
  quantityDelta: number;
};

export type InventoryDto = {
  createdAt: string;
  id: string;
  itemSummary: RouteItemSummary;
  lastChange: InventoryChangeItemDto[];
  name: string;
  note: string | null;
  orderIds: string[];
  ordersCount: number;
  updatedAt: string;
};

export type CreateInventoryInput = {
  appId?: string | undefined;
  actor: string;
  name: string;
  note?: string | null;
  orderIds?: string[];
  shopDomain: string;
};

export type UpdateInventoryOrdersInput = {
  addOrderIds?: string[];
  appId?: string | undefined;
  actor: string;
  inventoryId: string;
  removeOrderIds?: string[];
  shopDomain: string;
};

export type InventoryService = {
  createInventory(input: CreateInventoryInput): Promise<InventoryDto>;
  deleteInventory(input: { appId?: string | undefined; inventoryId: string; shopDomain: string }): Promise<{ deleted: boolean; inventoryId: string }>;
  getInventory(input: { appId?: string | undefined; inventoryId: string; shopDomain: string }): Promise<InventoryDto | null>;
  listInventories(input: { appId?: string | undefined; shopDomain: string }): Promise<InventoryDto[]>;
  updateInventoryOrders(input: UpdateInventoryOrdersInput): Promise<InventoryDto | null>;
};

export class InventoryValidationError extends Error {
  readonly code = 'INVENTORY_INVALID';
  constructor(readonly blockers: string[]) {
    super(`Inventory is invalid: ${blockers.join('; ')}`);
    this.name = 'InventoryValidationError';
  }
}
