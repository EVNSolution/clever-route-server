import type {
  WordPressPluginRoutePlanStatus,
  WordPressPluginStopStatus
} from './wordpress-plugin.types.js';

const routePlanStatusMap = {
  ASSIGNED: 'assigned',
  CANCELLED: 'cancelled',
  COMPLETED: 'completed',
  DRAFT: 'draft',
  IN_PROGRESS: 'in_progress',
  OPTIMIZED: 'optimized'
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
  assigned: 'ASSIGNED',
  cancelled: 'CANCELLED',
  completed: 'COMPLETED',
  draft: 'DRAFT',
  in_progress: 'IN_PROGRESS',
  optimized: 'OPTIMIZED'
};

export function toWordPressRoutePlanStatus(status: string): WordPressPluginRoutePlanStatus {
  const mapped = routePlanStatusMap[status as keyof typeof routePlanStatusMap];
  if (mapped === undefined) {
    throw new Error(`Unsupported route plan status: ${status}`);
  }
  return mapped;
}

export function toInternalRoutePlanStatus(status: string): string | null {
  return internalRoutePlanStatusMap[status as WordPressPluginRoutePlanStatus] ?? null;
}

export function toWordPressStopStatus(status: string): WordPressPluginStopStatus {
  const mapped = stopStatusMap[status as keyof typeof stopStatusMap];
  if (mapped === undefined) {
    throw new Error(`Unsupported delivery stop status: ${status}`);
  }
  return mapped;
}
