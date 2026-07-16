import type { RoutePlanStatus } from '@prisma/client';
import type {
  WordPressPluginRoutePlanStatus,
  WordPressPluginStopStatus
} from './wordpress-plugin.types.js';

const routePlanStatusMap = {
  CANCELLED: 'cancelled',
  READY: 'published',
  IN_PROGRESS: 'published',
  COMPLETED: 'published',
  DRAFT: 'published',
  PUBLISHED: 'published',
  OPTIMIZED: 'published',
  ASSIGNED: 'published'
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

const readyCompatibilityStatuses = ['READY', 'DRAFT', 'PUBLISHED', 'OPTIMIZED', 'ASSIGNED'] as const satisfies readonly RoutePlanStatus[];
const visibleCompatibilityStatuses = [...readyCompatibilityStatuses, 'IN_PROGRESS', 'COMPLETED'] as const satisfies readonly RoutePlanStatus[];

export function toWordPressRoutePlanStatus(status: string): WordPressPluginRoutePlanStatus {
  const mapped = routePlanStatusMap[status as keyof typeof routePlanStatusMap];
  if (mapped === undefined) {
    throw new Error(`Unsupported route plan status: ${status}`);
  }
  return mapped;
}

export function toInternalRoutePlanStatuses(status: string): readonly RoutePlanStatus[] | null {
  if (status === 'cancelled') return ['CANCELLED'];
  if (status === 'published') return visibleCompatibilityStatuses;
  if (status === 'in_progress') return ['IN_PROGRESS'];
  if (status === 'completed') return ['COMPLETED'];
  if (status === 'draft' || status === 'assigned' || status === 'optimized') return readyCompatibilityStatuses;
  return null;
}

export function toWordPressStopStatus(status: string): WordPressPluginStopStatus {
  const mapped = stopStatusMap[status as keyof typeof stopStatusMap];
  if (mapped === undefined) {
    throw new Error(`Unsupported delivery stop status: ${status}`);
  }
  return mapped;
}
