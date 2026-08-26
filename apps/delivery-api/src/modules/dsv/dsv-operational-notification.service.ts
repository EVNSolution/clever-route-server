import type { Prisma, PrismaClient } from '@prisma/client';

import { appScopedShopWhere } from '../shopify/shopify-app-scope.js';
import type { DsvDriverAccountLinkService } from './dsv-driver-account-link.service.js';

export type DsvOperationalNotification = {
  changeRequestId?: string;
  createdAt: string;
  description: string;
  id: string;
  kind: 'CANCELLED_ORDER' | 'CHANGE_APPLIED' | 'CHANGE_CANCELLED' | 'CHANGE_PENDING' | 'DRIVER_ACCOUNT_LINK_PENDING' | 'DRIVER_NOTIFICATION_FAILED';
  recoverable: boolean;
  sellerOrderId?: string;
  severity: 'info' | 'success' | 'warning';
  title: string;
};

export type DsvOperationalNotificationService = {
  list(input: { shopDomain: string }): Promise<{ items: DsvOperationalNotification[] }>;
};

type OperationalNotificationPrismaClient = Pick<
  PrismaClient,
  'driverRouteNotificationAttempt' | 'dsvDispatchChangeRequest' | 'order' | 'shop'
>;

export class PrismaDsvOperationalNotificationService implements DsvOperationalNotificationService {
  constructor(
    private readonly prisma: OperationalNotificationPrismaClient,
    private readonly driverAccountLinks?: Pick<DsvDriverAccountLinkService, 'listPending'>,
  ) {}

  async list(input: { shopDomain: string }): Promise<{ items: DsvOperationalNotification[] }> {
    const shop = await this.prisma.shop.findUnique({
      select: { id: true },
      where: appScopedShopWhere({ shopDomain: input.shopDomain.trim().toLowerCase() }),
    });
    if (shop === null) return { items: [] };
    const [requests, attempts, cancelledOrders, driverAccountLinks] = await Promise.all([
      this.prisma.dsvDispatchChangeRequest.findMany({
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        select: {
          createdAt: true,
          id: true,
          sellerOrder: { select: { sellerOrderKey: true } },
          sellerOrderId: true,
          status: true,
          type: true,
          updatedAt: true,
        },
        take: 50,
        where: { shopId: shop.id },
      }),
      this.prisma.driverRouteNotificationAttempt.findMany({
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        select: {
          errorCode: true,
          id: true,
          metadata: true,
          status: true,
          updatedAt: true,
        },
        take: 50,
        where: { action: 'CHANGED', shopId: shop.id, status: { in: ['FAILED', 'SKIPPED'] } },
      }),
      this.prisma.order.findMany({
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        select: { id: true, sellerOrderKey: true, updatedAt: true },
        take: 50,
        where: { currentRouteVersionId: null, deliveryStatus: 'CANCELLED', shopId: shop.id },
      }),
      this.driverAccountLinks?.listPending(input) ?? Promise.resolve([]),
    ]);

    const items: DsvOperationalNotification[] = [];
    for (const request of requests) {
      const orderLabel = request.sellerOrder.sellerOrderKey ?? request.sellerOrderId;
      const typeLabel = request.type === 'ACTIVE_ROUTE_ORDER_REMOVAL' ? '활성 경로 제외' : '시간 제약 변경';
      const state = changeRequestState(request.status);
      items.push({
        changeRequestId: request.id,
        createdAt: (request.status === 'PENDING_ACK' ? request.createdAt : request.updatedAt).toISOString(),
        description: `${orderLabel} ${typeLabel} 요청이 ${state.description}`,
        id: `change:${request.id}:${request.status}`,
        kind: state.kind,
        recoverable: false,
        sellerOrderId: request.sellerOrderId,
        severity: state.severity,
        title: state.title,
      });
    }
    for (const attempt of attempts) {
      const metadata = recordValue(attempt.metadata);
      const changeRequestId = stringValue(metadata?.changeRequestId);
      const orderMessageId = stringValue(metadata?.orderMessageId);
      if (changeRequestId === null && orderMessageId === null) continue;
      items.push({
        ...(changeRequestId === null ? {} : { changeRequestId }),
        createdAt: attempt.updatedAt.toISOString(),
        description: `${attempt.errorCode ?? 'UNKNOWN'} 오류로 배송원 알림을 전송하지 못했습니다. 재시도 상태를 확인하세요.`,
        id: `driver-notification:${attempt.id}:${attempt.status}`,
        kind: 'DRIVER_NOTIFICATION_FAILED',
        recoverable: false,
        severity: 'warning',
        title: '배송원 알림 전송 실패',
      });
    }
    for (const order of cancelledOrders) {
      const orderLabel = order.sellerOrderKey ?? order.id;
      items.push({
        createdAt: order.updatedAt.toISOString(),
        description: `${orderLabel} 주문을 미배정 상태로 복구할 수 있습니다.`,
        id: `cancelled-order:${order.id}`,
        kind: 'CANCELLED_ORDER',
        recoverable: true,
        sellerOrderId: order.id,
        severity: 'warning',
        title: '취소 주문 복구 가능',
      });
    }
    for (const review of driverAccountLinks) {
      items.push({
        createdAt: review.createdAt,
        description: '등록 정보가 DSV 배송원 정보와 일부만 일치합니다. 관리 화면에서 연결 대상을 확인하세요.',
        id: `driver-account-link:${review.accountId}:${review.driverId}`,
        kind: 'DRIVER_ACCOUNT_LINK_PENDING',
        recoverable: false,
        severity: 'warning',
        title: '배송원 앱 계정 연결 검토',
      });
    }

    items.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
    return { items: items.slice(0, 100) };
  }
}

function changeRequestState(status: string): Pick<DsvOperationalNotification, 'kind' | 'severity' | 'title'> & { description: string } {
  if (status === 'APPLIED') return { description: '적용되었습니다.', kind: 'CHANGE_APPLIED', severity: 'success', title: '배차 변경 적용 완료' };
  if (status === 'CANCELLED') return { description: '관리자에 의해 취소되었습니다.', kind: 'CHANGE_CANCELLED', severity: 'info', title: '배차 변경 요청 취소' };
  return { description: '배송원 확인을 기다리고 있습니다.', kind: 'CHANGE_PENDING', severity: 'info', title: '배송원 확인 대기' };
}

function recordValue(value: Prisma.JsonValue | null): Record<string, Prisma.JsonValue> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, Prisma.JsonValue>
    : null;
}

function stringValue(value: Prisma.JsonValue | undefined): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}
