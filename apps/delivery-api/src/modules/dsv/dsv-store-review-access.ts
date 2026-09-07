import type { PrismaClient } from '@prisma/client';
import { canAccessDsvStoreReviewData, DsvForbiddenError, type DsvPrincipal } from './dsv-principal.js';

export type DsvStoreReviewReferences = {
  driverIds?: readonly string[];
  orderIds?: readonly string[];
  customerIds?: readonly string[];
  destinationIds?: readonly string[];
  routePlanIds?: readonly string[];
  importIds?: readonly string[];
  deliveryStopIds?: readonly string[];
  assignmentIds?: readonly string[];
  customerAccountIds?: readonly string[];
  changeRequestIds?: readonly string[];
};

export interface DsvStoreReviewAccess {
  assertAccessible(principal: DsvPrincipal, references: DsvStoreReviewReferences): Promise<void>;
}

export class PrismaDsvStoreReviewAccess implements DsvStoreReviewAccess {
  constructor(private readonly prisma: PrismaClient) {}

  async assertAccessible(principal: DsvPrincipal, references: DsvStoreReviewReferences): Promise<void> {
    if (canAccessDsvStoreReviewData(principal)) return;
    const where = (ids: readonly string[]) => ({
      id: { in: [...ids] }, isStoreReviewData: true, shopId: principal.shopId,
    });
    const checks: Promise<unknown>[] = [];
    const select = { id: true } as const;
    if (references.driverIds?.length) checks.push(this.prisma.driver.findFirst({ select, where: where(references.driverIds) }));
    if (references.orderIds?.length) checks.push(this.prisma.order.findFirst({ select, where: where(references.orderIds) }));
    if (references.customerIds?.length) checks.push(this.prisma.customer.findFirst({ select, where: where(references.customerIds) }));
    if (references.destinationIds?.length) checks.push(this.prisma.deliveryCustomerProfile.findFirst({ select, where: where(references.destinationIds) }));
    if (references.routePlanIds?.length) checks.push(this.prisma.routePlan.findFirst({ select, where: where(references.routePlanIds) }));
    if (references.importIds?.length) checks.push(this.prisma.dsvDispatchImport.findFirst({ select, where: where(references.importIds) }));
    if (references.deliveryStopIds?.length) checks.push(this.prisma.deliveryStop.findFirst({
      select, where: { id: { in: [...references.deliveryStopIds] }, shopId: principal.shopId, order: { isStoreReviewData: true } },
    }));
    if (references.assignmentIds?.length) checks.push(this.prisma.dsvVehicleDriverAssignment.findFirst({
      select, where: { id: { in: [...references.assignmentIds] }, shopId: principal.shopId, driver: { isStoreReviewData: true } },
    }));
    if (references.customerAccountIds?.length) checks.push(this.prisma.customerAccount.findFirst({
      select, where: { id: { in: [...references.customerAccountIds] }, shopId: principal.shopId, customer: { isStoreReviewData: true } },
    }));
    if (references.changeRequestIds?.length) checks.push(this.prisma.dsvDispatchChangeRequest.findFirst({
      select, where: { id: { in: [...references.changeRequestIds] }, shopId: principal.shopId, sellerOrder: { isStoreReviewData: true } },
    }));
    if ((await Promise.all(checks)).some((record) => record !== null)) {
      throw new DsvForbiddenError({ principal, requiredScopes: ['dsv:accounts:read'] });
    }
  }
}
