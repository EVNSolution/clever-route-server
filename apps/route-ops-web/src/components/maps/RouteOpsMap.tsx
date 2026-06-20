import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent, ReactElement, ReactNode } from 'react';

import { buildOrdersMapFeatureCollection, buildRouteDropoffPointFeatureCollection, getRouteFitPoints, buildRouteGeometryFeature, buildRouteStopMarkerFeatureCollection, fitBoundsForPoints, getOrderMapPoints, getRouteDropoffPoints, getRouteMapPoints, type OrderMapMarkerState, type RouteDropoffPointFeatureCollection, type RouteLineFeature, type RouteOpsPoint, type RouteStopMarkerFeatureCollection } from '../../maps/geojson';
import { installMissingMapImageFallback } from '../../maps/maplibre-missing-images';
import { installPmtilesProtocol } from '../../maps/pmtiles';
import { mapReadiness } from '../../maps/provider';
import { getMapCopy, resolveLocale } from '../../i18n';
import { ROUTE_START_ICON_PATH } from './mapIcons';
import { formatOrderItemLine, getOrderItemDisplayKey, getOrderItems } from '../../orderItems';
import type { BootstrapPayload, CanonicalOrderDto, OrderItemDto, RouteGroupingPolygonDto, RoutePlanDetailDto, RouteStopDto } from '../../types';

type MapLibreModule = typeof import('maplibre-gl');
type MapLibreMap = InstanceType<MapLibreModule['Map']>;
type MapLibreMarker = InstanceType<MapLibreModule['Marker']>;
type MapLayerClickEvent = { features?: Array<{ properties?: { id?: string; orderId?: string } }>; originalEvent?: { preventDefault?(): void; stopPropagation?(): void }; preventDefault?(): void; stopPropagation?(): void };
type RouteStopPickerAnchor = { placement: 'bottom' | 'top'; x: number; y: number };
type RouteStopSequencePickerProps = {
  anchor: RouteStopPickerAnchor;
  currentSequence: number;
  locale?: string | null;
  onClose(): void;
  onPickSequence(sequence: number): void;
  orderName: string;
  sequenceCount: number;
  items?: OrderItemDto[];
};

const ORDER_PIN_IMAGE_ID = 'orders-map-pin';
const ORDER_PIN_PLANNED_IMAGE_ID = 'orders-map-pin-planned';
const ORDER_PIN_REVIEW_IMAGE_ID = 'orders-map-pin-review';
const ORDER_PIN_HISTORY_IMAGE_ID = 'orders-map-pin-history';
const ORDER_PIN_PIXEL_RATIO = 2;
const ORDER_PIN_ICON_SIZE = 0.62;
const ORDER_PIN_PATH = 'M20 50C20 50 4 31.5 4 18C4 9.16 11.16 2 20 2s16 7.16 16 16c0 13.5-16 32-16 32Z';
const ORDER_PIN_LABEL_OFFSET: [number, number] = [0, -1.85];
const EMPTY_ORDERS_COLLECTION = buildOrdersMapFeatureCollection([], new Set<string>());
const EMPTY_ROUTE_DROPOFF_COLLECTION = buildRouteDropoffPointFeatureCollection([]);
const EMPTY_ROUTE_LINE_COLLECTION = { features: [], type: 'FeatureCollection' } as const;
const EMPTY_ROUTE_STOP_COLLECTION = buildRouteStopMarkerFeatureCollection([]);
const ROUTE_STOP_PICKER_MAX_HEIGHT_PX = 280;
const ROUTE_STOP_PICKER_MAX_WIDTH_PX = 360;
const ROUTE_STOP_PICKER_MIN_WIDTH_PX = 188;
const ROUTE_STOP_PICKER_MARGIN_PX = 16;

type RouteOpsMapProps = {
  bootstrap: BootstrapPayload;
  className?: string;
  detail?: RoutePlanDetailDto | null;
  depot?: RouteOpsPoint | null;
  draftStops?: RouteStopDto[];
  headerAction?: ReactNode;
  mapOverlayAction?: ReactNode;
  fitOrdersToBounds?: boolean;
  statusContent?: ReactNode;
  onExitRouteMode?(): void;
  onMapClickCoordinate?(coordinate: { latitude: number; longitude: number }): void;
  onPolygonFinish?(): void;
  onPolygonVertex?(coordinate: { latitude: number; longitude: number }): void;
  onOrderSelect?(orderId: string): void;
  onRouteStopPickerClose?(): void;
  onRouteStopSelect?(deliveryStopId: string): void;
  onRouteStopSequencePick?(deliveryStopId: string, sequence: number): void;
  orderMarkerStates?: ReadonlyMap<string, OrderMapMarkerState>;
  orders?: CanonicalOrderDto[];
  polygonDraft?: { closed: boolean; vertices: Array<{ latitude: number; longitude: number }> };
  polygonDraftColor?: string;
  polygonMode?: boolean;
  polygons?: RouteGroupingPolygonDto[];
  plannedOrderIds?: ReadonlySet<string>;
  selectedRouteStopId?: string | null;
  subtitle?: string;
  title?: string;
};

export function RouteOpsMap({ bootstrap, className, depot = null, detail = null, draftStops, headerAction, mapOverlayAction, fitOrdersToBounds = false, statusContent, onExitRouteMode, onMapClickCoordinate, onPolygonFinish, onPolygonVertex, onOrderSelect, onRouteStopPickerClose, onRouteStopSelect, onRouteStopSequencePick, orderMarkerStates, orders = [], plannedOrderIds = new Set<string>(), polygonDraft, polygonDraftColor = "#111827", polygonMode = false, polygons = [], selectedRouteStopId = null, subtitle, title }: RouteOpsMapProps): ReactElement {
  const locale = resolveLocale(bootstrap.locale);
  const t = getMapCopy(locale);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const maplibreRef = useRef<MapLibreModule | null>(null);
  const markersRef = useRef<MapLibreMarker[]>([]);
  const onMapClickCoordinateRef = useRef(onMapClickCoordinate);
  const onPolygonFinishRef = useRef(onPolygonFinish);
  const onPolygonVertexRef = useRef(onPolygonVertex);
  const polygonModeRef = useRef(polygonMode);
  const onOrderSelectRef = useRef(onOrderSelect);
  const onRouteStopPickerCloseRef = useRef(onRouteStopPickerClose);
  const onRouteStopSelectRef = useRef(onRouteStopSelect);
  const onRouteStopSequencePickRef = useRef(onRouteStopSequencePick);
  const detailRef = useRef(detail);
  const mapCopyRef = useRef(t);
  const homePointRef = useRef<RouteOpsPoint | null>(null);
  const pointsRef = useRef<RouteOpsPoint[]>([]);
  const ordersHomeAppliedRef = useRef<string | null>(null);
  const [isMapReady, setIsMapReady] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const [fitRequest, setFitRequest] = useState(0);
  const [mapRefreshRequest, setMapRefreshRequest] = useState(0);
  const [routeStopPickerAnchor, setRouteStopPickerAnchor] = useState<RouteStopPickerAnchor | null>(null);

  const points = useMemo(() => (detail === null ? prependDepotPoint(depot, getOrderMapPoints(orders)) : getRouteMapPoints(detail, draftStops)), [depot, detail, draftStops, orders]);
  const routeStops = useMemo(() => (detail === null ? [] : draftStops ?? detail.stops), [detail, draftStops]);
  const selectedRouteStopPoint = useMemo(() => selectedRouteStopId === null ? null : points.find((point) => point.kind === 'stop' && point.id === selectedRouteStopId) ?? null, [points, selectedRouteStopId]);
  const selectedRouteStop = useMemo(() => selectedRouteStopId === null ? null : routeStops.find((stop) => stop.deliveryStopId === selectedRouteStopId) ?? null, [routeStops, selectedRouteStopId]);
  const dropoffPoints = useMemo(() => getRouteDropoffPoints(detail), [detail]);
  const fitPoints = useMemo(() => getRouteFitPoints(detail, points, dropoffPoints), [detail, dropoffPoints, points]);
  const fitPointsKey = useMemo(() => fitPoints.map((point) => `${point.kind}:${point.id}:${point.latitude}:${point.longitude}`).join('|'), [fitPoints]);
  const homePoint = useMemo(() => resolveMapHomePoint(detail, depot, points), [depot, detail, points]);
  const readiness = mapReadiness({ coordinatesCount: points.length, mapStatus: bootstrap.mapConfig.status });
  const routeGeometry = useMemo(() => buildRouteGeometryFeature(detail), [detail]);
  const lineFeature = detail === null ? null : routeGeometry;
  const ordersGeojson = useMemo(() => buildOrdersMapFeatureCollection(orders, orderMarkerStates ?? plannedOrderIds), [orderMarkerStates, orders, plannedOrderIds]);
  const routeDropoffGeojson = useMemo(() => (detail === null ? EMPTY_ROUTE_DROPOFF_COLLECTION : buildRouteDropoffPointFeatureCollection(dropoffPoints)), [detail, dropoffPoints]);
  const routeStopGeojson = useMemo(() => (detail === null ? EMPTY_ROUTE_STOP_COLLECTION : buildRouteStopMarkerFeatureCollection(points, selectedRouteStopId)), [detail, points, selectedRouteStopId]);
  const polygonGeojson = useMemo(() => buildPolygonFeatureCollection(polygons, polygonDraft, polygonDraftColor), [polygonDraft, polygonDraftColor, polygons]);
  const polygonVertexGeojson = useMemo(() => buildPolygonVertexFeatureCollection(polygons, polygonDraft, polygonDraftColor), [polygonDraft, polygonDraftColor, polygons]);

  useEffect(() => {
    onMapClickCoordinateRef.current = onMapClickCoordinate;
  }, [onMapClickCoordinate]);

  useEffect(() => {
    onPolygonFinishRef.current = onPolygonFinish;
  }, [onPolygonFinish]);

  useEffect(() => {
    onPolygonVertexRef.current = onPolygonVertex;
  }, [onPolygonVertex]);

  useEffect(() => {
    polygonModeRef.current = polygonMode;
  }, [polygonMode]);

  useEffect(() => {
    mapCopyRef.current = t;
  }, [t]);

  useEffect(() => {
    onOrderSelectRef.current = onOrderSelect;
  }, [onOrderSelect]);

  useEffect(() => {
    detailRef.current = detail;
  }, [detail]);

  useEffect(() => {
    onRouteStopPickerCloseRef.current = onRouteStopPickerClose;
  }, [onRouteStopPickerClose]);

  useEffect(() => {
    onRouteStopSelectRef.current = onRouteStopSelect;
  }, [onRouteStopSelect]);

  useEffect(() => {
    onRouteStopSequencePickRef.current = onRouteStopSequencePick;
  }, [onRouteStopSequencePick]);

  useEffect(() => {
    homePointRef.current = homePoint;
  }, [homePoint]);

  useEffect(() => {
    pointsRef.current = points;
  }, [points]);

  const updateRouteStopPickerAnchor = useCallback((): void => {
    const map = mapRef.current;
    const container = containerRef.current;
    if (!isMapReady || selectedRouteStopPoint === null || map === null || container === null || !isMapUsable(map)) {
      setRouteStopPickerAnchor(null);
      return;
    }
    const projected = map.project([selectedRouteStopPoint.longitude, selectedRouteStopPoint.latitude]);
    setRouteStopPickerAnchor(anchorRouteStopPicker(projected, container, routeStops.length));
  }, [isMapReady, routeStops.length, selectedRouteStopPoint]);

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
          cancelPendingTileRequestsWhileZooming: false,
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
          stabilizeMapCanvas(map);
          setIsMapReady(true);
          setMapError(null);
        });
        map.once('idle', () => stabilizeMapCanvas(map));
        map.on('click', (event: { lngLat?: { lat: number; lng: number } }) => {
          if (detailRef.current !== null) return;
          if (event.lngLat === undefined) return;
          const coordinate = { latitude: event.lngLat.lat, longitude: event.lngLat.lng };
          if (polygonModeRef.current) {
            onPolygonVertexRef.current?.(coordinate);
            return;
          }
          onMapClickCoordinateRef.current?.(coordinate);
        });
        map.on('dblclick', () => {
          if (polygonModeRef.current) onPolygonFinishRef.current?.();
        });
        map.on('error', (event: { error?: { message?: string } }) => {
          if (!mounted) return;
          setMapError(event.error?.message ?? mapCopyRef.current.providerRequestFailed);
        });
      } catch (error) {
        if (!mounted) return;
        setMapError(error instanceof Error ? error.message : mapCopyRef.current.libraryFailed);
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
  }, [bootstrap.mapConfig.styleUrl, mapRefreshRequest, readiness]);

  useEffect(() => {
    if (!isMapReady || mapRef.current === null || !isMapUsable(mapRef.current)) return;
    const map = mapRef.current;
    syncOrdersLayer(map, detail === null ? ordersGeojson : EMPTY_ORDERS_COLLECTION);
    syncRouteLayers(map, lineFeature);
    syncRouteDropoffLayers(map, routeDropoffGeojson);
    syncRouteStopLayers(map, routeStopGeojson);
    syncPolygonLayers(map, polygonGeojson);
    syncPolygonVertexLayers(map, polygonVertexGeojson);
    syncRouteMarkers(map, maplibreRef.current, points.filter((point) => point.kind === 'depot' || point.kind === 'stop'), markersRef.current, locale, selectedRouteStopId, (deliveryStopId) => onRouteStopSelectRef.current?.(deliveryStopId));
    if (detail !== null || fitOrdersToBounds) {
      fitMap(map, maplibreRef.current, fitPoints);
      return;
    }
    applyOrdersHomeViewport(map, homePoint, ordersHomeAppliedRef);
  }, [detail, fitOrdersToBounds, fitPoints, homePoint, isMapReady, lineFeature, locale, ordersGeojson, points, polygonGeojson, polygonVertexGeojson, routeDropoffGeojson, routeStopGeojson, selectedRouteStopId]);

  useEffect(() => {
    if (detail === null || !isMapReady || mapRef.current === null || !isMapUsable(mapRef.current)) return undefined;
    let animationFrame: number | null = null;
    const timeouts: number[] = [];
    const applyFit = (): void => {
      const map = mapRef.current;
      if (map === null || !isMapUsable(map)) return;
      fitMap(map, maplibreRef.current, fitPoints);
    };
    applyFit();
    animationFrame = window.requestAnimationFrame(applyFit);
    timeouts.push(window.setTimeout(applyFit, 120));
    timeouts.push(window.setTimeout(applyFit, 600));
    return () => {
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
      timeouts.forEach((timeout) => window.clearTimeout(timeout));
    };
  }, [detail, fitPoints, fitPointsKey, isMapReady]);

  useEffect(() => {
    if (!fitOrdersToBounds || detail !== null || !isMapReady || mapRef.current === null || !isMapUsable(mapRef.current)) return undefined;
    let animationFrame: number | null = null;
    const timeouts: number[] = [];
    const applyFit = (): void => {
      const map = mapRef.current;
      if (map === null || !isMapUsable(map)) return;
      fitMap(map, maplibreRef.current, fitPoints);
    };
    applyFit();
    animationFrame = window.requestAnimationFrame(applyFit);
    timeouts.push(window.setTimeout(applyFit, 120));
    timeouts.push(window.setTimeout(applyFit, 600));
    return () => {
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
      timeouts.forEach((timeout) => window.clearTimeout(timeout));
    };
  }, [detail, fitOrdersToBounds, fitPoints, fitPointsKey, isMapReady]);

  useEffect(() => {
    if (fitRequest === 0 || !isMapReady || mapRef.current === null || !isMapUsable(mapRef.current)) return;
    const map = mapRef.current;
    if (detail === null) {
      const target = homePoint ?? points[0] ?? null;
      if (target !== null) centerMapOnPoint(map, target);
      return;
    }
    fitMap(map, maplibreRef.current, fitPoints);
  }, [detail, fitPoints, fitRequest, homePoint, isMapReady, points]);

  useEffect(() => {
    if (!isMapReady || detail !== null || mapRef.current === null || onOrderSelect === undefined) return undefined;
    const map = mapRef.current;
    if (!safeGetLayer(map, 'route-ops-order-pins')) return undefined;
    const handleOrderPinClick = (event: MapLayerClickEvent): void => {
      const orderId = event.features?.[0]?.properties?.orderId;
      if (typeof orderId === 'string') onOrderSelectRef.current?.(orderId);
    };
    map.on('click', 'route-ops-order-pins', handleOrderPinClick);
    if (safeGetLayer(map, 'route-ops-order-labels')) {
      map.on('click', 'route-ops-order-labels', handleOrderPinClick);
    }
    return () => {
      safeLayerOff(map, 'click', 'route-ops-order-pins', handleOrderPinClick);
      safeLayerOff(map, 'click', 'route-ops-order-labels', handleOrderPinClick);
    };
  }, [detail, isMapReady, onOrderSelect]);

  useEffect(() => {
    if (!isMapReady || detail === null || mapRef.current === null || onRouteStopSelect === undefined) return undefined;
    return installRouteStopClickHandlers(mapRef.current, (deliveryStopId) => onRouteStopSelectRef.current?.(deliveryStopId));
  }, [detail, isMapReady, onRouteStopSelect]);

  useEffect(() => {
    updateRouteStopPickerAnchor();
  }, [updateRouteStopPickerAnchor, routeStopGeojson]);

  useEffect(() => {
    if (!isMapReady || selectedRouteStopPoint === null || mapRef.current === null) return undefined;
    const map = mapRef.current;
    const updateAnchor = (): void => updateRouteStopPickerAnchor();
    updateAnchor();
    map.on('move', updateAnchor);
    map.on('zoom', updateAnchor);
    map.on('resize', updateAnchor);
    return () => {
      safeMapOff(map, 'move', updateAnchor);
      safeMapOff(map, 'zoom', updateAnchor);
      safeMapOff(map, 'resize', updateAnchor);
    };
  }, [isMapReady, selectedRouteStopPoint, updateRouteStopPickerAnchor]);

  useEffect(() => {
    if (selectedRouteStopId === null || detail !== null) return;
    onRouteStopPickerCloseRef.current?.();
  }, [detail, selectedRouteStopId]);

  useEffect(() => {
    if (selectedRouteStopId === null) return undefined;
    const handleDocumentPointerDown = (event: globalThis.PointerEvent): void => {
      if (event.target instanceof Element && event.target.closest('.route-stop-sequence-picker') !== null) return;
      onRouteStopPickerCloseRef.current?.();
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') onRouteStopPickerCloseRef.current?.();
    };
    document.addEventListener('pointerdown', handleDocumentPointerDown, true);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handleDocumentPointerDown, true);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [selectedRouteStopId]);

  const handleRefreshMap = (): void => {
    setMapError(null);
    setIsMapReady(false);
    onRouteStopPickerCloseRef.current?.();
    setMapRefreshRequest((value) => value + 1);
  };

  const handleMapFramePointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (selectedRouteStopId === null) return;
    if ((event.target as Element).closest('.route-stop-sequence-picker') !== null) return;
    onRouteStopPickerCloseRef.current?.();
  };
  const hasHeading = title !== undefined || subtitle !== undefined || headerAction !== undefined;

  return (
    <article className={className === undefined ? "map-panel panel" : `map-panel panel ${className}`} data-route-map>
      {hasHeading ? (
        <div className="panel-heading">
          {title === undefined && subtitle === undefined ? null : (
            <div>
              {title === undefined ? null : <h2>{title}</h2>}
              {subtitle === undefined ? null : <p>{subtitle}</p>}
            </div>
          )}
          {headerAction === undefined ? null : <div className="map-panel-heading-action">{headerAction}</div>}
        </div>
      ) : null}
      {statusContent === undefined ? null : <div className="map-panel-status">{statusContent}</div>}
      <div className="route-ops-map-frame" data-map-provider-mode={bootstrap.mapConfig.providerMode ?? 'none'} data-map-provider-status={bootstrap.mapConfig.status} data-polygon-mode={polygonMode ? 'true' : 'false'} onPointerDown={handleMapFramePointerDown}>
        {readiness === 'interactive_map' || onExitRouteMode !== undefined ? (
          <div className="map-toolbar">
            {onExitRouteMode !== undefined ? <button aria-label={t.exitRouteMode} onClick={onExitRouteMode} title={t.exitRouteMode} type="button"><span aria-hidden="true" className="map-toolbar-symbol">←</span></button> : null}
            {readiness === 'interactive_map' ? <button aria-label={detail === null ? t.centerOnStore : t.fitMap} onClick={() => setFitRequest((value) => value + 1)} title={detail === null ? t.centerOnStore : t.fitMap} type="button"><FitMapIcon /></button> : null}
            {readiness === 'interactive_map' ? <button aria-label={t.refreshMap} onClick={handleRefreshMap} title={t.refreshMap} type="button"><span aria-hidden="true" className="map-toolbar-symbol">↻</span></button> : null}
          </div>
        ) : null}
        {mapOverlayAction === undefined ? null : <div className="map-edit-overlay">{mapOverlayAction}</div>}
        {readiness === 'interactive_map' ? <div className="route-ops-map-canvas" ref={containerRef} aria-label={t.interactiveMap} /> : <SequencePreview locale={locale} points={points} readiness={readiness} />}
        {selectedRouteStop !== null && routeStopPickerAnchor !== null ? (
          <RouteStopSequencePicker
            anchor={routeStopPickerAnchor}
            currentSequence={selectedRouteStop.sequence}
            locale={locale}
            onClose={() => onRouteStopPickerCloseRef.current?.()}
            onPickSequence={(sequence) => onRouteStopSequencePickRef.current?.(selectedRouteStop.deliveryStopId, sequence)}
            orderName={selectedRouteStop.orderName}
            sequenceCount={routeStops.length}
            items={selectedRouteStop.items}
          />
        ) : null}
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

function buildPolygonFeatureCollection(polygons: RouteGroupingPolygonDto[], draft: { closed: boolean; vertices: Array<{ latitude: number; longitude: number }> } | undefined, draftColor: string): GeoJSON.FeatureCollection {
  const features = polygons.map((polygon) => ({
    geometry: polygon.geometry,
    properties: { color: polygon.color ?? '#2563eb', id: polygon.id, label: polygon.label },
    type: 'Feature'
  }));
  if (draft !== undefined && draft.vertices.length > 0) {
    const coordinates = draft.vertices.map((vertex) => [vertex.longitude, vertex.latitude]);
    const first = coordinates[0];
    if (draft.closed && first !== undefined) coordinates.push(first);
    features.push({
      geometry: { coordinates: draft.closed ? [coordinates] : coordinates, type: draft.closed ? 'Polygon' : 'LineString' },
      properties: { color: draftColor, id: 'draft', label: 'Draft' },
      type: 'Feature'
    });
  }
  return { features, type: 'FeatureCollection' } as GeoJSON.FeatureCollection;
}

function buildPolygonVertexFeatureCollection(polygons: RouteGroupingPolygonDto[], draft: { closed: boolean; vertices: Array<{ latitude: number; longitude: number }> } | undefined, draftColor: string): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const polygon of polygons) {
    const color = polygon.color ?? '#2563eb';
    const ring = readPolygonRing(polygon.geometry);
    ring.forEach((coordinate, index) => {
      if (index === ring.length - 1) {
        const first = ring[0];
        if (first !== undefined && first[0] === coordinate[0] && first[1] === coordinate[1]) return;
      }
      features.push({
        geometry: { coordinates: [coordinate[0], coordinate[1]], type: 'Point' },
        properties: { color, id: `${polygon.id}:${index}` },
        type: 'Feature'
      });
    });
  }
  if (draft !== undefined) {
    draft.vertices.forEach((vertex, index) => {
      features.push({
        geometry: { coordinates: [vertex.longitude, vertex.latitude], type: 'Point' },
        properties: { color: draftColor, id: `draft:${index}` },
        type: 'Feature'
      });
    });
  }
  return { features, type: 'FeatureCollection' } as GeoJSON.FeatureCollection;
}

function readPolygonRing(geometry: unknown): Array<[number, number]> {
  if (typeof geometry !== 'object' || geometry === null) return [];
  const coordinates = (geometry as { coordinates?: unknown }).coordinates;
  if (!Array.isArray(coordinates)) return [];
  const ring = coordinates[0];
  if (!Array.isArray(ring)) return [];
  return ring.flatMap((coordinate): Array<[number, number]> => {
    if (!Array.isArray(coordinate) || coordinate.length < 2) return [];
    const [longitude, latitude] = coordinate;
    if (typeof longitude !== 'number' || typeof latitude !== 'number') return [];
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return [];
    return [[longitude, latitude]];
  });
}

function syncPolygonLayers(map: MapLibreMap, featureCollection: GeoJSON.FeatureCollection): void {
  const existing = safeGetSource(map, 'route-ops-polygons') as { setData?(data: unknown): void } | undefined;
  if (existing?.setData) {
    safeSetSourceData(existing, featureCollection);
    return;
  }
  map.addSource('route-ops-polygons', { data: featureCollection, type: 'geojson' });
  map.addLayer({
    id: 'route-ops-polygons-fill',
    paint: { 'fill-color': ['coalesce', ['get', 'color'], '#2563eb'], 'fill-opacity': 0.16 },
    source: 'route-ops-polygons',
    type: 'fill'
  });
  map.addLayer({
    id: 'route-ops-polygons-line',
    paint: { 'line-color': ['coalesce', ['get', 'color'], '#2563eb'], 'line-width': 2 },
    source: 'route-ops-polygons',
    type: 'line'
  });
}

function syncPolygonVertexLayers(map: MapLibreMap, featureCollection: GeoJSON.FeatureCollection): void {
  const existing = safeGetSource(map, 'route-ops-polygon-vertices') as { setData?(data: unknown): void } | undefined;
  if (existing?.setData) {
    safeSetSourceData(existing, featureCollection);
    return;
  }
  if (!safeAddSource(map, 'route-ops-polygon-vertices', { data: featureCollection, type: 'geojson' })) return;
  safeAddLayer(map, {
    id: 'route-ops-polygon-vertices',
    paint: {
      'circle-color': '#ffffff',
      'circle-radius': 4,
      'circle-stroke-color': ['coalesce', ['get', 'color'], '#2563eb'],
      'circle-stroke-width': 2
    },
    source: 'route-ops-polygon-vertices',
    type: 'circle'
  });
}

export function syncOrdersLayer(map: MapLibreMap, featureCollection: ReturnType<typeof buildOrdersMapFeatureCollection>): void {
  const existing = safeGetSource(map, 'route-ops-orders') as { setData?(data: unknown): void } | undefined;
  if (existing?.setData) safeSetSourceData(existing, featureCollection);
  else if (!safeAddSource(map, 'route-ops-orders', { data: featureCollection, type: 'geojson' })) return;

  if (!ensureOrdersMapPinImages(map, featureCollection)) {
    syncFallbackCircleOrdersLayer(map);
    syncOrderLabelsLayer(map, { alignToPinCenter: false });
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
      paint: {
        'icon-opacity': ['get', 'markerOpacity']
      },
      source: 'route-ops-orders',
      type: 'symbol'
    });
  }
  syncOrderLabelsLayer(map, { alignToPinCenter: true });
}

function syncFallbackCircleOrdersLayer(map: MapLibreMap): void {
  if (safeGetLayer(map, 'route-ops-order-pins')) return;
  safeAddLayer(map, {
    id: 'route-ops-order-pins',
    paint: {
      'circle-color': ['coalesce', ['get', 'markerColor'], '#303030'],
      'circle-opacity': ['get', 'markerOpacity'],
      'circle-radius': 12,
      'circle-stroke-color': '#ffffff',
      'circle-stroke-opacity': ['get', 'markerOpacity'],
      'circle-stroke-width': 3
    },
    source: 'route-ops-orders',
    type: 'circle'
  });
}

function syncOrderLabelsLayer(map: MapLibreMap, options: { alignToPinCenter: boolean }): void {
  if (safeGetLayer(map, 'route-ops-order-labels')) return;
  safeAddLayer(map, {
    id: 'route-ops-order-labels',
    layout: {
      'symbol-sort-key': ['get', 'sortKey'],
      'text-allow-overlap': true,
      'text-anchor': 'center',
      'text-field': ['get', 'label'],
      'text-font': ['Noto Sans Bold'],
      'text-ignore-placement': true,
      'text-justify': 'center',
      'text-offset': options.alignToPinCenter ? ORDER_PIN_LABEL_OFFSET : [0, 0],
      'text-size': 11
    },
    paint: {
      'text-color': '#ffffff',
      'text-halo-color': 'rgba(0, 0, 0, 0.28)',
      'text-halo-width': 0.7,
      'text-opacity': ['get', 'markerOpacity']
    },
    source: 'route-ops-orders',
    type: 'symbol'
  });
}

function ensureOrdersMapPinImages(map: MapLibreMap, featureCollection: ReturnType<typeof buildOrdersMapFeatureCollection>): boolean {
  const imageApi = map as unknown as {
    addImage?(id: string, image: ImageData, options?: { pixelRatio?: number }): void;
    hasImage?(id: string): boolean;
  };
  if (typeof imageApi.addImage !== 'function' || typeof imageApi.hasImage !== 'function') return false;
  const images = [
    { color: '#303030', id: ORDER_PIN_IMAGE_ID, shadowColor: 'rgba(48, 48, 48, 0.36)' },
    { color: '#006fbb', id: ORDER_PIN_PLANNED_IMAGE_ID, shadowColor: 'rgba(0, 111, 187, 0.36)' },
    { color: '#8a8f98', id: ORDER_PIN_HISTORY_IMAGE_ID, shadowColor: 'rgba(138, 143, 152, 0.36)' },
    { color: '#e11900', id: ORDER_PIN_REVIEW_IMAGE_ID, shadowColor: 'rgba(225, 25, 0, 0.4)' },
    ...customOrderPinImages(featureCollection)
  ];
  for (const image of images) {
    if (safeHasImage(imageApi, image.id)) continue;
    const imageData = createOrderPinImageData(image.color, { shadowColor: image.shadowColor });
    if (imageData === null) return false;
    if (!safeAddImage(imageApi, image.id, imageData)) return false;
  }
  return true;
}

function customOrderPinImages(featureCollection: ReturnType<typeof buildOrdersMapFeatureCollection>): Array<{ color: string; id: string; shadowColor: string }> {
  const standardIds = new Set([ORDER_PIN_IMAGE_ID, ORDER_PIN_PLANNED_IMAGE_ID, ORDER_PIN_REVIEW_IMAGE_ID, ORDER_PIN_HISTORY_IMAGE_ID]);
  const imagesById = new Map<string, { color: string; id: string; shadowColor: string }>();
  for (const feature of featureCollection.features) {
    const { markerColor, pinImage } = feature.properties;
    if (standardIds.has(pinImage)) continue;
    if (!/^#[0-9a-f]{6}$/iu.test(markerColor)) continue;
    imagesById.set(pinImage, { color: markerColor, id: pinImage, shadowColor: `${markerColor}5c` });
  }
  return [...imagesById.values()];
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

  const paint = routeLinePaint();
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

export function syncRouteDropoffLayers(map: MapLibreMap, featureCollection: RouteDropoffPointFeatureCollection): void {
  const existing = safeGetSource(map, 'route-ops-route-dropoffs') as { setData?(data: unknown): void } | undefined;
  if (existing?.setData) safeSetSourceData(existing, featureCollection);
  else if (!safeAddSource(map, 'route-ops-route-dropoffs', { data: featureCollection, type: 'geojson' })) return;

  if (!safeGetLayer(map, 'route-ops-route-dropoff-points')) {
    safeAddLayer(map, {
      id: 'route-ops-route-dropoff-points',
      paint: {
        'circle-color': '#1473e6',
        'circle-radius': 5,
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 1.6
      },
      source: 'route-ops-route-dropoffs',
      type: 'circle'
    });
  }
  enforceRouteLayerOrder(map);
}

export function syncRouteStopLayers(map: MapLibreMap, featureCollection: RouteStopMarkerFeatureCollection): void {
  const existing = safeGetSource(map, 'route-ops-route-stops') as { setData?(data: unknown): void } | undefined;
  if (existing?.setData) safeSetSourceData(existing, featureCollection);
  else if (!safeAddSource(map, 'route-ops-route-stops', { data: featureCollection, type: 'geojson' })) return;

  if (!safeGetLayer(map, 'route-ops-route-stop-circles')) {
    safeAddLayer(map, {
      id: 'route-ops-route-stop-circles',
      layout: {
        'circle-sort-key': ['get', 'sortKey']
      },
      paint: {
        'circle-color': ['get', 'color'],
        'circle-radius': ['case', ['get', 'selected'], 12, 10],
        'circle-stroke-color': ['case', ['get', 'selected'], '#2f6fed', '#ffffff'],
        'circle-stroke-width': ['case', ['get', 'selected'], 4, 2]
      },
      source: 'route-ops-route-stops',
      type: 'circle'
    });
  } else {
    safeSetPaintProperty(map, 'route-ops-route-stop-circles', 'circle-color', ['get', 'color']);
    safeSetPaintProperty(map, 'route-ops-route-stop-circles', 'circle-radius', ['case', ['get', 'selected'], 12, 10]);
    safeSetPaintProperty(map, 'route-ops-route-stop-circles', 'circle-stroke-color', ['case', ['get', 'selected'], '#2f6fed', '#ffffff']);
    safeSetPaintProperty(map, 'route-ops-route-stop-circles', 'circle-stroke-width', ['case', ['get', 'selected'], 4, 2]);
  }

  if (!safeGetLayer(map, 'route-ops-route-stop-labels')) {
    safeAddLayer(map, {
      id: 'route-ops-route-stop-labels',
      layout: {
        'symbol-sort-key': ['get', 'sortKey'],
        'text-allow-overlap': true,
        'text-field': ['get', 'label'],
        'text-font': ['Noto Sans Bold'],
        'text-ignore-placement': true,
        'text-size': 10
      },
      paint: {
        'text-color': '#ffffff'
      },
      source: 'route-ops-route-stops',
      type: 'symbol'
    });
  }
  enforceRouteLayerOrder(map);
}

export function installRouteStopClickHandlers(map: MapLibreMap, onRouteStopSelect: (deliveryStopId: string) => void): (() => void) | undefined {
  if (!safeGetLayer(map, 'route-ops-route-stop-circles')) return undefined;
  const handleRouteStopClick = (event: MapLayerClickEvent): void => {
    event.preventDefault?.();
    event.stopPropagation?.();
    event.originalEvent?.preventDefault?.();
    event.originalEvent?.stopPropagation?.();
    const deliveryStopId = event.features?.[0]?.properties?.id;
    if (typeof deliveryStopId === 'string' && deliveryStopId.trim() !== '') onRouteStopSelect(deliveryStopId);
  };
  map.on('click', 'route-ops-route-stop-circles', handleRouteStopClick);
  if (safeGetLayer(map, 'route-ops-route-stop-labels')) {
    map.on('click', 'route-ops-route-stop-labels', handleRouteStopClick);
  }
  return () => {
    safeLayerOff(map, 'click', 'route-ops-route-stop-circles', handleRouteStopClick);
    safeLayerOff(map, 'click', 'route-ops-route-stop-labels', handleRouteStopClick);
  };
}

function enforceRouteLayerOrder(map: MapLibreMap): void {
  safeMoveLayer(map, 'route-ops-route-line', 'route-ops-route-dropoff-points');
  safeMoveLayer(map, 'route-ops-route-dropoff-points', 'route-ops-route-stop-circles');
  safeMoveLayer(map, 'route-ops-route-stop-circles', 'route-ops-route-stop-labels');
  safeMoveLayer(map, 'route-ops-route-stop-labels');
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

function safeMoveLayer(map: MapLibreMap, layerId: string, beforeId?: string): void {
  try {
    if (!safeGetLayer(map, layerId)) return;
    if (beforeId !== undefined && !safeGetLayer(map, beforeId)) return;
    map.moveLayer(layerId, beforeId);
  } catch {
    // Layer ordering is best-effort while MapLibre styles are being torn down or rebuilt.
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

function safeResizeMap(map: MapLibreMap): void {
  try {
    map.resize();
  } catch {
    // Resizing is best-effort before fitBounds; stale map instances can be tearing down.
  }
}

function stabilizeMapCanvas(map: MapLibreMap): void {
  safeResizeMap(map);
  if (typeof window === 'undefined') return;
  window.requestAnimationFrame(() => safeResizeMap(map));
  window.setTimeout(() => safeResizeMap(map), 120);
  window.setTimeout(() => safeResizeMap(map), 600);
}

function safeMapOff(map: MapLibreMap, type: 'move' | 'resize' | 'zoom', listener: () => void): void {
  try {
    map.off(type, listener);
  } catch {
    // MapLibre can clear style before React runs map-listener cleanup.
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

export function anchorRouteStopPicker(projected: { x: number; y: number }, container: { clientHeight: number; clientWidth: number }, sequenceCount: number): RouteStopPickerAnchor {
  const width = estimateRouteStopPickerWidth(container.clientWidth, sequenceCount);
  const height = estimateRouteStopPickerHeight(sequenceCount, width);
  const halfWidth = width / 2;
  const minX = ROUTE_STOP_PICKER_MARGIN_PX + halfWidth;
  const maxX = Math.max(minX, container.clientWidth - ROUTE_STOP_PICKER_MARGIN_PX - halfWidth);
  const x = clampNumber(projected.x, minX, maxX);
  const gap = ROUTE_STOP_PICKER_MARGIN_PX;
  const hasTopRoom = projected.y - height - gap >= ROUTE_STOP_PICKER_MARGIN_PX;
  const hasBottomRoom = projected.y + height + gap <= container.clientHeight - ROUTE_STOP_PICKER_MARGIN_PX;
  const placement: RouteStopPickerAnchor['placement'] = hasTopRoom || !hasBottomRoom ? 'top' : 'bottom';
  const minY = placement === 'top'
    ? ROUTE_STOP_PICKER_MARGIN_PX + height + gap
    : ROUTE_STOP_PICKER_MARGIN_PX;
  const maxY = placement === 'top'
    ? container.clientHeight - ROUTE_STOP_PICKER_MARGIN_PX
    : Math.max(minY, container.clientHeight - ROUTE_STOP_PICKER_MARGIN_PX - height - gap);
  return { placement, x, y: clampNumber(projected.y, minY, maxY) };
}

function estimateRouteStopPickerWidth(containerWidth: number, sequenceCount: number): number {
  const availableWidth = Math.max(ROUTE_STOP_PICKER_MIN_WIDTH_PX, containerWidth - ROUTE_STOP_PICKER_MARGIN_PX * 2);
  const contentWidth = Math.max(ROUTE_STOP_PICKER_MIN_WIDTH_PX, sequenceCount * 42);
  return Math.min(ROUTE_STOP_PICKER_MAX_WIDTH_PX, availableWidth, contentWidth);
}

function estimateRouteStopPickerHeight(sequenceCount: number, pickerWidth: number): number {
  const choicesWidth = Math.max(34, pickerWidth - 50);
  const columns = Math.max(1, Math.floor((choicesWidth + 8) / 42));
  const rows = Math.max(1, Math.ceil(sequenceCount / columns));
  const choicesHeight = rows * 34 + Math.max(0, rows - 1) * 8;
  return Math.min(ROUTE_STOP_PICKER_MAX_HEIGHT_PX, choicesHeight + 28);
}

function clampNumber(value: number, min: number, max: number): number {
  const lower = Math.min(min, max);
  const upper = Math.max(min, max);
  return Math.min(Math.max(value, lower), upper);
}

function routeLinePaint(): { 'line-color': string; 'line-dasharray': [number, number]; 'line-opacity': number; 'line-width': number } {
  return {
    'line-color': '#e11900',
    'line-dasharray': [1, 0],
    'line-opacity': 0.78,
    'line-width': 3
  };
}

function styleRequiresPmtiles(endpoints: readonly string[]): boolean {
  return endpoints.some((endpoint) => endpoint.startsWith('pmtiles://'));
}

function syncRouteMarkers(map: MapLibreMap, maplibregl: MapLibreModule | null, points: RouteOpsPoint[], markers: MapLibreMarker[], locale: string | null | undefined = 'en-CA', selectedRouteStopId: string | null = null, onRouteStopSelect?: (deliveryStopId: string) => void): void {
  if (maplibregl === null) return;
  markers.forEach((marker) => safeRemoveMarker(marker));
  markers.length = 0;
  for (const point of points) {
    if (point.kind === 'depot') {
      const element = createRouteStartMarkerElement(point, locale);
      markers.push(new maplibregl.Marker({ element, anchor: 'bottom' }).setLngLat([point.longitude, point.latitude]).addTo(map));
      continue;
    }
    if (point.kind === 'stop') {
      const element = createRouteStopMarkerElement(point, point.id === selectedRouteStopId, onRouteStopSelect);
      markers.push(new maplibregl.Marker({ element, anchor: 'center' }).setLngLat([point.longitude, point.latitude]).addTo(map));
    }
  }
}

function createRouteStartMarkerElement(point: RouteOpsPoint, locale: string | null | undefined = 'en-CA'): HTMLElement {
  const t = getMapCopy(locale);
  const markerElement = document.createElement('button');
  const markerPinElement = document.createElement('span');
  markerElement.type = 'button';
  markerElement.className = 'departure-map-marker';
  markerElement.style.zIndex = '3000';
  markerElement.setAttribute('aria-label', point.addressLabel === undefined ? t.routeStart(point.label) : t.storeAddress(point.addressLabel));
  markerPinElement.className = 'departure-map-marker__pin';
  markerPinElement.append(createDepartureMarkerIconElement());
  markerElement.append(markerPinElement);
  return markerElement;
}

function createRouteStopMarkerElement(point: RouteOpsPoint, selected: boolean, onRouteStopSelect?: (deliveryStopId: string) => void): HTMLElement {
  const markerElement = document.createElement('button');
  markerElement.type = 'button';
  markerElement.className = ['route-stop-map-marker', point.preview === true ? 'preview' : '', selected ? 'selected' : ''].filter(Boolean).join(' ');
  markerElement.style.zIndex = selected ? '3200' : point.preview === true ? '3100' : '3000';
  markerElement.textContent = point.label;
  markerElement.setAttribute('aria-label', `Route stop ${point.label}`);
  markerElement.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onRouteStopSelect?.(point.id);
  });
  return markerElement;
}

function createDepartureMarkerIconElement(): SVGSVGElement {
  const iconElement = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const iconPathElement = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  iconElement.classList.add('departure-map-marker__icon');
  iconElement.setAttribute('viewBox', '0 0 20 20');
  iconElement.setAttribute('aria-hidden', 'true');
  iconPathElement.setAttribute('d', ROUTE_START_ICON_PATH);
  iconElement.append(iconPathElement);
  return iconElement;
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
  void maplibregl;
  safeResizeMap(map);
  const bounds = fitBoundsForPoints(points);
  if (bounds === null) return;
  if (points.length === 1) {
    map.easeTo({ center: [points[0]?.longitude ?? 0, points[0]?.latitude ?? 0], duration: 0, zoom: 12 });
    return;
  }
  map.fitBounds([[bounds.west, bounds.south], [bounds.east, bounds.north]], { duration: 0, maxZoom: 14, padding: 56 });
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

export function RouteStopSequencePicker({ anchor, currentSequence, items, locale, onClose, onPickSequence, orderName, sequenceCount }: RouteStopSequencePickerProps): ReactElement {
  const t = getMapCopy(locale);
  const choices = Array.from({ length: sequenceCount }, (_, index) => index + 1);
  const orderItems = getOrderItems(items);
  const focusTargetRef = useRef<HTMLButtonElement | null>(null);
  const preferredFocusSequence = choices.find((sequence) => sequence !== currentSequence) ?? null;
  useEffect(() => {
    focusTargetRef.current?.focus();
  }, [currentSequence, orderName, sequenceCount]);
  return (
    <div
      aria-label={t.routeStopSequencePicker(orderName)}
      className="route-stop-sequence-picker"
      data-placement={anchor.placement}
      onPointerDown={(event) => event.stopPropagation()}
      role="dialog"
      style={{ left: `${anchor.x}px`, top: `${anchor.y}px` }}
    >
      <button aria-label={t.closeRouteStopSequencePicker} className="route-stop-sequence-picker__close" onClick={onClose} ref={preferredFocusSequence === null ? focusTargetRef : undefined} type="button">×</button>
      {orderItems.length === 0 ? null : (
        <div className="route-stop-sequence-picker__items" aria-label={t.stopItems}>
          <strong>{orderName}</strong>
          <ul>
            {orderItems.map((item, itemIndex) => (
              <li key={getOrderItemDisplayKey(item, itemIndex)}>{formatOrderItemLine(item)}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="route-stop-sequence-picker__choices">
        {choices.map((sequence) => {
          const isCurrent = sequence === currentSequence;
          return (
            <button
              aria-current={isCurrent ? 'true' : undefined}
              aria-label={t.routeStopSequenceChoice(orderName, sequence)}
              className={isCurrent ? 'current' : undefined}
              disabled={isCurrent}
              key={sequence}
              onClick={() => onPickSequence(sequence)}
              ref={sequence === preferredFocusSequence ? focusTargetRef : undefined}
              type="button"
            >
              {sequence}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SequencePreview({ locale, points, readiness }: { locale?: string | null; points: RouteOpsPoint[]; readiness: string }): ReactElement {
  const t = getMapCopy(locale);
  const bounds = fitBoundsForPoints(points);
  const projected = bounds === null ? [] : points.map((point) => ({ ...point, ...projectPoint(point, bounds) }));
  return (
    <svg viewBox="0 0 1000 560" role="img" aria-label={readiness === 'provider_not_configured' ? t.markerPreview : t.routePreview}>
      <defs><linearGradient id="map-bg" x1="0" x2="1" y1="0" y2="1"><stop offset="0%" stopColor="#eef4fb" /><stop offset="100%" stopColor="#f8f4ec" /></linearGradient></defs>
      <rect width="1000" height="560" fill="url(#map-bg)" rx="24" />
      <path d="M-20 120 C200 90 260 210 440 176 C650 135 700 56 1040 85" className="map-road" />
      <path d="M40 470 C190 300 320 390 475 260 C610 145 730 300 955 210" className="map-road secondary" />
      {projected.map((point) => (
        <g key={point.id} transform={`translate(${point.x} ${point.y})`}>
          <circle
            r="18"
            className={[
              "pin",
              point.kind === "depot" ? "depot" : "",
              point.preview ? "preview" : "",
            ].filter(Boolean).join(" ")}
          />
          <text y="5" textAnchor="middle">{point.label}</text>
        </g>
      ))}
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
