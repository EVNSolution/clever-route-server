import type { PrismaClient } from '@prisma/client';

import type { WooCommerceSyncOrdersResult } from '../woocommerce/woocommerce-order-sync.service.js';
import type {
  WordPressPluginConnectionContext,
  WordPressPluginSyncRequestInput,
  WordPressPluginSyncRequestResult,
  WordPressPluginSyncRun
} from '../wordpress-plugin/wordpress-plugin.types.js';
import type { WordPressPluginSyncRequestService } from '../wordpress-plugin/wordpress-plugin-sync.service.js';
import { normalizeShopDomain } from './commerce-connection.repository.js';
import { WooCommerceOnboardingError } from './woocommerce-connection-onboarding.service.js';

type AdminWooSyncPrismaClient = Pick<PrismaClient, 'commerceConnection'>;

export type AdminWooSyncRequestResult = WordPressPluginSyncRequestResult & {
  startBackgroundProcessing: boolean;
};

export class AdminWooSyncService {
  constructor(
    private readonly dependencies: {
      prisma: AdminWooSyncPrismaClient;
      syncService: WordPressPluginSyncRequestService;
    }
  ) {}

  async requestSync(input: {
    payload: WordPressPluginSyncRequestInput;
    shopDomain: string;
  }): Promise<AdminWooSyncRequestResult> {
    const context = await this.requireActiveWooContext(input.shopDomain);
    return this.dependencies.syncService.requestSync({
      context,
      payload: input.payload,
      source: 'route_ops_admin_ui',
      trigger: 'admin_ui_manual_rest_backfill'
    });
  }

  async processSyncRun(input: { shopDomain: string; syncRunId: string }): Promise<WordPressPluginSyncRun | null> {
    const context = await this.requireActiveWooContext(input.shopDomain);
    return this.dependencies.syncService.processSyncRun({
      context,
      syncRunId: input.syncRunId
    });
  }

  async readLatestSyncRun(input: { shopDomain: string }): Promise<WordPressPluginSyncRun | null> {
    const context = await this.requireActiveWooContext(input.shopDomain);
    return this.dependencies.syncService.readLatestSyncRun({ context });
  }

  async readSyncRun(input: { shopDomain: string; syncRunId: string }): Promise<WordPressPluginSyncRun | null> {
    const context = await this.requireActiveWooContext(input.shopDomain);
    return this.dependencies.syncService.readSyncRun({
      context,
      syncRunId: input.syncRunId
    });
  }

  async syncSingleOrder(input: {
    shopDomain: string;
    sourceOrderId: number | string;
  }): Promise<WooCommerceSyncOrdersResult> {
    const context = await this.requireActiveWooContext(input.shopDomain);
    return this.dependencies.syncService.syncSingleOrder({
      context,
      sourceOrderId: input.sourceOrderId
    });
  }

  private async requireActiveWooContext(shopDomain: string): Promise<WordPressPluginConnectionContext> {
    const normalizedShopDomain = normalizeShopDomain(shopDomain);
    const connection = await this.dependencies.prisma.commerceConnection.findFirst({
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        label: true,
        shopDomain: true,
        shopId: true,
        siteUrl: true,
        status: true
      },
      where: {
        platform: 'WOOCOMMERCE',
        shopDomain: normalizedShopDomain,
        status: 'ACTIVE'
      }
    });
    if (connection === null) {
      throw new WooCommerceOnboardingError(
        'NOT_FOUND',
        'Active WooCommerce connection not found for this shopDomain.',
        404
      );
    }
    return {
      connectionId: connection.id,
      label: connection.label,
      shopDomain: connection.shopDomain,
      shopId: connection.shopId,
      siteUrl: connection.siteUrl,
      status: connection.status,
      tokenId: 'route-ops-admin-ui',
      tokenPrefix: 'route-ops-admin-ui'
    };
  }
}

export type AdminWooSyncServiceApi = Pick<
  AdminWooSyncService,
  'processSyncRun' | 'readLatestSyncRun' | 'readSyncRun' | 'requestSync' | 'syncSingleOrder'
>;
