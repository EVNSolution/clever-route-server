import type {
  RouteTrackingPositionEventV1,
  RouteTrackingProgressEventV1
} from './route-tracking.types.js';

export type RouteTrackingStreamEvent =
  | { data: RouteTrackingPositionEventV1; eventName: 'tracking_position' }
  | { data: RouteTrackingProgressEventV1; eventName: 'tracking_progress' };

type RouteTrackingStreamListener = (event: RouteTrackingStreamEvent) => void;

/**
 * Process-local route-scoped fanout for live tracking streams.
 *
 * DriverEvent rows remain the durable source of truth. Initial snapshots recover
 * missed events after reconnect; horizontal runtime fanout needs a shared
 * pub/sub bridge before multi-process delivery-api streaming is enabled.
 */
export class RouteTrackingStreamHub {
  private readonly listenersByRoutePlanId = new Map<string, Set<RouteTrackingStreamListener>>();

  subscribeToRoute(routePlanId: string, listener: RouteTrackingStreamListener): () => void {
    const listeners = this.listenersByRoutePlanId.get(routePlanId) ?? new Set<RouteTrackingStreamListener>();
    listeners.add(listener);
    this.listenersByRoutePlanId.set(routePlanId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listenersByRoutePlanId.delete(routePlanId);
    };
  }

  publishPosition(event: RouteTrackingPositionEventV1): void {
    this.publish({ data: event, eventName: 'tracking_position' });
  }

  publishProgress(event: RouteTrackingProgressEventV1): void {
    this.publish({ data: event, eventName: 'tracking_progress' });
  }

  private publish(event: RouteTrackingStreamEvent): void {
    const listeners = this.listenersByRoutePlanId.get(event.data.routePlanId);
    if (listeners === undefined || listeners.size === 0) return;
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // Browser stream listeners are advisory; one broken stream must not
        // prevent other subscribers on the same route from receiving updates.
      }
    }
  }

  listenerCount(routePlanId?: string): number {
    if (routePlanId !== undefined) return this.listenersByRoutePlanId.get(routePlanId)?.size ?? 0;
    let count = 0;
    for (const listeners of this.listenersByRoutePlanId.values()) count += listeners.size;
    return count;
  }
}
