import 'maplibre-gl/dist/maplibre-gl.css';
import './tracking.css';

import maplibregl from 'maplibre-gl';

import { installMissingMapImageFallback } from '../maps/maplibre-missing-images';
import {
  TRACKING_LABELS,
  formatEtaWindow,
  isFinalStage,
  trackingTimeline,
  trackingTimelineTime,
  trackingHeadline,
  type TrackingStatus,
} from './trackingView';

const POLL_MS = 30_000;

const root = document.getElementById('customer-tracking-root');
if (root !== null) void start(root);

async function start(container: HTMLElement): Promise<void> {
  const statusUrl = `${window.location.pathname.replace(/\/+$/u, '')}/status`;
  const mapStyle = container.dataset.mapStyle ?? '';
  const view = createView(container, mapStyle);
  const refresh = async (): Promise<void> => {
    try {
      const response = await fetch(statusUrl, { cache: 'no-store', headers: { accept: 'application/json' } });
      if (!response.ok) {
        view.showError(response.status === 404 ? 'This tracking link is invalid or has expired.' : 'Tracking is temporarily unavailable.');
        return;
      }
      const { data } = (await response.json()) as { data: TrackingStatus };
      view.render(data);
      if (!isFinalStage(data.stage)) window.setTimeout(() => void refresh(), POLL_MS);
    } catch {
      view.showError('Tracking is temporarily unavailable.');
      window.setTimeout(() => void refresh(), POLL_MS);
    }
  };
  await refresh();
}

function createView(container: HTMLElement, mapStyle: string) {
  container.replaceChildren();
  const page = el('main', 'tracking-page');
  const store = el('p', 'tracking-store');
  const card = el('section', 'tracking-card');
  const order = el('p', 'tracking-order');
  const title = el('h1', 'tracking-title');
  const detail = el('p', 'tracking-detail');
  const eta = el('p', 'tracking-eta');
  const recipient = el('p', 'tracking-recipient');
  const timelineBox = el('section', 'tracking-card tracking-timeline');
  const timelineTitle = el('h2', 'tracking-subtitle', 'Delivery timeline');
  timelineTitle.id = 'delivery-timeline-title';
  timelineBox.setAttribute('aria-labelledby', timelineTitle.id);
  const steps = el('ol', 'tracking-steps');
  const mapBox = el('section', 'tracking-map');
  const itemsBox = el('section', 'tracking-card');
  const itemsTitle = el('h2', 'tracking-subtitle', 'Items');
  const items = el('ul', 'tracking-items');
  const error = el('p', 'tracking-error');
  card.append(order, title, detail, eta, recipient);
  timelineBox.append(timelineTitle, steps);
  itemsBox.append(itemsTitle, items);
  page.append(store, error, card, timelineBox, mapBox, itemsBox);
  container.append(page);
  mapBox.hidden = true;
  error.hidden = true;

  let map: maplibregl.Map | null = null;
  let driverMarker: maplibregl.Marker | null = null;

  const renderMap = (status: TrackingStatus): void => {
    const driver = status.driver;
    if (driver === null || mapStyle === '') {
      mapBox.hidden = true;
      return;
    }
    mapBox.hidden = false;
    const center: [number, number] = [driver.longitude, driver.latitude];
    if (map === null) {
      // Zoom only: the view always stays centered on the driver.
      map = new maplibregl.Map({
        attributionControl: { compact: true },
        boxZoom: false,
        center,
        container: mapBox,
        doubleClickZoom: false,
        dragPan: false,
        dragRotate: false,
        keyboard: false,
        maxPitch: 0,
        pitchWithRotate: false,
        scrollZoom: { around: 'center' },
        style: mapStyle,
        touchPitch: false,
        touchZoomRotate: { around: 'center' },
        zoom: 14,
      });
      map.touchZoomRotate.disableRotation();
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
      installMissingMapImageFallback(map);
      // Compact attribution starts expanded and only collapses on drag, which is disabled here.
      map.once('idle', () => {
        const attribution = mapBox.querySelector('.maplibregl-ctrl-attrib.maplibregl-compact');
        attribution?.classList.remove('maplibregl-compact-show');
        attribution?.removeAttribute('open');
      });
      driverMarker = new maplibregl.Marker({ element: el('div', 'tracking-driver-marker') }).setLngLat(center).addTo(map);
      if (status.destination !== null) {
        new maplibregl.Marker({ color: '#1f6feb' })
          .setLngLat([status.destination.longitude, status.destination.latitude])
          .addTo(map);
      }
      return;
    }
    driverMarker?.setLngLat(center);
    map.setCenter(center);
  };

  return {
    render(status: TrackingStatus): void {
      error.hidden = true;
      card.hidden = false;
      document.title = `Order ${status.orderName} from ${status.storeName}`;
      store.textContent = status.storeName;
      order.textContent = `Order ${status.orderName}`;
      const headline = trackingHeadline(status);
      title.textContent = headline.title;
      detail.textContent = headline.detail ?? '';
      detail.hidden = headline.detail === null;
      eta.textContent = status.etaWindow === null ? '' : `Estimated arrival: ${formatEtaWindow(status.etaWindow, status.timezone)}`;
      eta.hidden = status.etaWindow === null;
      recipient.textContent = [status.recipientName, status.address].filter((part) => part !== '').join(', ');

      steps.replaceChildren(...trackingTimeline(status).map((entry) => {
        const step = el('li', `tracking-step is-${entry.state.toLowerCase()}`);
        const text = el('div', 'tracking-step-content');
        text.append(el('span', 'tracking-step-label', TRACKING_LABELS[entry.kind]));
        const timestamp = el(entry.occurredAt === null ? 'span' : 'time', 'tracking-step-time', trackingTimelineTime(entry, status.timezone));
        if (entry.occurredAt !== null) timestamp.setAttribute('datetime', entry.occurredAt);
        text.append(timestamp);
        if (entry.state === 'CURRENT') {
          step.setAttribute('aria-current', 'step');
          text.append(el('span', 'tracking-step-current', 'Current status'));
        }
        if (entry.kind === 'MISSED' || entry.kind === 'CANCELLED') step.classList.add('is-exception');
        step.append(text);
        return step;
      }));

      items.replaceChildren(...status.items.map((item) => el('li', 'tracking-item', `${item.quantity} × ${item.name}`)));
      itemsBox.hidden = status.items.length === 0;
      renderMap(status);
    },
    showError(message: string): void {
      error.textContent = message;
      error.hidden = false;
    },
  };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
