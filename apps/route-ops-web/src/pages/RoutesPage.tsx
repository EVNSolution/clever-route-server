import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties, DragEvent, ReactElement } from "react";

import {
  ApiError,
  deleteRoute,
  getDrivers,
  getRouteDetail,
  getRouteGrouping,
  getRoutes,
  publishRoute,
  saveRoute,
} from "../api";
import { Badge, Kpi } from "../components/primitives";
import { TabLayout } from "../components/TabLayout";
import { RouteOpsMap } from "../components/maps/RouteOpsMap";
import { ROUTE_START_ICON_PATH } from "../components/maps/mapIcons";
import { getRoutesCopy, resolveLocale } from "../i18n";
import {
  formatOrderItemLine,
  formatOrderItemName,
  formatOrderItemOptions,
  getOrderItemSemanticDisplayKey,
  getOrderItems,
  getRouteItemSummary,
} from "../orderItems";
import {
  deriveRouteStats,
  hasStopSequenceChanged,
  moveStop,
  moveStopToDropPosition,
  moveStopToSequence,
} from "../state";
import type { StopDropPosition } from "../state";
import type {
  BootstrapPayload,
  DriverDto,
  RouteGroupingSummaryDto,
  RoutePlanDetailDto,
  RoutePlanSummaryDto,
  RouteStopDto,
} from "../types";
import { readErrorMessage } from "../utils/format";

type RouteEndMode = RoutePlanDetailDto["routePlan"]["routeEndMode"];
type SaveRouteInput = Parameters<typeof saveRoute>[0];
type StopDropPreview = {
  position: StopDropPosition;
  targetStopId: string;
};

export function getDriverOptionLabel(
  driver: DriverDto,
  _locale: string | null | undefined = "en-CA",
): string {
  return driver.displayName;
}

export function getRouteDriverDisplay(
  routePlan: Pick<RoutePlanSummaryDto, "driverId"> | null,
  drivers: DriverDto[],
  locale: string | null | undefined = "en-CA",
): string {
  const t = getRoutesCopy(locale);
  if (routePlan?.driverId == null) return t.unassigned;
  const driver = drivers.find((item) => item.id === routePlan.driverId);
  return driver === undefined
    ? routePlan.driverId
    : getDriverOptionLabel(driver, locale);
}

export function formatRouteChildDriverName(
  child: Pick<
    RouteGroupingSummaryDto["children"][number],
    "driverName" | "routePlan"
  >,
): string {
  return child.driverName ?? "Unassigned";
}

export function formatRoutePlanNameForDisplay(name: string): string {
  return name.replace(/\s+v\d+$/u, "");
}

export function formatRouteChildStopTitle(name: string): string {
  return formatRoutePlanNameForDisplay(name).replace(/\s+—\s+.+$/u, "");
}

export function getRouteStopSequenceDisplay(
  stop: Pick<RouteStopDto, "deliveryStopId" | "sequence">,
  savedSequenceLabels: ReadonlyMap<string, number>,
): number {
  return savedSequenceLabels.get(stop.deliveryStopId) ?? stop.sequence;
}

export function getChildRouteSequenceColor(isEditing: boolean): string {
  return isEditing ? "#2563eb" : "#111827";
}

export function shouldTryRouteGroupFallback(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 404 &&
    error.code === "NOT_FOUND"
  );
}

export function isRouteVisibleToLinkedDriver(
  routePlan: Pick<RoutePlanSummaryDto, "driverId" | "status">,
  drivers: DriverDto[],
): boolean {
  if (routePlan.driverId === null) return false;
  const driver = drivers.find((item) => item.id === routePlan.driverId);
  const isDriverLinked =
    driver?.appLinked === true || driver?.authStatus === "APP_LINKED";
  return (
    isDriverLinked &&
    ["ASSIGNED", "IN_PROGRESS", "OPTIMIZED"].includes(routePlan.status)
  );
}

export function getRoutePublishBadge(
  routePlan: Pick<RoutePlanSummaryDto, "status"> | null,
  locale: string | null | undefined = "en-CA",
): { tone: "green" | "orange"; text: string } | null {
  const t = getRoutesCopy(locale);
  if (routePlan === null) return null;
  if (routePlan.status === "DRAFT") {
    return { tone: "orange", text: t.publishState.draft };
  }
  return { tone: "green", text: t.publishState.published };
}

export function formatRoutePlanStatus(
  status: string,
  locale: string | null | undefined = "en-CA",
): string {
  const t = getRoutesCopy(locale).routeStatus;
  return (
    t[status as keyof typeof t] ??
    status
      .toLowerCase()
      .split(/[_\s-]+/u)
      .filter(Boolean)
      .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
      .join(" ")
  );
}

export function hasDepotCoordinates(
  routePlan: Pick<RoutePlanSummaryDto, "depot"> | null,
): boolean {
  const latitude = routePlan?.depot.latitude;
  const longitude = routePlan?.depot.longitude;
  return (
    routePlan !== null &&
    typeof latitude === "number" &&
    typeof longitude === "number" &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

export function buildRouteSaveDraftInput({
  csrfToken,
  detail,
  driverId,
  draftStops,
  routeEndMode,
}: {
  csrfToken: string;
  detail: RoutePlanDetailDto;
  driverId: string | null;
  draftStops: RouteStopDto[];
  routeEndMode: RouteEndMode;
}): SaveRouteInput {
  return {
    csrfToken,
    driverId,
    expectedUpdatedAt: detail.routePlan.updatedAt,
    routeEndMode,
    routePlanId: detail.routePlan.id,
    stops: draftStops.map((stop) => ({
      deliveryStopId: stop.deliveryStopId,
      sourceOrderId: stop.sourceOrderId,
    })),
  };
}

export function RoutesPage({
  bootstrap,
  navigate,
  routePlanId,
  setError,
}: {
  bootstrap: BootstrapPayload;
  navigate(path: string): void;
  routePlanId: string | null;
  setError(error: string | null): void;
}): ReactElement {
  const locale = resolveLocale(bootstrap.locale);
  const t = getRoutesCopy(locale);
  const [routes, setRoutes] = useState<RoutePlanSummaryDto[]>([]);
  const [routeGroups, setRouteGroups] = useState<RouteGroupingSummaryDto[]>([]);
  const [detail, setDetail] = useState<RoutePlanDetailDto | null>(null);
  const [drivers, setDrivers] = useState<DriverDto[]>([]);
  const [deletingRouteId, setDeletingRouteId] = useState<string | null>(null);
  const [collapsedRouteGroupIds, setCollapsedRouteGroupIds] = useState<
    Set<string>
  >(() => new Set());

  const refreshRoutes = useCallback(async (): Promise<void> => {
    try {
      const payload = await getRoutes("");
      setRoutes(payload.standaloneRoutes ?? payload.routePlans);
      setRouteGroups(payload.routeGroups ?? []);
      setError(null);
    } catch (error) {
      setError(readErrorMessage(error));
    }
  }, [setError]);

  useEffect(() => {
    void refreshRoutes();
    getDrivers()
      .then((payload) => setDrivers(payload.drivers))
      .catch((error: unknown) => setError(readErrorMessage(error)));
  }, [refreshRoutes, setError]);

  useEffect(() => {
    setDetail(null);
    if (routePlanId === null) {
      return;
    }

    let active = true;
    getRouteDetail(routePlanId)
      .then((payload) => {
        if (!active) return;
        setDetail(payload);
        setError(null);
      })
      .catch((error: unknown) => {
        if (!shouldTryRouteGroupFallback(error)) {
          setError(readErrorMessage(error));
          return;
        }

        getRouteGrouping(routePlanId)
          .then((payload) => {
            if (!active) return;
            setDetail(null);
            setError(null);
            navigate(
              `/admin/ui/app/route-groups/${encodeURIComponent(payload.routeGroup.id)}`,
            );
          })
          .catch(() => {
            if (!active) return;
            setError(readErrorMessage(error));
          });
      });

    return () => {
      active = false;
    };
  }, [navigate, routePlanId, setError]);

  if (routePlanId !== null) {
    if (detail === null) {
      return (
        <TabLayout
          primary={
            <section className="panel route-detail-loading-card">
              <p className="muted">Loading route…</p>
            </section>
          }
          secondary={null}
          title={t.routeBuilder}
        />
      );
    }

    return (
      <RouteBuilder
        bootstrap={bootstrap}
        deletingRouteId={deletingRouteId}
        detail={detail}
        drivers={drivers}
        isChildRouteDetail={detail.routePlan.routeGroupingChild != null}
        locale={locale}
        navigate={navigate}
        onDeleteRoute={(id) => void deleteRoutePlan(id)}
        onRefreshRoutes={() => void refreshRoutes()}
        setDetail={setDetail}
        setError={setError}
      />
    );
  }

  async function deleteRoutePlan(routeId: string): Promise<void> {
    const route =
      routes.find((item) => item.id === routeId) ?? detail?.routePlan ?? null;
    const routeName = route?.name ?? t.routes;
    if (!window.confirm(t.deleteConfirm(routeName))) return;
    setDeletingRouteId(routeId);
    try {
      await deleteRoute(routeId, bootstrap.csrfToken);
      setRoutes((current) => current.filter((item) => item.id !== routeId));
      if (routePlanId === routeId) {
        setDetail(null);
        navigate("/admin/ui/app/routes");
      }
      await refreshRoutes();
      setError(null);
    } catch (error) {
      setError(readErrorMessage(error));
    } finally {
      setDeletingRouteId(null);
    }
  }

  return (
    <section className="workspace-stack">
      <div className="summary-strip">
        <Kpi label={t.routes} value={routes.length + routeGroups.length} />
        <Kpi
          label={t.stops}
          value={
            routes.reduce((sum, item) => sum + item.stopsCount, 0) +
            routeGroups.reduce((sum, group) => sum + group.totalOrders, 0)
          }
        />
        <Kpi
          label={t.missingCoordinates}
          value={routes.reduce((sum, item) => sum + item.missingCoordinates, 0)}
        />
      </div>
      <article className="panel">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">{t.routes}</span>
            <h2>{t.recentRoutePlans}</h2>
          </div>
          <button
            className="primary"
            onClick={() => navigate("/admin/ui/app/orders")}
            type="button"
          >
            {t.createRoute}
          </button>
        </div>
        <div className="table-scroll route-list-table-scroll">
          <RouteListTable
            deletingRouteId={deletingRouteId}
            drivers={drivers}
            locale={locale}
            navigate={navigate}
            onDeleteRoute={(routeId) => void deleteRoutePlan(routeId)}
            onToggleRouteGroup={(routeGroupId) =>
              setCollapsedRouteGroupIds((current) => {
                const next = new Set(current);
                if (next.has(routeGroupId)) next.delete(routeGroupId);
                else next.add(routeGroupId);
                return next;
              })
            }
            collapsedRouteGroupIds={collapsedRouteGroupIds}
            routeGroups={routeGroups}
            routes={routes}
          />
        </div>
      </article>
    </section>
  );
}

export function RouteListTable({
  deletingRouteId,
  drivers,
  locale,
  navigate,
  onDeleteRoute,
  onToggleRouteGroup,
  collapsedRouteGroupIds,
  routeGroups,
  routes,
}: {
  collapsedRouteGroupIds?: ReadonlySet<string>;
  deletingRouteId: string | null;
  drivers: DriverDto[];
  locale?: string | null;
  navigate(path: string): void;
  onDeleteRoute(routeId: string): void;
  onToggleRouteGroup?(routeGroupId: string): void;
  routeGroups: RouteGroupingSummaryDto[];
  routes: RoutePlanSummaryDto[];
}): ReactElement {
  const t = getRoutesCopy(locale);
  return (
    <table className="ops-table">
      <thead>
        <tr>
          <th>{t.table.name}</th>
          <th>{t.table.status}</th>
          <th>{t.table.stops}</th>
          <th>{t.table.date}</th>
          <th>Split</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {routeGroups.map((group) => (
          <Fragment key={group.id}>
            <tr className="route-group-row route-group-parent-row">
              <td>
                <div className="route-tree-parent">
                  <button
                    aria-expanded={!collapsedRouteGroupIds?.has(group.id)}
                    aria-label="Toggle child routes"
                    className="route-tree-toggle"
                    disabled={group.children.length === 0}
                    onClick={() => onToggleRouteGroup?.(group.id)}
                    type="button"
                  >
                    {collapsedRouteGroupIds?.has(group.id) ? "▸" : "▾"}
                  </button>
                  <div>
                    <span className="route-tree-title">{group.name}</span>
                  </div>
                </div>
              </td>
              <td>
                <Badge>{group.displayStatus}</Badge>
              </td>
              <td>{group.totalOrders}</td>
              <td>{group.planDate}</td>
              <td>
                {group.unresolvedOrders === 0
                  ? "Resolved"
                  : `${group.unresolvedOrders} unresolved`}
              </td>
              <td>
                <button
                  onClick={() =>
                    navigate(
                      `/admin/ui/app/route-groups/${encodeURIComponent(group.id)}`,
                    )
                  }
                  type="button"
                >
                  Open
                </button>
              </td>
            </tr>
            {collapsedRouteGroupIds?.has(group.id) ? null : group.children
                .length === 0 ? (
              <tr className="route-group-child-row route-group-child-empty">
                <td colSpan={6}>
                  <div className="route-tree-child">
                    <span className="route-tree-branch" aria-hidden="true">
                      └
                    </span>
                    <span className="muted">No child routes generated yet</span>
                  </div>
                </td>
              </tr>
            ) : (
              group.children.map((child) => (
                <tr
                  key={`${group.id}:${child.routePlanId ?? child.driverId}:${child.childVersion}`}
                  className="route-group-child-row"
                >
                  <td>
                    <div className="route-tree-child">
                      <span className="route-tree-branch" aria-hidden="true">
                        └
                      </span>
                      <div>
                        <span className="route-tree-title">
                          {formatRouteChildDriverName(child)}
                        </span>
                      </div>
                    </div>
                  </td>
                  <td>
                    <Badge>{child.displayStatus}</Badge>
                  </td>
                  <td>{child.stopsCount}</td>
                  <td>{group.planDate}</td>
                  <td />
                  <td>
                    {child.routePlanId === null ? null : (
                      <button
                        onClick={() =>
                          navigate(
                            `/admin/ui/app/routes/${encodeURIComponent(child.routePlanId ?? "")}`,
                          )
                        }
                        type="button"
                      >
                        {t.open}
                      </button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </Fragment>
        ))}
        {routes.map((item) => (
          <tr key={item.id}>
            <td>
              <strong>{item.name}</strong>
            </td>
            <td>
              <Badge>{formatRoutePlanStatus(item.status, locale)}</Badge>
            </td>
            <td>{item.stopsCount}</td>
            <td>{item.deliveryDate ?? item.planDate}</td>
            <td>{getRouteDriverDisplay(item, drivers, locale)}</td>
            <td>
              <div className="route-row-actions">
                <button
                  onClick={() =>
                    navigate(
                      `/admin/ui/app/routes/${encodeURIComponent(item.id)}`,
                    )
                  }
                  type="button"
                >
                  {t.open}
                </button>
                <button
                  className="danger subtle"
                  disabled={deletingRouteId === item.id}
                  onClick={() => onDeleteRoute(item.id)}
                  type="button"
                >
                  {deletingRouteId === item.id ? t.deleting : t.delete}
                </button>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function RouteBuilder(input: {
  bootstrap: BootstrapPayload;
  deletingRouteId: string | null;
  detail: RoutePlanDetailDto | null;
  drivers: DriverDto[];
  isChildRouteDetail?: boolean;
  locale?: string | null;
  navigate(path: string): void;
  onDeleteRoute(routePlanId: string): void;
  onRefreshRoutes(): void;
  setDetail(detail: RoutePlanDetailDto): void;
  setError(error: string | null): void;
}): ReactElement {
  const [draftStops, setDraftStops] = useState<RouteStopDto[]>(
    () => input.detail?.stops ?? [],
  );
  const [draftDriverId, setDraftDriverId] = useState(
    () => input.detail?.routePlan.driverId ?? "",
  );
  const [draftRouteEndMode, setDraftRouteEndMode] = useState<RouteEndMode>(
    () => input.detail?.routePlan.routeEndMode ?? "END_AT_LAST_STOP",
  );
  const [selectedRouteStopId, setSelectedRouteStopId] = useState<string | null>(
    null,
  );
  const [draggingStopId, setDraggingStopId] = useState<string | null>(null);
  const [dropPreview, setDropPreview] = useState<StopDropPreview | null>(null);
  const [isSavingRoute, setIsSavingRoute] = useState(false);
  const [isPublishingRoute, setIsPublishingRoute] = useState(false);
  const detail = input.detail;
  const locale = resolveLocale(input.locale);
  const t = getRoutesCopy(locale);

  useEffect(() => {
    setDraftStops(detail?.stops ?? []);
    setSelectedRouteStopId(null);
  }, [detail]);
  useEffect(
    () => setDraftDriverId(detail?.routePlan.driverId ?? ""),
    [detail?.routePlan.driverId],
  );
  useEffect(
    () =>
      setDraftRouteEndMode(
        detail?.routePlan.routeEndMode ?? "END_AT_LAST_STOP",
      ),
    [detail?.routePlan.id, detail?.routePlan.routeEndMode],
  );

  const stats = deriveRouteStats(detail);
  const itemSummary = getRouteItemSummary(detail?.routePlan.itemSummary);
  const routeItems = getOrderItems(itemSummary.items);
  const hasSequenceChanges = hasStopSequenceChanged(detail?.stops, draftStops);
  const effectiveDriverId = draftDriverId === "" ? null : draftDriverId;
  const hasDriverChanges =
    detail !== null &&
    effectiveDriverId !== (detail.routePlan.driverId ?? null);
  const hasRouteEndChanges =
    detail !== null && draftRouteEndMode !== detail.routePlan.routeEndMode;
  const canReturnToDepot =
    detail !== null && hasDepotCoordinates(detail.routePlan);
  const isUnsafeRouteEndDraft =
    detail !== null &&
    draftRouteEndMode === "RETURN_TO_DEPOT" &&
    !canReturnToDepot;
  const effectiveRoutePlan =
    detail === null
      ? null
      : {
          ...detail.routePlan,
          driverId: effectiveDriverId,
          routeEndMode: draftRouteEndMode,
          stopsCount: draftStops.length,
        };
  const publishBadge = getRoutePublishBadge(effectiveRoutePlan, locale);
  const isDriverVisible =
    effectiveRoutePlan !== null && effectiveRoutePlan.status !== "DRAFT";
  const hasUnsavedRouteChanges =
    hasSequenceChanges || hasDriverChanges || hasRouteEndChanges;
  const canSaveRoute =
    detail !== null &&
    !isSavingRoute &&
    !isUnsafeRouteEndDraft &&
    hasUnsavedRouteChanges;
  const isChildRouteDetail = input.isChildRouteDetail === true;
  const savedStopSequenceLabels = useMemo(
    () =>
      new Map(
        (detail?.stops ?? []).map((stop) => [stop.deliveryStopId, stop.sequence]),
      ),
    [detail?.stops],
  );
  const saveRouteDraft = async (): Promise<RoutePlanDetailDto> => {
    if (detail === null) {
      throw new Error("Route detail is not loaded.");
    }
    const updated = await saveRoute(
      buildRouteSaveDraftInput({
        csrfToken: input.bootstrap.csrfToken,
        detail,
        driverId: effectiveDriverId,
        draftStops,
        routeEndMode: draftRouteEndMode,
      }),
    );
    const refreshed = await getRouteDetail(updated.routePlan.id);
    input.setDetail(refreshed);
    input.onRefreshRoutes();
    return refreshed;
  };

  const save = async (): Promise<void> => {
    if (detail === null || !canSaveRoute) return;
    setIsSavingRoute(true);
    try {
      await saveRouteDraft();
      input.setError(null);
    } catch (error) {
      input.setError(readErrorMessage(error));
    } finally {
      setIsSavingRoute(false);
    }
  };

  const sendRouteToDriver = async (): Promise<void> => {
    if (detail === null || isDriverVisible) return;
    setIsPublishingRoute(true);
    try {
      const latest = hasUnsavedRouteChanges ? await saveRouteDraft() : detail;
      const published = await publishRoute(
        latest.routePlan.id,
        input.bootstrap.csrfToken,
      );
      input.setDetail(published);
      input.onRefreshRoutes();
      input.setError(null);
    } catch (error) {
      input.setError(readErrorMessage(error));
    } finally {
      setIsPublishingRoute(false);
    }
  };

  const moveDraftStop = (deliveryStopId: string, direction: -1 | 1): void => {
    setDraftStops((current) => moveStop(current, deliveryStopId, direction));
    setSelectedRouteStopId(null);
  };

  const clearStopDragPreview = (): void => {
    setDraggingStopId(null);
    setDropPreview(null);
  };

  const dropDraftStop = (
    targetStopId: string,
    position: StopDropPosition,
  ): void => {
    if (draggingStopId !== null) {
      setDraftStops((current) =>
        moveStopToDropPosition(current, draggingStopId, targetStopId, position),
      );
    }
    setSelectedRouteStopId(null);
    clearStopDragPreview();
  };

  const moveDraftStopToSequence = (
    deliveryStopId: string,
    sequence: number,
  ): void => {
    setDraftStops((current) =>
      moveStopToSequence(current, deliveryStopId, sequence),
    );
    setSelectedRouteStopId(null);
    clearStopDragPreview();
  };

  const returnToDepotChecked = draftRouteEndMode === "RETURN_TO_DEPOT";
  const returnToDepotDisabled =
    detail === null || (!returnToDepotChecked && !canReturnToDepot);
  const routeEndWarningId = "route-end-depot-warning";
  const canSendRouteToDriver =
    detail !== null &&
    !isDriverVisible &&
    !isSavingRoute &&
    !isPublishingRoute &&
    !isUnsafeRouteEndDraft &&
    effectiveDriverId !== null &&
    draftStops.length > 0;
  const routeMapHeaderAction = (
    <div className="route-map-header-actions">
      {publishBadge === null ? null : (
        <button
          className={`route-visibility-button ${publishBadge.tone}`}
          disabled={isDriverVisible || !canSendRouteToDriver}
          onClick={() => void sendRouteToDriver()}
          type="button"
        >
          {isDriverVisible
            ? t.visibleToDriver
            : isPublishingRoute
              ? t.sendingToDriver
              : t.sendToDriver}
        </button>
      )}
      {isChildRouteDetail ? (
        <button
          className="danger subtle route-map-delete-button"
          disabled={
            detail === null || input.deletingRouteId === detail.routePlan.id
          }
          onClick={() => {
            if (detail !== null) input.onDeleteRoute(detail.routePlan.id);
          }}
          type="button"
        >
          {detail !== null && input.deletingRouteId === detail.routePlan.id
            ? t.deleting
            : t.delete}
        </button>
      ) : null}
    </div>
  );
  const routeSummaryLower = (
    <div className="route-summary-lower">
      {isChildRouteDetail ? (
        <ChildRouteSequenceCard
          canReturnToDepot={canReturnToDepot}
          canSaveRoute={canSaveRoute}
          disabled={detail === null}
          draggingStopId={draggingStopId}
          drivers={input.drivers}
          draftDriverId={draftDriverId}
          dropPreview={dropPreview}
          isEditing={hasUnsavedRouteChanges}
          isSavingRoute={isSavingRoute}
          locale={locale}
          onDragEnd={clearStopDragPreview}
          onDragStart={setDraggingStopId}
          onDriverChange={setDraftDriverId}
          onDrop={dropDraftStop}
          onDropPreview={setDropPreview}
          onReturnToDepotChange={(checked) => {
            if (checked && !canReturnToDepot) return;
            setDraftRouteEndMode(
              checked ? "RETURN_TO_DEPOT" : "END_AT_LAST_STOP",
            );
          }}
          onSave={() => void save()}
          returnToDepotChecked={returnToDepotChecked}
          returnToDepotDisabled={returnToDepotDisabled}
          routeEndWarningId={routeEndWarningId}
          routeName={
            detail === null
              ? t.routeBuilder
              : formatRouteChildStopTitle(detail.routePlan.name)
          }
          savedStopSequenceLabels={savedStopSequenceLabels}
          stops={draftStops}
        />
      ) : null}
      <div className="summary-strip compact-kpis route-summary-kpis">
        <Kpi label={t.stops} value={stats.stops} />
        <Kpi label={t.completed} value={stats.completed} />
        <Kpi label={t.attempted} value={stats.attempted} />
        <Kpi label={t.missingCoords} value={stats.missingCoordinates} />
        <Kpi label={t.itemsTotal} value={itemSummary.totalQuantity} />
        <Kpi label={t.itemTypes} value={itemSummary.itemTypes} />
      </div>
      <section className="route-item-summary-card" aria-label={t.routeItems}>
        <div className="route-item-summary-heading">
          <h3>{t.routeItems}</h3>
          {itemSummary.changedSincePublish ? (
            <Badge>{t.itemsChanged}</Badge>
          ) : null}
        </div>
        {routeItems.length === 0 ? (
          <p className="route-item-empty">{t.noItems}</p>
        ) : (
          <div className="route-item-table-scroll">
            <table className="route-item-table">
              <thead>
                <tr>
                  <th>{t.item}</th>
                  <th>{t.itemOptions}</th>
                  <th>{t.quantity}</th>
                </tr>
              </thead>
              <tbody>
                {routeItems.map((item) => (
                  <tr key={getOrderItemSemanticDisplayKey(item)}>
                    <td>{formatOrderItemName(item)}</td>
                    <td>{formatOrderItemOptions(item) || "—"}</td>
                    <td>{item.quantity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
  const standaloneRouteControls = isChildRouteDetail ? null : (
    <aside className="panel side-panel route-save-panel route-builder-card-shell">
      <div className="route-builder-card-header">
        <span className="eyebrow">{t.routeState}</span>
        <div className="route-row-actions route-builder-card-actions">
          <button
            className="danger subtle"
            disabled={
              detail === null || input.deletingRouteId === detail.routePlan.id
            }
            onClick={() => {
              if (detail !== null) input.onDeleteRoute(detail.routePlan.id);
            }}
            type="button"
          >
            {detail !== null && input.deletingRouteId === detail.routePlan.id
              ? t.deleting
              : t.delete}
          </button>
        </div>
      </div>
      <div className="route-builder-tab-body route-builder-tab-body--driver">
        <dl className="route-state-list">
          <div>
            <dt>{t.table.date}</dt>
            <dd>
              {detail?.routePlan.deliveryDate ??
                detail?.routePlan.planDate ??
                "—"}
            </dd>
          </div>
          <div>
            <dt>{t.table.stops}</dt>
            <dd>{draftStops.length}</dd>
          </div>
          <div>
            <dt>{t.table.driver}</dt>
            <dd>
              {getRouteDriverDisplay(effectiveRoutePlan, input.drivers, locale)}
            </dd>
          </div>
        </dl>
        <label>
          {t.table.driver}
          <select
            value={draftDriverId}
            onChange={(event) => setDraftDriverId(event.target.value)}
          >
            <option value="">{t.unassigned}</option>
            {input.drivers.map((driver) => (
              <option key={driver.id} value={driver.id}>
                {getDriverOptionLabel(driver, locale)}
              </option>
            ))}
          </select>
        </label>
        <label className="route-end-toggle">
          <input
            aria-describedby={!canReturnToDepot ? routeEndWarningId : undefined}
            checked={returnToDepotChecked}
            className="route-end-toggle-checkbox"
            disabled={returnToDepotDisabled}
            onChange={(event) => {
              if (event.target.checked && !canReturnToDepot) return;
              setDraftRouteEndMode(
                event.target.checked ? "RETURN_TO_DEPOT" : "END_AT_LAST_STOP",
              );
            }}
            type="checkbox"
          />
          <span>{t.returnToStore}</span>
        </label>
        {!canReturnToDepot ? (
          <small className="form-warning" id={routeEndWarningId}>
            {t.returnToStoreDepotMissing}
          </small>
        ) : null}
      </div>
      <div className="route-builder-tab-body route-builder-tab-body--stop-order">
        <RouteStopOrderCompactList
          disabled={false}
          draggingStopId={draggingStopId}
          dropPreview={dropPreview}
          locale={locale}
          onDragEnd={clearStopDragPreview}
          onDragStart={setDraggingStopId}
          onDrop={dropDraftStop}
          onDropPreview={setDropPreview}
          onMove={moveDraftStop}
          stops={draftStops}
        />
      </div>
      <div className="route-builder-card-footer">
        <div className="route-save-controls">
          <button
            aria-label={t.saveRoute}
            className="primary route-save-button"
            disabled={!canSaveRoute}
            onClick={() => void save()}
            type="button"
          >
            {isSavingRoute ? t.savingRoute : t.saveRoute}
          </button>
        </div>
      </div>
    </aside>
  );

  return (
    <TabLayout
      title={t.routeBuilder}
      primary={
        <div className="route-builder-workspace">
          <RouteOpsMap
            bootstrap={input.bootstrap}
            detail={detail}
            draftStops={hasSequenceChanges ? draftStops : undefined}
            headerAction={routeMapHeaderAction}
            onRouteStopPickerClose={() => setSelectedRouteStopId(null)}
            onRouteStopSelect={(deliveryStopId) =>
              setSelectedRouteStopId(deliveryStopId)
            }
            onRouteStopSequencePick={moveDraftStopToSequence}
            selectedRouteStopId={selectedRouteStopId}
            showRouteStopPickerItems={!isChildRouteDetail}
            title={
              detail === null
                ? t.routeBuilder
                : formatRoutePlanNameForDisplay(detail.routePlan.name)
            }
          />
        </div>
      }
      primaryExpanded={isChildRouteDetail}
      secondary={standaloneRouteControls}
      lower={routeSummaryLower}
    />
  );
}

function ChildRouteSequenceCard({
  canReturnToDepot,
  canSaveRoute,
  disabled,
  draggingStopId,
  drivers,
  draftDriverId,
  dropPreview,
  isEditing,
  isSavingRoute,
  locale,
  onDragEnd,
  onDragStart,
  onDriverChange,
  onDrop,
  onDropPreview,
  onReturnToDepotChange,
  onSave,
  returnToDepotChecked,
  returnToDepotDisabled,
  routeEndWarningId,
  routeName,
  savedStopSequenceLabels,
  stops,
}: {
  canReturnToDepot: boolean;
  canSaveRoute: boolean;
  disabled: boolean;
  draggingStopId: string | null;
  drivers: DriverDto[];
  draftDriverId: string;
  dropPreview: StopDropPreview | null;
  isEditing: boolean;
  isSavingRoute: boolean;
  locale?: string | null;
  onDragEnd(): void;
  onDragStart(deliveryStopId: string): void;
  onDriverChange(driverId: string): void;
  onDrop(targetStopId: string, position: StopDropPosition): void;
  onDropPreview(preview: StopDropPreview | null): void;
  onReturnToDepotChange(checked: boolean): void;
  onSave(): void;
  returnToDepotChecked: boolean;
  returnToDepotDisabled: boolean;
  routeEndWarningId: string;
  routeName: string;
  savedStopSequenceLabels: ReadonlyMap<string, number>;
  stops: RouteStopDto[];
}): ReactElement {
  const t = getRoutesCopy(locale);
  const color = getChildRouteSequenceColor(isEditing);

  const getDropPosition = (event: DragEvent<HTMLElement>): StopDropPosition => {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientX > rect.left + rect.width / 2 ? "after" : "before";
  };

  const previewFor = (
    event: DragEvent<HTMLElement>,
    targetStopId: string,
  ): StopDropPreview | null => {
    if (draggingStopId === null || draggingStopId === targetStopId) return null;
    return { position: getDropPosition(event), targetStopId };
  };
  const selectedDriverLabel =
    drivers.find((driver) => driver.id === draftDriverId)?.displayName ??
    t.unassigned;

  return (
    <article
      aria-label={t.routeBuilderTabs.stopOrder}
      className="panel route-group-areas-card route-child-sequence-card"
      style={
        {
          "--route-group-area-columns": String(Math.max(1, stops.length)),
        } as CSSProperties
      }
    >
      <div className="route-child-sequence-header">
        <div>
          <span className="eyebrow">{t.routeStops}</span>
          <h3>{routeName}</h3>
        </div>
      </div>
      <div className="route-group-area-list route-child-sequence-list">
        <div className="route-group-area-row route-child-sequence-row">
          <label className="route-group-area-driver route-group-area-driver--assignable route-child-sequence-driver">
            <span className="route-child-sequence-driver-name">
              {selectedDriverLabel}
            </span>
            <span aria-hidden="true" className="route-child-sequence-driver-chevron">
              ▾
            </span>
            <select
              aria-label={t.table.driver}
              className="route-group-area-driver-select route-child-sequence-driver-select"
              disabled={disabled}
              onChange={(event) => onDriverChange(event.target.value)}
              value={draftDriverId}
            >
              <option value="">{t.unassigned}</option>
              {drivers.map((driver) => (
                <option key={driver.id} value={driver.id}>
                  {getDriverOptionLabel(driver, locale)}
                </option>
              ))}
            </select>
          </label>
          <span
            className="route-group-area-track route-child-sequence-track"
            style={{ "--route-group-area-color": color } as CSSProperties}
          >
            <span
              className="route-group-area-store-node"
              aria-label={t.storeStart}
              title={t.storeStart}
            >
              <svg
                className="route-group-area-store-icon"
                viewBox="0 0 20 20"
                aria-hidden="true"
              >
                <path d={ROUTE_START_ICON_PATH} />
              </svg>
            </span>
            <span
              className="route-group-area-orders"
              aria-label={t.routeBuilderTabs.stopOrder}
            >
              {stops.map((stop) => {
                const isDropTarget =
                  dropPreview?.targetStopId === stop.deliveryStopId;
                const dropPosition = isDropTarget ? dropPreview.position : null;
                return (
                  <span
                    className={[
                      "route-group-area-order-node",
                      "route-child-sequence-node",
                      draggingStopId === stop.deliveryStopId ? "dragging" : "",
                      isDropTarget ? "drop-target" : "",
                      dropPosition === "before" ? "drop-before" : "",
                      dropPosition === "after" ? "drop-after" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    data-drop-preview={dropPosition ?? undefined}
                    draggable={!disabled}
                    key={stop.deliveryStopId}
                    onDragEnd={onDragEnd}
                    onDragEnter={(event) => {
                      if (disabled) return;
                      onDropPreview(previewFor(event, stop.deliveryStopId));
                    }}
                    onDragOver={(event) => {
                      if (disabled) return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                      onDropPreview(previewFor(event, stop.deliveryStopId));
                    }}
                    onDragStart={(event) => {
                      if (disabled) {
                        event.preventDefault();
                        return;
                      }
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData(
                        "text/plain",
                        stop.deliveryStopId,
                      );
                      onDragStart(stop.deliveryStopId);
                    }}
                    onDrop={(event) => {
                      if (disabled) return;
                      event.preventDefault();
                      const position =
                        dropPreview?.targetStopId === stop.deliveryStopId
                          ? dropPreview.position
                          : getDropPosition(event);
                      onDrop(stop.deliveryStopId, position);
                    }}
                  >
                    <span
                      aria-label={t.dragPlanOrder(stop.orderName)}
                      className="route-group-area-order-token route-child-sequence-token"
                      style={{ background: color, borderColor: color }}
                      title={stop.orderName}
                    >
                      {getRouteStopSequenceDisplay(stop, savedStopSequenceLabels)}
                    </span>
                  </span>
                );
              })}
            </span>
            <span
              className="route-group-area-finish"
              style={{ borderColor: color, color }}
            >
              {t.finish}
            </span>
          </span>
        </div>
      </div>
      <div className="route-child-sequence-footer">
        <div className="route-child-sequence-return">
          <label className="route-end-toggle">
            <input
              aria-describedby={!canReturnToDepot ? routeEndWarningId : undefined}
              checked={returnToDepotChecked}
              className="route-end-toggle-checkbox"
              disabled={returnToDepotDisabled}
              onChange={(event) => onReturnToDepotChange(event.target.checked)}
              type="checkbox"
            />
            <span>{t.returnToStore}</span>
          </label>
          {!canReturnToDepot ? (
            <small className="form-warning" id={routeEndWarningId}>
              {t.returnToStoreDepotMissing}
            </small>
          ) : null}
        </div>
        <button
          aria-label={t.saveRoute}
          className="primary route-save-button"
          disabled={!canSaveRoute}
          onClick={onSave}
          type="button"
        >
          {isSavingRoute ? t.savingRoute : t.saveRoute}
        </button>
      </div>
    </article>
  );
}

export function RouteStopOrderCompactList({
  disabled = false,
  draggingStopId,
  dropPreview,
  locale,
  onDragEnd,
  onDragStart,
  onDrop,
  onDropPreview,
  onMove,
  showItems = true,
  stops,
}: {
  disabled?: boolean;
  draggingStopId: string | null;
  dropPreview: StopDropPreview | null;
  locale?: string | null;
  onDragEnd(): void;
  onDragStart(deliveryStopId: string): void;
  onDrop(targetStopId: string, position: StopDropPosition): void;
  onDropPreview(preview: StopDropPreview | null): void;
  onMove(deliveryStopId: string, direction: -1 | 1): void;
  showItems?: boolean;
  stops: RouteStopDto[];
}): ReactElement {
  const t = getRoutesCopy(locale);

  const scrollDragEdge = (event: DragEvent<HTMLElement>): void => {
    const list = event.currentTarget.closest<HTMLElement>(
      ".route-stop-compact-list",
    );
    if (list === null) return;
    const rect = list.getBoundingClientRect();
    const edge = Math.min(92, Math.max(44, rect.height / 5));
    const topDistance = event.clientY - rect.top;
    const bottomDistance = rect.bottom - event.clientY;
    const topStrength = topDistance < edge ? (edge - topDistance) / edge : 0;
    const bottomStrength =
      bottomDistance < edge ? (edge - bottomDistance) / edge : 0;
    const delta =
      bottomStrength > 0
        ? Math.ceil(8 + bottomStrength * 24)
        : topStrength > 0
          ? -Math.ceil(8 + topStrength * 24)
          : 0;
    if (delta !== 0) list.scrollBy({ behavior: "auto", top: delta });
  };

  const getDropPosition = (event: DragEvent<HTMLElement>): StopDropPosition => {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientY > rect.top + rect.height / 2 ? "after" : "before";
  };

  const previewFor = (
    event: DragEvent<HTMLElement>,
    targetStopId: string,
  ): StopDropPreview | null => {
    if (draggingStopId === null || draggingStopId === targetStopId) return null;
    return { position: getDropPosition(event), targetStopId };
  };

  return (
    <div
      aria-label={t.routeBuilderTabs.stopOrder}
      className={[
        "route-stop-compact-list",
        draggingStopId === null ? "" : "drag-active",
        disabled ? "locked" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      onDragOver={(event) => {
        event.preventDefault();
        scrollDragEdge(event);
      }}
      role="list"
    >
      {stops.map((stop, index) => {
        const isDropTarget = dropPreview?.targetStopId === stop.deliveryStopId;
        const dropPosition = isDropTarget ? dropPreview.position : null;
        return (
          <div
            className={[
              "route-stop-compact-row",
              draggingStopId === stop.deliveryStopId ? "dragging" : "",
              isDropTarget ? "drop-target" : "",
              dropPosition === "before" ? "drop-before" : "",
              dropPosition === "after" ? "drop-after" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            data-drop-preview={dropPosition ?? undefined}
            draggable={!disabled}
            key={stop.deliveryStopId}
            onDragEnd={onDragEnd}
            onDragEnter={(event) => {
              if (disabled) return;
              onDropPreview(previewFor(event, stop.deliveryStopId));
            }}
            onDragOver={(event) => {
              if (disabled) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              scrollDragEdge(event);
              onDropPreview(previewFor(event, stop.deliveryStopId));
            }}
            onDragStart={(event) => {
              if (disabled) {
                event.preventDefault();
                return;
              }
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", stop.deliveryStopId);
              onDragStart(stop.deliveryStopId);
            }}
            onDrop={(event) => {
              if (disabled) return;
              event.preventDefault();
              const position =
                dropPreview?.targetStopId === stop.deliveryStopId
                  ? dropPreview.position
                  : getDropPosition(event);
              onDrop(stop.deliveryStopId, position);
            }}
            role="listitem"
          >
            <span className="stop-number compact">{index + 1}</span>
            <div className="route-stop-compact-main">
              <strong>{stop.orderName}</strong>
              <small>
                {stop.recipientName ?? t.noRecipient} · {stop.addressLabel}
              </small>
              <small className="route-stop-compact-meta">
                {stop.deliveryArea ?? "—"} · <Badge>{stop.status}</Badge>
              </small>
              {showItems && getOrderItems(stop.items).length > 0 ? (
                <ul className="route-stop-item-lines">
                  {getOrderItems(stop.items).map((item, itemIndex) => (
                    <li
                      key={`${getOrderItemSemanticDisplayKey(item)}:${itemIndex}`}
                    >
                      {formatOrderItemLine(item)}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
            <div className="stop-actions route-stop-compact-actions">
              <button
                aria-label={t.moveUp(stop.orderName)}
                disabled={disabled || index === 0}
                onClick={() => onMove(stop.deliveryStopId, -1)}
                type="button"
              >
                ↑
              </button>
              <button
                aria-label={t.moveDown(stop.orderName)}
                disabled={disabled || index === stops.length - 1}
                onClick={() => onMove(stop.deliveryStopId, 1)}
                type="button"
              >
                ↓
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
