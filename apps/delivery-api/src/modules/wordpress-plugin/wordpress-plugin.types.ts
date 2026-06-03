import type { CommerceConnectionStatus } from '@prisma/client';

export type WordPressPluginConnectionContext = {
  connectionId: string;
  label: string | null;
  shopDomain: string;
  shopId: string;
  siteUrl: string;
  status: CommerceConnectionStatus;
  tokenId: string;
  tokenPrefix: string;
};

export type WordPressPluginPairInput = {
  hposEnabled?: boolean | null;
  pairingCode: string;
  pluginVersion?: string | null;
  siteUrl: string;
  wooVersion?: string | null;
  wpVersion?: string | null;
};

export type WordPressPluginPairResult = {
  connectionId: string;
  expiresAt: string;
  siteUrl: string;
  token: string;
  tokenPrefix: string;
};

export type WordPressPluginFreshness = {
  lastRestSyncAt: string | null;
  lastRouteUpdatedAt: string | null;
  lastWebhookAt: string | null;
  serverTime: string;
};

export type WordPressPluginHealth = {
  connection: {
    connectionId: string;
    label: string | null;
    shopDomain: string;
    siteUrl: string;
    state: 'connected' | 'disabled';
    tokenPrefix: string;
  };
  freshness: WordPressPluginFreshness;
  latestSyncRun?: WordPressPluginSyncRun | null;
};

export type WordPressPluginRoutePlanSummary = {
  createdAt: string;
  deliveryDate: string | null;
  driver: {
    displayName: string;
    id: string;
    status: string;
  } | null;
  durationSeconds: number | null;
  id: string;
  name: string;
  planDate: string;
  status: WordPressPluginRoutePlanStatus;
  stopCount: number;
  totalDistanceMeters: number | null;
  updatedAt: string;
};

export type WordPressPluginRoutePlanStatus =
  | 'assigned'
  | 'cancelled'
  | 'completed'
  | 'draft'
  | 'in_progress'
  | 'optimized';

export type WordPressPluginStopStatus =
  | 'arrived'
  | 'assigned'
  | 'cancelled'
  | 'delivered'
  | 'en_route'
  | 'failed'
  | 'pending'
  | 'skipped';

export type WordPressPluginRoutePlanStop = {
  address: {
    address1: string | null;
    address2: string | null;
    city: string | null;
    countryCode: string | null;
    postalCode: string | null;
    province: string | null;
  };
  deliveryDate: string | null;
  deliveryStopId: string;
  estimatedArrivalAt: string | null;
  order: {
    id: string;
    name: string;
    sourceOrderId: string | null;
    sourceOrderNumber: string | null;
    sourcePlatform: string | null;
    sourceSiteUrl: string | null;
  };
  recipientName: string | null;
  sequence: number;
  status: WordPressPluginStopStatus;
  timeWindowEnd: string | null;
  timeWindowStart: string | null;
};

export type WordPressPluginRoutePlanDetail = {
  routePlan: WordPressPluginRoutePlanSummary;
  stops: WordPressPluginRoutePlanStop[];
};

export type WordPressPluginRoutePlanFilters = {
  driverId?: string | null;
  from?: string | null;
  status?: string | null;
  to?: string | null;
};

export type WordPressPluginMappingConfig = {
  addressPreference: 'shipping';
  config?: unknown;
  deliveryAreaMetaKey: string;
  deliveryDateMetaKey: string;
  deliveryTimeMetaKey: string;
  diagnostics?: {
    discoveredPathStats: Record<string, number>;
    unparseableValueCount: number;
    unsupportedValueCount: number;
  };
  editable: false;
  matchedMappingPaths?: Record<string, number>;
  notesField: 'customer_note';
  phonePreference: 'billing_then_shipping';
  preview: {
    address: 'redacted';
    phone: 'redacted';
    recipientName: 'redacted';
  };
};

export type WordPressPluginSyncRequestInput = {
  modifiedAfter?: Date | null;
  pageSize: number;
  status?: string | null;
};

export type WordPressPluginSyncRunStatus = 'FAILED' | 'QUEUED' | 'RUNNING' | 'SUCCEEDED';

export type WordPressPluginSyncRunRequest = {
  duplicateCount?: number;
  finalizedAt?: string | null;
  expectedChunkCount?: number | null;
  expectedOrderCount?: number | null;
  invalidCount?: number;
  mode?: 'raw_push' | 'rest_backfill';
  modifiedAfter: string | null;
  pageSize: number;
  status: string | null;
};

export type WordPressPluginSyncCounts = {
  created: number;
  failed?: number;
  needsReview: number;
  rawRefreshed?: number;
  readyToPlan: number;
  received: number;
  skipped: number;
  unchanged: number;
  updated: number;
};

export type WordPressPluginSyncGeocodeSummary = {
  failed: number;
  notRequired: number;
  pending: number;
  resolved: number;
};

export type WordPressPluginRawSyncFailure = {
  failureCode: string;
  message: string;
  retryable: boolean;
  sourceOrderId: string;
  sourceOrderNumber?: string | null;
};

export type WordPressPluginRawSyncStatus = {
  accepted: number;
  chunksReceived: number;
  duplicate: number;
  expectedChunkCount: number | null;
  expectedOrderCount: number | null;
  failed: number;
  failures: WordPressPluginRawSyncFailure[];
  finalizedAt: string | null;
  invalid: number;
  processed: number;
  rawRefreshed: number;
  skipped: number;
  waitingForChunks: boolean;
};

export type WordPressPluginRawSyncRequestInput = WordPressPluginSyncRequestInput;

export type WordPressPluginRawOrderInput = Record<string, unknown>;

export type WordPressPluginRawSyncChunkInput = {
  chunkCount?: number | null;
  chunkId: string;
  chunkIndex: number;
  orders: WordPressPluginRawOrderInput[];
  syncRunId: string;
};

export type WordPressPluginRawSyncFinalizeInput = {
  expectedChunkCount?: number | null;
  expectedOrderCount?: number | null;
  syncRunId: string;
};

export type WordPressPluginRawSyncChunkResult = {
  accepted: number;
  duplicate: number;
  invalid: number;
  message: string;
  startBackgroundProcessing: boolean;
  syncRun: WordPressPluginSyncRun;
};

export type WordPressPluginRawSyncFinalizeResult = {
  message: string;
  startBackgroundProcessing: boolean;
  syncRun: WordPressPluginSyncRun;
};

export type WordPressPluginSyncRun = {
  acceptedAt: string;
  completedAt: string | null;
  errorMessage: string | null;
  request: WordPressPluginSyncRunRequest;
  raw?: WordPressPluginRawSyncStatus | null;
  result: {
    geocode: WordPressPluginSyncGeocodeSummary;
    pagesRead: number;
    sync: WordPressPluginSyncCounts;
    warnings: string[];
  } | null;
  startedAt: string | null;
  status: WordPressPluginSyncRunStatus;
  syncRunId: string;
};

export type WordPressPluginSyncRequestResult = {
  alreadyRunning: boolean;
  message: string;
  syncRun: WordPressPluginSyncRun;
};

export type WordPressPluginSyncRunResult = {
  geocode: WordPressPluginSyncGeocodeSummary;
  pagesRead: number;
  sync: WordPressPluginSyncCounts;
  warnings: string[];
};
