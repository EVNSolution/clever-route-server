export type TrackingStage = 'CANCELLED' | 'DELIVERED' | 'MISSED' | 'ON_THE_WAY' | 'PREPARING';

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
};

export const TRACKING_STEPS = ['Being prepared', 'On the way', 'Delivered'] as const;

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

// Index of the last reached step in TRACKING_STEPS; -1 hides the timeline.
export function reachedStep(stage: TrackingStage): number {
  if (stage === 'PREPARING') return 0;
  if (stage === 'ON_THE_WAY') return 1;
  if (stage === 'DELIVERED') return 2;
  return -1;
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
