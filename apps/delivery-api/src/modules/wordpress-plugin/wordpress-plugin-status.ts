import type {
  WordPressPluginRoutePlanStatus,
  WordPressPluginStopStatus
} from './wordpress-plugin.types.js';

const routePlanStatusMap = {
  CANCELLED: 'cancelled',
  DRAFT: 'draft',
  PUBLISHED: 'published'
} as const satisfies Record<string, WordPressPluginRoutePlanStatus>;

const stopStatusMap = {
  ARRIVED: 'arrived',
  ASSIGNED: 'assigned',
  CANCELLED: 'cancelled',
  DELIVERED: 'delivered',
  EN_ROUTE: 'en_route',
  FAILED: 'failed',
  PENDING: 'pending',
  SKIPPED: 'skipped'
} as const satisfies Record<string, WordPressPluginStopStatus>;

const internalRoutePlanStatusMap: Record<WordPressPluginRoutePlanStatus, keyof typeof routePlanStatusMap> = {
  cancelled: 'CANCELLED',
  draft: 'DRAFT',
  published: 'PUBLISHED'
};

const legacyInternalRoutePlanStatusMap: Record<string, keyof typeof routePlanStatusMap> = {
  assigned: 'PUBLISHED',
  completed: 'PUBLISHED',
  in_progress: 'PUBLISHED',
  optimized: 'PUBLISHED'
};

export function toWordPressRoutePlanStatus(status: string): WordPressPluginRoutePlanStatus {
  const mapped = routePlanStatusMap[status as keyof typeof routePlanStatusMap];
  if (mapped === undefined) {
    throw new Error(`Unsupported route plan status: ${status}`);
  }
  return mapped;
}

export function toInternalRoutePlanStatus(status: string): string | null {
  return internalRoutePlanStatusMap[status as WordPressPluginRoutePlanStatus] ?? legacyInternalRoutePlanStatusMap[status] ?? null;
}

export function toWordPressStopStatus(status: string): WordPressPluginStopStatus {
  const mapped = stopStatusMap[status as keyof typeof stopStatusMap];
  if (mapped === undefined) {
    throw new Error(`Unsupported delivery stop status: ${status}`);
  }
  return mapped;
}
