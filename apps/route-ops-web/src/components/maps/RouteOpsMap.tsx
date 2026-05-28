import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';

import { buildOrdersMapFeatureCollection, buildRouteGeometryFeature, buildSequenceLineFeature, fitBoundsForPoints, getOrderMapPoints, getRouteMapPoints, type RouteOpsPoint } from '../../maps/geojson';
import { installMissingMapImageFallback } from '../../maps/maplibre-missing-images';
import { installPmtilesProtocol } from '../../maps/pmtiles';
import { mapReadiness, providerStatusLabel } from '../../maps/provider';
import type { BootstrapPayload, CanonicalOrderDto, RoutePlanDetailDto } from '../../types';

type MapLibreModule = typeof import('maplibre-gl');
type MapLibreMap = InstanceType<MapLibreModule['Map']>;
type MapLibreMarker = InstanceType<MapLibreModule['Marker']>;
type MapLayerClickEvent = { features?: Array<{ properties?: { orderId?: string } }> };

type RouteOpsMapProps = {
  bootstrap: BootstrapPayload;
  detail?: RoutePlanDetailDto | null;
  onMapClickCoordinate?(coordinate: { latitude: number; longitude: number }): void;
  onOrderSelect?(orderId: string): void;
  orders?: CanonicalOrderDto[];
  plannedOrderIds?: ReadonlySet<string>;
  subtitle: string;
  title: string;
};

export function RouteOpsMap({ bootstrap, detail = null, onMapClickCoordinate, onOrderSelect, orders = [], plannedOrderIds = new Set<string>(), subtitle, title }: RouteOpsMapProps): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const maplibreRef = useRef<MapLibreModule | null>(null);
  const markersRef = useRef<MapLibreMarker[]>([]);
  const onMapClickCoordinateRef = useRef(onMapClickCoordinate);
  const onOrderSelectRef = useRef(onOrderSelect);
  const [isMapReady, setIsMapReady] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const [fitRequest, setFitRequest] = useState(0);

  const points = useMemo(() => (detail === null ? getOrderMapPoints(orders) : getRouteMapPoints(detail)), [detail, orders]);
  const readiness = mapReadiness({ coordinatesCount: points.length, mapStatus: bootstrap.mapConfig.status });
  const routeGeometry = useMemo(() => buildRouteGeometryFeature(detail), [detail]);
  const sequenceGeometry = useMemo(() => buildSequenceLineFeature(points), [points]);
  const ordersGeojson = useMemo(() => buildOrdersMapFeatureCollection(orders, plannedOrderIds), [orders, plannedOrderIds]);

  useEffect(() => {
    onMapClickCoordinateRef.current = onMapClickCoordinate;
  }, [onMapClickCoordinate]);

  useEffect(() => {
    onOrderSelectRef.current = onOrderSelect;
  }, [onOrderSelect]);

  useEffect(() => {
    if (readiness !== 'interactive_map' || bootstrap.mapConfig.styleUrl === null || containerRef.current === null || mapRef.current !== null) return undefined;
    let mounted = true;

    async function initializeMap(): Promise<void> {
      try {
        const [{ default: maplibregl }, { Protocol }] = await Promise.all([import('maplibre-gl'), import('pmtiles')]);
        if (!mounted || containerRef.current === null || mapRef.current !== null || bootstrap.mapConfig.styleUrl === null) return;
        installPmtilesProtocol(maplibregl, Protocol);
        maplibreRef.current = maplibregl;
        const firstPoint = points[0];
        const map = new maplibregl.Map({
          attributionControl: { compact: true },
          center: firstPoint === undefined ? [-79.3832, 43.6532] : [firstPoint.longitude, firstPoint.latitude],
          container: containerRef.current,
          fadeDuration: 0,
          style: bootstrap.mapConfig.styleUrl,
          zoom: points.length > 1 ? 10 : 12
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
      markersRef.current.forEach((marker) => marker.remove());
      markersRef.current = [];
      mapRef.current?.remove();
      mapRef.current = null;
      maplibreRef.current = null;
      setIsMapReady(false);
    };
  }, [bootstrap.mapConfig.styleUrl, readiness]);

  useEffect(() => {
    if (!isMapReady || mapRef.current === null) return;
    const map = mapRef.current;
    if (detail === null) syncOrdersLayer(map, ordersGeojson);
    syncRouteLayers(map, routeGeometry ?? sequenceGeometry);
    syncRouteMarkers(map, maplibreRef.current, detail === null ? [] : points, markersRef.current);
    fitMap(map, maplibreRef.current, points);
  }, [detail, fitRequest, isMapReady, ordersGeojson, points, routeGeometry, sequenceGeometry]);

  useEffect(() => {
    if (!isMapReady || detail !== null || mapRef.current === null || onOrderSelect === undefined) return undefined;
    const map = mapRef.current;
    if (!map.getLayer('route-ops-order-pins')) return undefined;
    const handleOrderPinClick = (event: MapLayerClickEvent): void => {
      const orderId = event.features?.[0]?.properties?.orderId;
      if (typeof orderId === 'string') onOrderSelectRef.current?.(orderId);
    };
    map.on('click', 'route-ops-order-pins', handleOrderPinClick);
    return () => {
      if (map.getLayer('route-ops-order-pins')) {
        map.off('click', 'route-ops-order-pins', handleOrderPinClick);
      }
    };
  }, [detail, isMapReady, onOrderSelect]);

  return (
    <article className="map-panel panel" data-route-map>
      <div className="panel-heading">
        <div><span className="eyebrow">Map-first workspace</span><h2>{title}</h2><p>{subtitle}</p></div>
        <span className="badge">{providerStatusLabel(bootstrap.mapConfig)}</span>
      </div>
      <div className="route-ops-map-frame" data-map-provider-mode={bootstrap.mapConfig.providerMode ?? 'none'} data-map-provider-status={bootstrap.mapConfig.status}>
        {readiness === 'interactive_map' ? <div className="map-toolbar"><button onClick={() => setFitRequest((value) => value + 1)} type="button">Fit map</button></div> : null}
        {readiness === 'interactive_map' ? <><div className="route-ops-map-canvas" ref={containerRef} aria-label="Interactive CLEVER route map" /><RouteOverlay points={points} /></> : <SequencePreview points={points} readiness={readiness} />}
        {mapError === null ? null : <div className="map-notice warning">{mapError}</div>}
        {readiness === 'provider_not_configured' ? <div className="map-notice">Map provider is not configured. Showing safe same-host sequence preview only.</div> : null}
        {readiness === 'no_coordinates' ? <div className="map-notice">No coordinates yet. Review delivery metadata before routing.</div> : null}
      </div>
    </article>
  );
}

export function syncOrdersLayer(map: MapLibreMap, featureCollection: ReturnType<typeof buildOrdersMapFeatureCollection>): void {
  const existing = map.getSource('route-ops-orders') as { setData?(data: unknown): void } | undefined;
  if (existing?.setData) existing.setData(featureCollection);
  else map.addSource('route-ops-orders', { data: featureCollection, type: 'geojson' });

  if (!map.getLayer('route-ops-order-pins')) {
    map.addLayer({
      id: 'route-ops-order-pins',
      paint: {
        'circle-color': ['match', ['get', 'pinKind'], 'planned', '#2563eb', 'review', '#f97316', '#111827'],
        'circle-radius': 12,
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 3
      },
      source: 'route-ops-orders',
      type: 'circle'
    });
  }
  if (!map.getLayer('route-ops-order-labels')) {
    map.addLayer({
      id: 'route-ops-order-labels',
      layout: {
        'text-allow-overlap': true,
        'text-field': ['get', 'label'],
        'text-font': ['Noto Sans Bold'],
        'text-size': 11
      },
      paint: { 'text-color': '#ffffff' },
      source: 'route-ops-orders',
      type: 'symbol'
    });
  }
}

function syncRouteLayers(map: MapLibreMap, lineFeature: ReturnType<typeof buildRouteGeometryFeature> | ReturnType<typeof buildSequenceLineFeature>): void {
  if (lineFeature === null) return;
  const existing = map.getSource('route-ops-route-line') as { setData?(data: unknown): void } | undefined;
  if (existing?.setData) existing.setData(lineFeature);
  else map.addSource('route-ops-route-line', { data: lineFeature, type: 'geojson' });
  if (!map.getLayer('route-ops-route-line')) {
    map.addLayer({
      id: 'route-ops-route-line',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': lineFeature.properties.kind === 'road_geometry' ? '#2563eb' : '#64748b',
        'line-dasharray': lineFeature.properties.kind === 'road_geometry' ? [1, 0] : [2, 2],
        'line-width': 5
      },
      source: 'route-ops-route-line',
      type: 'line'
    });
  }
}

function syncRouteMarkers(map: MapLibreMap, maplibregl: MapLibreModule | null, points: RouteOpsPoint[], markers: MapLibreMarker[]): void {
  if (maplibregl === null) return;
  markers.forEach((marker) => marker.remove());
  markers.length = 0;
  for (const point of points) {
    const element = document.createElement('div');
    element.className = point.kind === 'depot' ? 'route-map-marker depot' : 'route-map-marker';
    element.textContent = point.label;
    markers.push(new maplibregl.Marker({ element, anchor: 'bottom' }).setLngLat([point.longitude, point.latitude]).addTo(map));
  }
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

function SequencePreview({ points, readiness }: { points: RouteOpsPoint[]; readiness: string }): ReactElement {
  const bounds = fitBoundsForPoints(points);
  const projected = bounds === null ? [] : points.map((point) => ({ ...point, ...projectPoint(point, bounds) }));
  return (
    <svg viewBox="0 0 1000 560" role="img" aria-label={readiness === 'provider_not_configured' ? 'Safe same-host route sequence preview' : 'Route coordinate preview'}>
      <defs><linearGradient id="map-bg" x1="0" x2="1" y1="0" y2="1"><stop offset="0%" stopColor="#eef4fb" /><stop offset="100%" stopColor="#f8f4ec" /></linearGradient></defs>
      <rect width="1000" height="560" fill="url(#map-bg)" rx="24" />
      <path d="M-20 120 C200 90 260 210 440 176 C650 135 700 56 1040 85" className="map-road" />
      <path d="M40 470 C190 300 320 390 475 260 C610 145 730 300 955 210" className="map-road secondary" />
      {projected.length > 1 ? <polyline className="route-line" points={projected.map((point) => `${point.x},${point.y}`).join(' ')} /> : null}
      {projected.map((point) => <g key={point.id} transform={`translate(${point.x} ${point.y})`}><circle r="18" className={point.kind === 'depot' ? 'pin depot' : 'pin'} /><text y="5" textAnchor="middle">{point.label}</text></g>)}
    </svg>
  );
}

function RouteOverlay({ points }: { points: RouteOpsPoint[] }): ReactElement | null {
  const bounds = fitBoundsForPoints(points);
  if (bounds === null) return null;
  const projected = points.map((point) => ({ ...point, ...projectPoint(point, bounds) }));
  return (
    <svg className="route-map-overlay" viewBox="0 0 1000 560" aria-hidden="true">
      {projected.length > 1 ? <polyline className="route-line" points={projected.map((point) => `${point.x},${point.y}`).join(' ')} /> : null}
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
