import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';

import { buildOrdersMapFeatureCollection, buildRouteGeometryFeature, fitBoundsForPoints, getOrderMapPoints, getRouteMapPoints, getRouteSnappedStopPoints, type RouteLineFeature, type RouteOpsPoint } from '../../maps/geojson';
import { installMissingMapImageFallback } from '../../maps/maplibre-missing-images';
import { installPmtilesProtocol } from '../../maps/pmtiles';
import { mapReadiness } from '../../maps/provider';
import type { BootstrapPayload, CanonicalOrderDto, RoutePlanDetailDto } from '../../types';

type MapLibreModule = typeof import('maplibre-gl');
type MapLibreMap = InstanceType<MapLibreModule['Map']>;
type MapLibreMarker = InstanceType<MapLibreModule['Marker']>;
type MapLayerClickEvent = { features?: Array<{ properties?: { orderId?: string } }> };

const ORDER_PIN_IMAGE_ID = 'orders-map-pin';
const ORDER_PIN_PLANNED_IMAGE_ID = 'orders-map-pin-planned';
const ORDER_PIN_REVIEW_IMAGE_ID = 'orders-map-pin-review';
const ORDER_PIN_PIXEL_RATIO = 2;
const ORDER_PIN_ICON_SIZE = 0.62;
const ORDER_PIN_PATH = 'M20 50C20 50 4 31.5 4 18C4 9.16 11.16 2 20 2s16 7.16 16 16c0 13.5-16 32-16 32Z';
const EMPTY_ROUTE_LINE_COLLECTION = { features: [], type: 'FeatureCollection' } as const;

type RouteOpsMapProps = {
  bootstrap: BootstrapPayload;
  detail?: RoutePlanDetailDto | null;
  depot?: RouteOpsPoint | null;
  onMapClickCoordinate?(coordinate: { latitude: number; longitude: number }): void;
  onOrderSelect?(orderId: string): void;
  orders?: CanonicalOrderDto[];
  plannedOrderIds?: ReadonlySet<string>;
  subtitle: string;
  title: string;
};

export function RouteOpsMap({ bootstrap, depot = null, detail = null, onMapClickCoordinate, onOrderSelect, orders = [], plannedOrderIds = new Set<string>(), subtitle, title }: RouteOpsMapProps): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const maplibreRef = useRef<MapLibreModule | null>(null);
  const markersRef = useRef<MapLibreMarker[]>([]);
  const onMapClickCoordinateRef = useRef(onMapClickCoordinate);
  const onOrderSelectRef = useRef(onOrderSelect);
  const homePointRef = useRef<RouteOpsPoint | null>(null);
  const pointsRef = useRef<RouteOpsPoint[]>([]);
  const ordersHomeAppliedRef = useRef<string | null>(null);
  const [isMapReady, setIsMapReady] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const [fitRequest, setFitRequest] = useState(0);

  const points = useMemo(() => (detail === null ? prependDepotPoint(depot, getOrderMapPoints(orders)) : getRouteMapPoints(detail)), [depot, detail, orders]);
  const homePoint = useMemo(() => resolveMapHomePoint(detail, depot, points), [depot, detail, points]);
  const readiness = mapReadiness({ coordinatesCount: points.length, mapStatus: bootstrap.mapConfig.status });
  const routeGeometry = useMemo(() => buildRouteGeometryFeature(detail), [detail]);
  const snappedStopPoints = useMemo(() => getRouteSnappedStopPoints(detail), [detail]);
  const lineFeature = detail === null ? null : routeGeometry;
  const ordersGeojson = useMemo(() => buildOrdersMapFeatureCollection(orders, plannedOrderIds), [orders, plannedOrderIds]);

  useEffect(() => {
    onMapClickCoordinateRef.current = onMapClickCoordinate;
  }, [onMapClickCoordinate]);

  useEffect(() => {
    onOrderSelectRef.current = onOrderSelect;
  }, [onOrderSelect]);

  useEffect(() => {
    homePointRef.current = homePoint;
  }, [homePoint]);

  useEffect(() => {
    pointsRef.current = points;
  }, [points]);

  useEffect(() => {
    if (readiness !== 'interactive_map' || bootstrap.mapConfig.styleUrl === null || containerRef.current === null || mapRef.current !== null) return undefined;
    let mounted = true;

    async function initializeMap(): Promise<void> {
      try {
        const requiresPmtiles = styleRequiresPmtiles(bootstrap.mapConfig.styleAudit?.endpoints ?? []);
        const [{ default: maplibregl }, pmtilesModule] = await Promise.all([
          import('maplibre-gl'),
          requiresPmtiles ? import('pmtiles') : Promise.resolve(null)
        ]);
        if (!mounted || containerRef.current === null || mapRef.current !== null || bootstrap.mapConfig.styleUrl === null) return;
        if (pmtilesModule !== null) installPmtilesProtocol(maplibregl, pmtilesModule.Protocol);
        maplibreRef.current = maplibregl;
        ordersHomeAppliedRef.current = null;
        const firstPoint = homePointRef.current ?? pointsRef.current[0];
        const map = new maplibregl.Map({
          attributionControl: { compact: true },
          cancelPendingTileRequestsWhileZooming: true,
          center: firstPoint === undefined ? [-79.3832, 43.6532] : [firstPoint.longitude, firstPoint.latitude],
          container: containerRef.current,
          dragRotate: false,
          fadeDuration: 0,
          maxPitch: 0,
          minZoom: 8,
          pitchWithRotate: false,
          refreshExpiredTiles: false,
          renderWorldCopies: false,
          style: bootstrap.mapConfig.styleUrl,
          touchPitch: false,
          validateStyle: false,
          zoom: firstPoint?.kind === 'depot' ? 10 : 12
        });
        mapRef.current = map;
        installMissingMapImageFallback(map);
        map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
        map.on('load', () => {
          if (!mounted) return;
          setIsMapReady(true);
          setMapError(null);
        });
        map.on('click', (event: { lngLat?: { lat: number; lng: number } }) => {
          if (event.lngLat === undefined) return;
          onMapClickCoordinateRef.current?.({ latitude: event.lngLat.lat, longitude: event.lngLat.lng });
        });
        map.on('error', (event: { error?: { message?: string } }) => {
          if (!mounted) return;
          setMapError(event.error?.message ?? 'Map provider request failed');
        });
      } catch (error) {
        if (!mounted) return;
        setMapError(error instanceof Error ? error.message : 'Map library failed to load');
      }
    }

    void initializeMap();
    return () => {
      mounted = false;
      markersRef.current.forEach((marker) => safeRemoveMarker(marker));
      markersRef.current = [];
      const map = mapRef.current;
      mapRef.current = null;
      maplibreRef.current = null;
      ordersHomeAppliedRef.current = null;
      setIsMapReady(false);
      if (map !== null) safeRemoveMap(map);
    };
  }, [bootstrap.mapConfig.styleUrl, readiness]);

  useEffect(() => {
    if (!isMapReady || mapRef.current === null || !isMapUsable(mapRef.current)) return;
    const map = mapRef.current;
    if (detail === null) syncOrdersLayer(map, ordersGeojson);
    syncRouteLayers(map, lineFeature);
    syncRouteMarkers(map, maplibreRef.current, detail === null ? points.filter((point) => point.kind === 'depot') : [...snappedStopPoints, ...points], markersRef.current);
    if (detail !== null) {
      fitMap(map, maplibreRef.current, points);
      return;
    }
    applyOrdersHomeViewport(map, homePoint, ordersHomeAppliedRef);
  }, [detail, homePoint, isMapReady, lineFeature, ordersGeojson, points, snappedStopPoints]);

  useEffect(() => {
    if (fitRequest === 0 || !isMapReady || mapRef.current === null || !isMapUsable(mapRef.current)) return;
    const map = mapRef.current;
    if (detail === null) {
      const target = homePoint ?? points[0] ?? null;
      if (target !== null) centerMapOnPoint(map, target);
      return;
    }
    fitMap(map, maplibreRef.current, points);
  }, [detail, fitRequest, homePoint, isMapReady, points]);

  useEffect(() => {
    if (!isMapReady || detail !== null || mapRef.current === null || onOrderSelect === undefined) return undefined;
    const map = mapRef.current;
    if (!safeGetLayer(map, 'route-ops-order-pins')) return undefined;
    const handleOrderPinClick = (event: MapLayerClickEvent): void => {
      const orderId = event.features?.[0]?.properties?.orderId;
      if (typeof orderId === 'string') onOrderSelectRef.current?.(orderId);
    };
    map.on('click', 'route-ops-order-pins', handleOrderPinClick);
    return () => {
      safeLayerOff(map, 'click', 'route-ops-order-pins', handleOrderPinClick);
    };
  }, [detail, isMapReady, onOrderSelect]);

  return (
    <article className="map-panel panel" data-route-map>
      <div className="panel-heading">
        <div><h2>{title}</h2><p>{subtitle}</p></div>
      </div>
      <div className="route-ops-map-frame" data-map-provider-mode={bootstrap.mapConfig.providerMode ?? 'none'} data-map-provider-status={bootstrap.mapConfig.status}>
        {readiness === 'interactive_map' ? <div className="map-toolbar"><button aria-label={detail === null ? 'Center map on store' : 'Zoom map to fit'} onClick={() => setFitRequest((value) => value + 1)} title={detail === null ? 'Center map on store' : 'Zoom map to fit'} type="button"><FitMapIcon /></button></div> : null}
        {readiness === 'interactive_map' ? <div className="route-ops-map-canvas" ref={containerRef} aria-label="Interactive CLEVER route map" /> : <SequencePreview points={points} readiness={readiness} showRouteLine={detail !== null} />}
      </div>
    </article>
  );
}

function prependDepotPoint(depot: RouteOpsPoint | null, points: RouteOpsPoint[]): RouteOpsPoint[] {
  if (depot === null) return points;
  return [depot, ...points.filter((point) => point.id !== depot.id)];
}

export function resolveMapHomePoint(detail: RoutePlanDetailDto | null, depot: RouteOpsPoint | null, points: RouteOpsPoint[]): RouteOpsPoint | null {
  if (detail === null) return depot ?? points[0] ?? null;
  return points.find((point) => point.kind === 'depot') ?? points[0] ?? null;
}

export function syncOrdersLayer(map: MapLibreMap, featureCollection: ReturnType<typeof buildOrdersMapFeatureCollection>): void {
  const existing = safeGetSource(map, 'route-ops-orders') as { setData?(data: unknown): void } | undefined;
  if (existing?.setData) safeSetSourceData(existing, featureCollection);
  else if (!safeAddSource(map, 'route-ops-orders', { data: featureCollection, type: 'geojson' })) return;

  if (!ensureOrdersMapPinImages(map)) {
    syncFallbackCircleOrdersLayer(map);
    return;
  }

  if (!safeGetLayer(map, 'route-ops-order-pins')) {
    safeAddLayer(map, {
      id: 'route-ops-order-pins',
      layout: {
        'icon-allow-overlap': true,
        'icon-anchor': 'bottom',
        'icon-ignore-placement': true,
        'icon-image': ['get', 'pinImage'],
        'icon-size': ORDER_PIN_ICON_SIZE,
        'symbol-sort-key': ['get', 'sortKey']
      },
      source: 'route-ops-orders',
      type: 'symbol'
    });
  }
}

function syncFallbackCircleOrdersLayer(map: MapLibreMap): void {
  if (safeGetLayer(map, 'route-ops-order-pins')) return;
  safeAddLayer(map, {
    id: 'route-ops-order-pins',
    paint: {
      'circle-color': ['match', ['get', 'pinKind'], 'planned', '#e11900', 'review', '#303030', '#006fbb'],
      'circle-radius': 12,
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 3
    },
    source: 'route-ops-orders',
    type: 'circle'
  });
}

function ensureOrdersMapPinImages(map: MapLibreMap): boolean {
  const imageApi = map as unknown as {
    addImage?(id: string, image: ImageData, options?: { pixelRatio?: number }): void;
    hasImage?(id: string): boolean;
  };
  if (typeof imageApi.addImage !== 'function' || typeof imageApi.hasImage !== 'function') return false;
  const images = [
    { color: '#006fbb', id: ORDER_PIN_IMAGE_ID, shadowColor: 'rgba(0, 111, 187, 0.36)' },
    { color: '#e11900', id: ORDER_PIN_PLANNED_IMAGE_ID, shadowColor: 'rgba(225, 25, 0, 0.4)' },
    { color: '#303030', id: ORDER_PIN_REVIEW_IMAGE_ID, shadowColor: 'rgba(48, 48, 48, 0.36)' }
  ];
  for (const image of images) {
    if (safeHasImage(imageApi, image.id)) continue;
    const imageData = createOrderPinImageData(image.color, { shadowColor: image.shadowColor });
    if (imageData === null) return false;
    if (!safeAddImage(imageApi, image.id, imageData)) return false;
  }
  return true;
}

function createOrderPinImageData(color: string, options: { borderWidth?: number; shadowBlur?: number; shadowColor?: string; shadowOffsetY?: number } = {}): ImageData | null {
  if (typeof document === 'undefined' || typeof Path2D === 'undefined') return null;
  const width = 40 * ORDER_PIN_PIXEL_RATIO;
  const height = 52 * ORDER_PIN_PIXEL_RATIO;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (context === null) return null;
  context.scale(ORDER_PIN_PIXEL_RATIO, ORDER_PIN_PIXEL_RATIO);
  const pinPath = new Path2D(ORDER_PIN_PATH);
  context.fillStyle = color;
  context.strokeStyle = '#ffffff';
  context.lineJoin = 'round';
  context.lineWidth = options.borderWidth ?? 3.2;
  context.shadowBlur = options.shadowBlur ?? 4;
  context.shadowColor = options.shadowColor ?? 'rgba(0, 0, 0, 0.32)';
  context.shadowOffsetY = options.shadowOffsetY ?? 2;
  context.fill(pinPath);
  context.shadowColor = 'transparent';
  context.stroke(pinPath);
  return context.getImageData(0, 0, width, height);
}

export function syncRouteLayers(map: MapLibreMap, lineFeature: RouteLineFeature | null): void {
  if (lineFeature === null) {
    const existing = safeGetSource(map, 'route-ops-route-line') as { setData?(data: unknown): void } | undefined;
    if (existing?.setData) safeSetSourceData(existing, EMPTY_ROUTE_LINE_COLLECTION);
    return;
  }
  const existing = safeGetSource(map, 'route-ops-route-line') as { setData?(data: unknown): void } | undefined;
  if (existing?.setData) safeSetSourceData(existing, lineFeature);
  else if (!safeAddSource(map, 'route-ops-route-line', { data: lineFeature, type: 'geojson' })) return;

  const paint = routeLinePaintForKind(lineFeature.properties.kind);
  if (!safeGetLayer(map, 'route-ops-route-line')) {
    safeAddLayer(map, {
      id: 'route-ops-route-line',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint,
      source: 'route-ops-route-line',
      type: 'line'
    });
    return;
  }
  safeSetPaintProperty(map, 'route-ops-route-line', 'line-color', paint['line-color']);
  safeSetPaintProperty(map, 'route-ops-route-line', 'line-dasharray', paint['line-dasharray']);
  safeSetPaintProperty(map, 'route-ops-route-line', 'line-opacity', paint['line-opacity']);
  safeSetPaintProperty(map, 'route-ops-route-line', 'line-width', paint['line-width']);
}

function isMapUsable(map: MapLibreMap): boolean {
  const candidate = map as unknown as { getStyle?(): unknown; removed?: boolean; _removed?: boolean };
  if (candidate.removed === true || candidate._removed === true) return false;
  if (typeof candidate.getStyle !== 'function') return true;
  try {
    return candidate.getStyle() !== undefined;
  } catch {
    return false;
  }
}

function safeGetSource(map: MapLibreMap, id: string): unknown {
  try {
    return map.getSource(id);
  } catch {
    return undefined;
  }
}

function safeGetLayer(map: MapLibreMap, id: string): unknown {
  try {
    return map.getLayer(id);
  } catch {
    return undefined;
  }
}

function safeAddSource(map: MapLibreMap, id: string, source: { data: unknown; type: 'geojson' }): boolean {
  try {
    map.addSource(id, source as Parameters<MapLibreMap['addSource']>[1]);
    return true;
  } catch {
    return false;
  }
}

function safeAddLayer(map: MapLibreMap, layer: Parameters<MapLibreMap['addLayer']>[0]): boolean {
  try {
    map.addLayer(layer);
    return true;
  } catch {
    return false;
  }
}

function safeSetSourceData(source: { setData?(data: unknown): void }, data: unknown): void {
  try {
    source.setData?.(data);
  } catch {
    // The MapLibre style can be torn down during SPA tab transitions; stale writes are intentionally ignored.
  }
}

function safeSetPaintProperty(map: MapLibreMap, layerId: string, property: string, value: unknown): void {
  try {
    map.setPaintProperty(layerId, property, value);
  } catch {
    // The layer may disappear while a tab transition unmounts the map.
  }
}

function safeLayerOff(map: MapLibreMap, type: 'click', layerId: string, listener: (event: MapLayerClickEvent) => void): void {
  try {
    if (safeGetLayer(map, layerId)) map.off(type, layerId, listener);
  } catch {
    // MapLibre can clear style before React runs layer-listener cleanup.
  }
}

function safeRemoveMap(map: MapLibreMap): void {
  try {
    map.remove();
  } catch {
    // Removing a partially initialized map during fast tab navigation can race style teardown.
  }
}

function safeRemoveMarker(marker: MapLibreMarker): void {
  try {
    marker.remove();
  } catch {
    // Marker cleanup should never block SPA navigation.
  }
}

function safeHasImage(imageApi: { hasImage?(id: string): boolean }, id: string): boolean {
  try {
    return imageApi.hasImage?.(id) === true;
  } catch {
    return false;
  }
}

function safeAddImage(imageApi: { addImage?(id: string, image: ImageData, options?: { pixelRatio?: number }): void }, id: string, image: ImageData): boolean {
  try {
    imageApi.addImage?.(id, image, { pixelRatio: ORDER_PIN_PIXEL_RATIO });
    return true;
  } catch {
    return false;
  }
}

function routeLinePaintForKind(kind: 'road_geometry' | 'sequence_preview'): { 'line-color': string; 'line-dasharray': [number, number]; 'line-opacity': number; 'line-width': number } {
  return {
    'line-color': kind === 'road_geometry' ? '#e11900' : '#64748b',
    'line-dasharray': kind === 'road_geometry' ? [1, 0] : [2, 2],
    'line-opacity': kind === 'road_geometry' ? 0.78 : 0.72,
    'line-width': kind === 'road_geometry' ? 4 : 4
  };
}

function styleRequiresPmtiles(endpoints: readonly string[]): boolean {
  return endpoints.some((endpoint) => endpoint.startsWith('pmtiles://'));
}

function syncRouteMarkers(map: MapLibreMap, maplibregl: MapLibreModule | null, points: RouteOpsPoint[], markers: MapLibreMarker[]): void {
  if (maplibregl === null) return;
  markers.forEach((marker) => safeRemoveMarker(marker));
  markers.length = 0;
  for (const point of points) {
    const element = point.kind === 'depot' ? createRouteStartMarkerElement(point) : point.kind === 'snapped-stop' ? createRouteSnappedStopPointElement(point) : createRouteStopMarkerElement(point);
    markers.push(new maplibregl.Marker({ element, anchor: point.kind === 'depot' ? 'bottom' : 'center' }).setLngLat([point.longitude, point.latitude]).addTo(map));
  }
}

function createRouteStartMarkerElement(point: RouteOpsPoint): HTMLElement {
  const markerElement = document.createElement('button');
  const markerPinElement = document.createElement('span');
  markerElement.type = 'button';
  markerElement.className = 'departure-map-marker';
  markerElement.style.zIndex = '3000';
  markerElement.setAttribute('aria-label', point.addressLabel === undefined ? `Route start: ${point.label}` : `Store address: ${point.addressLabel}`);
  markerPinElement.className = 'departure-map-marker__pin';
  markerPinElement.append(createDepartureMarkerIconElement());
  markerElement.append(markerPinElement);
  return markerElement;
}

function createDepartureMarkerIconElement(): SVGSVGElement {
  const iconElement = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const iconPathElement = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  iconElement.classList.add('departure-map-marker__icon');
  iconElement.setAttribute('viewBox', '0 0 20 20');
  iconElement.setAttribute('aria-hidden', 'true');
  iconPathElement.setAttribute('d', 'M10 3.2 3.5 8.4v8.1h4v-5h5v5h4V8.4L10 3.2Z');
  iconElement.append(iconPathElement);
  return iconElement;
}

function createRouteSnappedStopPointElement(point: RouteOpsPoint): HTMLElement {
  const markerElement = document.createElement('span');
  markerElement.className = 'route-detail-snapped-stop-point';
  markerElement.style.zIndex = '3100';
  markerElement.setAttribute('aria-hidden', 'true');
  if (point.addressLabel !== undefined) markerElement.title = point.addressLabel;
  return markerElement;
}

function createRouteStopMarkerElement(point: RouteOpsPoint): HTMLElement {
  const markerElement = document.createElement('button');
  const labelElement = document.createElement('span');
  markerElement.type = 'button';
  markerElement.className = 'route-detail-stop-marker';
  markerElement.style.zIndex = '3200';
  markerElement.setAttribute('aria-label', `Stop ${point.label}`);
  labelElement.className = 'route-detail-stop-marker__label';
  labelElement.textContent = point.label;
  markerElement.append(labelElement);
  return markerElement;
}

function applyOrdersHomeViewport(map: MapLibreMap, homePoint: RouteOpsPoint | null, appliedRef: { current: string | null }): void {
  if (homePoint === null) return;
  const key = mapHomePointKey(homePoint);
  const previousKey = appliedRef.current;
  const shouldApply = previousKey === null || (homePoint.kind === 'depot' && previousKey !== key);
  if (!shouldApply) return;
  centerMapOnPoint(map, homePoint);
  appliedRef.current = key;
}

function centerMapOnPoint(map: MapLibreMap, point: RouteOpsPoint): void {
  map.easeTo({ center: [point.longitude, point.latitude], duration: 0, zoom: point.kind === 'depot' ? 10 : 12 });
}

function mapHomePointKey(point: RouteOpsPoint): string {
  return `${point.kind}:${point.id}:${point.latitude}:${point.longitude}`;
}

function fitMap(map: MapLibreMap, maplibregl: MapLibreModule | null, points: RouteOpsPoint[]): void {
  const bounds = fitBoundsForPoints(points);
  if (bounds === null || maplibregl === null) return;
  if (points.length === 1) {
    map.easeTo({ center: [points[0]?.longitude ?? 0, points[0]?.latitude ?? 0], duration: 0, zoom: 12 });
    return;
  }
  map.fitBounds(new maplibregl.LngLatBounds([bounds.west, bounds.south], [bounds.east, bounds.north]), { duration: 0, maxZoom: 14, padding: 56 });
}


function FitMapIcon(): ReactElement {
  return (
    <svg aria-hidden="true" className="map-toolbar-icon" fill="none" focusable="false" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 20 20">
      <path d="M4.5 8V4.5H8" />
      <path d="M12 4.5h3.5V8" />
      <path d="M15.5 12v3.5H12" />
      <path d="M8 15.5H4.5V12" />
    </svg>
  );
}

function SequencePreview({ points, readiness, showRouteLine }: { points: RouteOpsPoint[]; readiness: string; showRouteLine: boolean }): ReactElement {
  const bounds = fitBoundsForPoints(points);
  const projected = bounds === null ? [] : points.map((point) => ({ ...point, ...projectPoint(point, bounds) }));
  return (
    <svg viewBox="0 0 1000 560" role="img" aria-label={readiness === 'provider_not_configured' ? 'Safe same-host route sequence preview' : 'Route coordinate preview'}>
      <defs><linearGradient id="map-bg" x1="0" x2="1" y1="0" y2="1"><stop offset="0%" stopColor="#eef4fb" /><stop offset="100%" stopColor="#f8f4ec" /></linearGradient></defs>
      <rect width="1000" height="560" fill="url(#map-bg)" rx="24" />
      <path d="M-20 120 C200 90 260 210 440 176 C650 135 700 56 1040 85" className="map-road" />
      <path d="M40 470 C190 300 320 390 475 260 C610 145 730 300 955 210" className="map-road secondary" />
      {showRouteLine && projected.length > 1 ? <polyline className="route-line" points={projected.map((point) => `${point.x},${point.y}`).join(' ')} /> : null}
      {projected.map((point) => <g key={point.id} transform={`translate(${point.x} ${point.y})`}><circle r="18" className={point.kind === 'depot' ? 'pin depot' : 'pin'} /><text y="5" textAnchor="middle">{point.label}</text></g>)}
    </svg>
  );
}

function projectPoint(point: RouteOpsPoint, bounds: { east: number; north: number; south: number; west: number }): { x: number; y: number } {
  const width = Math.max(bounds.east - bounds.west, 0.0001);
  const height = Math.max(bounds.north - bounds.south, 0.0001);
  return {
    x: 80 + ((point.longitude - bounds.west) / width) * 840,
    y: 480 - ((point.latitude - bounds.south) / height) * 400
  };
}
