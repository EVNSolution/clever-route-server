import type { DecryptedWooCommerceConnection } from '../commerce/commerce-connection.service.js';
import type { WooCommerceOrder } from '../woocommerce/woocommerce-order.types.js';
import type {
  WordPressPluginConnectionContext,
  WordPressPluginSyncRequestInput,
  WordPressPluginSyncRequestResult
} from './wordpress-plugin.types.js';

export type WordPressPluginSyncServiceDependencies = {
  connectionService: {
    readDecryptedWooCommerceConnection(input: { connectionId: string }): Promise<DecryptedWooCommerceConnection | null>;
  };
  createOrderSyncService(input: { connection: DecryptedWooCommerceConnection }): {
    syncUpdatedOrders(input: {
      modifiedAfter?: Date | null;
      pageSize: number;
      status?: string | null;
    }): Promise<{
      pagesRead: number;
      sync: WordPressPluginSyncRequestResult['sync'];
    }>;
  };
  freshnessRepository: {
    markRestSyncCompleted(input: { at: Date; connectionId: string }): Promise<void>;
  };
  now?: () => Date;
  validateConnectionSiteUrl?(input: { connection: DecryptedWooCommerceConnection }): Promise<void>;
};

export class WordPressPluginSyncRequestService {
  constructor(private readonly dependencies: WordPressPluginSyncServiceDependencies) {}

  async requestSync(input: {
    context: WordPressPluginConnectionContext;
    payload: WordPressPluginSyncRequestInput;
  }): Promise<WordPressPluginSyncRequestResult> {
    const connection = await this.dependencies.connectionService.readDecryptedWooCommerceConnection({
      connectionId: input.context.connectionId
    });
    if (connection === null) {
      throw new Error('WooCommerce connection not found for WordPress plugin sync');
    }

    await this.dependencies.validateConnectionSiteUrl?.({ connection });

    const orderSyncService = this.dependencies.createOrderSyncService({ connection });
    const result = await orderSyncService.syncUpdatedOrders({
      modifiedAfter: input.payload.modifiedAfter ?? null,
      pageSize: input.payload.pageSize,
      status: input.payload.status ?? null
    });

    await this.dependencies.freshnessRepository.markRestSyncCompleted({
      at: this.dependencies.now?.() ?? new Date(),
      connectionId: input.context.connectionId
    });

    return {
      pagesRead: result.pagesRead,
      sync: result.sync,
      warnings: deriveWarnings(result.sync)
    };
  }
}

function deriveWarnings(sync: WordPressPluginSyncRequestResult['sync']): string[] {
  const warnings: string[] = [];
  if (sync.needsReview > 0) {
    warnings.push(`${sync.needsReview} synced orders need delivery metadata review before routing.`);
  }
  return warnings;
}

export type WordPressPluginOrderSyncService = {
  syncUpdatedOrders(input: {
    modifiedAfter?: Date | null;
    pageSize: number;
    status?: string | null;
  }): Promise<{
    orders: WooCommerceOrder[];
    pagesRead: number;
    sync: WordPressPluginSyncRequestResult['sync'];
  }>;
};
