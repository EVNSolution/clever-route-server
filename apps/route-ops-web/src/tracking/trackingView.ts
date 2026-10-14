export type TrackingStage = 'CANCELLED' | 'DELIVERED' | 'MISSED' | 'ON_THE_WAY' | 'PREPARING';

export type TrackingTimelineEntry = {
  kind: 'PREPARING' | 'SCHEDULED' | 'OUT_FOR_DELIVERY' | 'DRIVER_NEARBY' | 'DELIVERED' | 'MISSED' | 'CANCELLED';
  occurredAt: string | null;
  state: 'COMPLETED' | 'CURRENT' | 'UPCOMING' | 'NOT_RECORDED';
};

export type TrackingStatus = {
  address: string;
  destination: { latitude: number; longitude: number } | null;
  driver: { latitude: number; longitude: number; updatedAt: string } | null;
  etaWindow: { end: string; start: string } | null;
  items: Array<{ name: string; quantity: number }>;
  orderName: string;
  recipientName: string;
  stage: TrackingStage;
  stopsAway: number | null;
  storeName: string;
  timezone: string | null;
  timeline?: TrackingTimelineEntry[];
};

export const TRACKING_LABELS: Record<TrackingTimelineEntry['kind'], string> = {
  PREPARING: 'Being prepared',
  SCHEDULED: 'Delivery scheduled',
  OUT_FOR_DELIVERY: 'Out for delivery',
  DRIVER_NEARBY: 'Driver nearby',
  DELIVERED: 'Delivered',
  MISSED: 'Delivery missed',
  CANCELLED: 'Delivery cancelled',
};

export function isFinalStage(stage: TrackingStage): boolean {
  return stage === 'DELIVERED' || stage === 'MISSED' || stage === 'CANCELLED';
}

export function trackingHeadline(status: Pick<TrackingStatus, 'stage' | 'stopsAway' | 'storeName'>): { detail: string | null; title: string } {
  switch (status.stage) {
    case 'PREPARING':
      return { detail: null, title: 'Your order is being prepared for delivery' };
    case 'ON_THE_WAY':
      return {
        detail: status.stopsAway === null ? null : status.stopsAway === 0 ? 'Your driver is arriving now.' : `Your driver is ${status.stopsAway} ${status.stopsAway === 1 ? 'stop' : 'stops'} away.`,
        title: 'Your order is on the way',
      };
    case 'DELIVERED':
      return { detail: null, title: 'Your order has been delivered' };
    case 'MISSED':
      return { detail: `Please contact ${status.storeName} to reschedule.`, title: 'Sorry, we missed you' };
    case 'CANCELLED':
      return { detail: `Please contact ${status.storeName} for details.`, title: 'This delivery was cancelled' };
  }
}

export function trackingTimeline(status: Pick<TrackingStatus, 'stage' | 'timeline'>): TrackingTimelineEntry[] {
  // During a rolling deployment, show only the known current status. Do not invent previous milestones.
  return status.timeline ?? [{
    kind: status.stage === 'ON_THE_WAY' ? 'OUT_FOR_DELIVERY' : status.stage,
    occurredAt: null,
    state: 'CURRENT',
  }];
}

export function trackingTimelineTime(entry: TrackingTimelineEntry, timezone: string | null): string {
  if (entry.occurredAt === null) {
    if (entry.state === 'UPCOMING') return 'Not yet';
    if (entry.state === 'NOT_RECORDED') return 'Not recorded';
    return 'Time not recorded';
  }
  return new Intl.DateTimeFormat('en-US', {
    day: 'numeric', hour: 'numeric', minute: '2-digit', month: 'short',
    timeZone: timezone ?? 'UTC', timeZoneName: 'short', weekday: 'short',
  }).format(new Date(entry.occurredAt));
}

export function formatEtaWindow(window: { end: string; start: string }, timezone: string | null): string {
  const zone = timezone ?? undefined;
  const day = new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short', timeZone: zone, weekday: 'short' });
  const time = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: zone });
  const start = new Date(window.start);
  const end = new Date(window.end);
  const sameDay = day.format(start) === day.format(end);
  return sameDay
    ? `${day.format(start)}, ${time.format(start)} – ${time.format(end)}`
    : `${day.format(start)}, ${time.format(start)} – ${day.format(end)}, ${time.format(end)}`;
}
