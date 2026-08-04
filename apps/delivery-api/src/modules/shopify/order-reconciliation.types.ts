export type ShopifyOrderReconciliationJobStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'RETRY_WAIT'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'DEAD_LETTER'
  | 'CANCELLED';

export type ShopifyOrderReconciliationJobMode = 'INCREMENTAL' | 'FULL';

export type ShopifyOrderReconciliationJobDto = {
  appId: string;
  attemptCount: number;
  correlationId: string;
  counts: {
    created: number;
    failed: number;
    finalCanonical: number | null;
    scanned: number;
    staleSkipped: number;
    unchanged: number;
    updated: number;
  };
  createdAt: string;
  deadLetteredAt: string | null;
  finishedAt: string | null;
  highWatermark: string | null;
  id: string;
  lastError: { code: string; message: string } | null;
  mode: ShopifyOrderReconciliationJobMode;
  nextRunAt: string;
  overlapWindowSeconds: number;
  pageSize: number;
  pageCursor: string | null;
  requestedBy: string | null;
  shopDomain: string;
  startedAt: string | null;
  startedFrom: string | null;
  status: ShopifyOrderReconciliationJobStatus;
  updatedAt: string;
  warningCount: number;
};

export type ClaimedShopifyOrderReconciliationJob = ShopifyOrderReconciliationJobDto & {
  leaseToken: string;
};

export type EnqueueShopifyOrderReconciliationInput = {
  appId?: string | undefined;
  correlationId?: string | undefined;
  mode?: ShopifyOrderReconciliationJobMode | undefined;
  overlapWindowSeconds?: number | undefined;
  pageSize?: number | undefined;
  requestedBy?: string | undefined;
  shopDomain: string;
};
