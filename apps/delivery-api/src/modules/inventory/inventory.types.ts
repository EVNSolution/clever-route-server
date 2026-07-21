import type { OrderItemDto, RouteItemSummary } from '../order-items/order-items.js';

export type InventoryChangeItemDto = OrderItemDto & {
  action: 'ADD' | 'CHANGE' | 'REMOVE';
  createdAt: string;
  orderId: string;
  orderName: string | null;
  quantityDelta: number;
  recipientName: string | null;
};

export type InventoryOrderDto = {
  address: string | null;
  currencyCode: string | null;
  customerNote: string | null;
  deliveryDate: string | null;
  driveTimeMinutes?: number | null;
  eta?: string | null;
  financialStatus: string | null;
  id: string;
  items: OrderItemDto[];
  name: string;
  orderDateLocal: string | null;
  paymentStatus: string | null;
  phone: string | null;
  processedAt: string | null;
  recipientName: string | null;
  routeStop?: InventoryRouteStopDto | null;
  stopTimeMinutes?: number | null;
  totalPriceAmount: string | null;
};

export type InventoryRouteStopDto = {
  driveTimeMinutes: number | null;
  eta: string | null;
  orderId: string;
  sequence: number;
  stopTimeMinutes: number | null;
};

export type InventoryLinkedRouteDto = {
  driver: { displayName: string; id: string; phone: string | null } | null;
  driverName: string | null;
  id: string;
  name: string;
  startTime: string | null;
  stops: InventoryRouteStopDto[];
};

export type InventoryDto = {
  createdAt: string;
  id: string;
  itemSummary: RouteItemSummary;
  lastChange: InventoryChangeItemDto[];
  linkedRoutes: InventoryLinkedRouteDto[];
  name: string;
  note: string | null;
  orderIds: string[];
  orders: InventoryOrderDto[];
  ordersCount: number;
  routeGroupingId: string | null;
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
  getInventoryOrderView(input: { appId?: string | undefined; inventoryId: string; shopDomain: string }): Promise<InventoryDto | null>;
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
