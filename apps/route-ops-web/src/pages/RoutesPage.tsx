import { useCallback, useEffect, useState } from "react";
import type { KeyboardEvent, ReactElement } from "react";

import {
  deleteRoute,
  getDrivers,
  getRouteDetail,
  getRoutes,
  saveRoute,
} from "../api";
import { Badge, Kpi } from "../components/primitives";
import { TabLayout } from "../components/TabLayout";
import { RouteOpsMap } from "../components/maps/RouteOpsMap";
import { getRoutesCopy, resolveLocale } from "../i18n";
import {
  deriveRouteStats,
  geometryLabel,
  hasStopSequenceChanged,
  moveStop,
  moveStopBefore,
} from "../state";
import type {
  BootstrapPayload,
  DriverDto,
  RoutePlanDetailDto,
  RoutePlanSummaryDto,
  RouteStopDto,
} from "../types";
import { readErrorMessage } from "../utils/format";

type RouteBuilderTab = "driver-options" | "stop-order";
type RouteEndMode = RoutePlanDetailDto["routePlan"]["routeEndMode"];
type SaveRouteInput = Parameters<typeof saveRoute>[0];

export function getDriverOptionLabel(
  driver: DriverDto,
  locale: string | null | undefined = "en-CA",
): string {
  const t = getRoutesCopy(locale);
  const appAccess =
    driver.appLinked || driver.authStatus === "APP_LINKED"
      ? t.appLinked
      : t.invitePending;
  return `${driver.displayName} · ${appAccess}`;
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

export function getRoutePublishNotice(
  routePlan: Pick<
    RoutePlanSummaryDto,
    "driverId" | "status" | "stopsCount"
  > | null,
  drivers: DriverDto[],
  locale: string | null | undefined = "en-CA",
): { tone: "green" | "orange" | "neutral"; text: string } | null {
  const t = getRoutesCopy(locale);
  if (routePlan === null) return null;
  const driver =
    routePlan.driverId === null
      ? null
      : (drivers.find((item) => item.id === routePlan.driverId) ?? null);
  const isPublished = ["ASSIGNED", "IN_PROGRESS", "OPTIMIZED"].includes(
    routePlan.status,
  );
  if (routePlan.status === "DRAFT") {
    if (routePlan.driverId === null)
      return { tone: "orange", text: t.publishNotice.draftAssignDriver };
    if (routePlan.stopsCount === 0)
      return { tone: "orange", text: t.publishNotice.draftAddStops };
    return { tone: "orange", text: t.publishNotice.draftNotVisible };
  }
  if (
    isPublished &&
    driver !== null &&
    (driver.appLinked || driver.authStatus === "APP_LINKED")
  ) {
    return { tone: "green", text: t.publishNotice.publishedLinked };
  }
  if (isPublished && routePlan.driverId !== null) {
    return { tone: "neutral", text: t.publishNotice.publishedPending };
  }
  return null;
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
  const [detail, setDetail] = useState<RoutePlanDetailDto | null>(null);
  const [drivers, setDrivers] = useState<DriverDto[]>([]);
  const [deletingRouteId, setDeletingRouteId] = useState<string | null>(null);

  const refreshRoutes = useCallback(async (): Promise<void> => {
    try {
      const payload = await getRoutes("");
      setRoutes(payload.routePlans);
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
    if (routePlanId === null) {
      setDetail(null);
      return;
    }
    getRouteDetail(routePlanId)
      .then((payload) => {
        setDetail(payload);
        setError(null);
      })
      .catch((error: unknown) => setError(readErrorMessage(error)));
  }, [routePlanId, setError]);

  if (routePlanId !== null) {
    return (
      <RouteBuilder
        bootstrap={bootstrap}
        deletingRouteId={deletingRouteId}
        detail={detail}
        drivers={drivers}
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
        <Kpi label={t.routes} value={routes.length} />
        <Kpi
          label={t.stops}
          value={routes.reduce((sum, item) => sum + item.stopsCount, 0)}
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
        <table className="ops-table">
          <thead>
            <tr>
              <th>{t.table.name}</th>
              <th>{t.table.status}</th>
              <th>{t.table.stops}</th>
              <th>{t.table.date}</th>
              <th>{t.table.driver}</th>
              <th />
            </tr>
          </thead>
          <tbody>
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
                      onClick={() => void deleteRoutePlan(item.id)}
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
      </article>
    </section>
  );
}

export function RouteBuilder(input: {
  bootstrap: BootstrapPayload;
  deletingRouteId: string | null;
  detail: RoutePlanDetailDto | null;
  drivers: DriverDto[];
  initialBuilderTab?: RouteBuilderTab;
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
  const [activeBuilderTab, setActiveBuilderTab] = useState<RouteBuilderTab>(
    () => input.initialBuilderTab ?? "driver-options",
  );
  const [draggingStopId, setDraggingStopId] = useState<string | null>(null);
  const [isSavingRoute, setIsSavingRoute] = useState(false);
  const detail = input.detail;
  const locale = resolveLocale(input.locale);
  const t = getRoutesCopy(locale);

  useEffect(() => setDraftStops(detail?.stops ?? []), [detail]);
  useEffect(
    () => setDraftDriverId(detail?.routePlan.driverId ?? ""),
    [detail?.routePlan.driverId],
  );
  useEffect(
    () => setDraftRouteEndMode(detail?.routePlan.routeEndMode ?? "END_AT_LAST_STOP"),
    [detail?.routePlan.id, detail?.routePlan.routeEndMode],
  );

  const stats = deriveRouteStats(detail);
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
  const publishNotice = getRoutePublishNotice(
    effectiveRoutePlan,
    input.drivers,
    locale,
  );
  const canPublishOnSave =
    effectiveRoutePlan !== null &&
    effectiveRoutePlan.status === "DRAFT" &&
    effectiveRoutePlan.driverId !== null &&
    effectiveRoutePlan.stopsCount > 0;
  const canSaveRoute =
    detail !== null &&
    !isSavingRoute &&
    !isUnsafeRouteEndDraft &&
    (hasSequenceChanges || hasDriverChanges || hasRouteEndChanges || canPublishOnSave);
  const routeVisibilityLabel =
    detail === null
      ? t.loadRouteBeforePublishing
      : isRouteVisibleToLinkedDriver(detail.routePlan, input.drivers)
        ? t.driverAppVisible
        : t.notVisibleToDriverApp;

  const save = async (): Promise<void> => {
    if (detail === null || !canSaveRoute) return;
    setIsSavingRoute(true);
    try {
      const updated = await saveRoute(buildRouteSaveDraftInput({
        csrfToken: input.bootstrap.csrfToken,
        detail,
        driverId: effectiveDriverId,
        draftStops,
        routeEndMode: draftRouteEndMode,
      }));
      input.setDetail(updated);
      input.onRefreshRoutes();
      input.setError(null);
    } catch (error) {
      input.setError(readErrorMessage(error));
    } finally {
      setIsSavingRoute(false);
    }
  };

  const moveDraftStop = (deliveryStopId: string, direction: -1 | 1): void => {
    setDraftStops((current) => moveStop(current, deliveryStopId, direction));
  };

  const dropDraftStop = (targetStopId: string): void => {
    if (draggingStopId !== null) {
      setDraftStops((current) =>
        moveStopBefore(current, draggingStopId, targetStopId),
      );
    }
    setDraggingStopId(null);
  };

  const saveHint =
    detail === null
      ? t.loadingRoute
      : isUnsafeRouteEndDraft
        ? t.returnToStoreDepotMissing
      : hasSequenceChanges || hasDriverChanges || hasRouteEndChanges
        ? t.routeSavePendingChanges
        : canPublishOnSave
          ? t.routeSavePublishesRoute
          : t.noRouteChanges;
  const returnToDepotChecked = draftRouteEndMode === "RETURN_TO_DEPOT";
  const returnToDepotDisabled =
    detail === null || (!returnToDepotChecked && !canReturnToDepot);
  const routeEndWarningId = "route-end-depot-warning";
  const driverTabId = "route-builder-tab-driver-options";
  const stopOrderTabId = "route-builder-tab-stop-order";
  const driverPanelId = "route-builder-panel-driver-options";
  const stopOrderPanelId = "route-builder-panel-stop-order";
  const focusBuilderTab = (tab: RouteBuilderTab): void => {
    setActiveBuilderTab(tab);
    if (typeof window === "undefined") return;
    window.requestAnimationFrame(() => {
      document.getElementById(tab === "driver-options" ? driverTabId : stopOrderTabId)?.focus();
    });
  };
  const handleBuilderTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const nextTab: RouteBuilderTab | null =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? activeBuilderTab === "driver-options"
          ? "stop-order"
          : "driver-options"
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? activeBuilderTab === "driver-options"
            ? "stop-order"
            : "driver-options"
          : event.key === "Home"
            ? "driver-options"
            : event.key === "End"
              ? "stop-order"
              : null;
    if (nextTab === null) return;
    event.preventDefault();
    focusBuilderTab(nextTab);
  };
  const renderSaveControls = (): ReactElement => (
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
      <small className="muted">{saveHint}</small>
      <small className="muted">{t.routeSaveFullDraft}</small>
      <small className="muted">{routeVisibilityLabel}</small>
    </div>
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
            subtitle={geometryLabel(
              detail,
              input.bootstrap.routerConfig.status,
              locale,
            )}
            title={detail?.routePlan.name ?? t.routeBuilder}
          />
        </div>
      }
      secondary={
        <aside className="panel side-panel route-save-panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">{t.routeState}</span>
              <h2>{detail?.routePlan.name ?? t.loadingRoute}</h2>
            </div>
            <div className="route-row-actions">
              <button
                onClick={() => input.navigate("/admin/ui/app/routes")}
                type="button"
              >
                {t.allRoutes}
              </button>
              <button
                className="danger subtle"
                disabled={
                  detail === null ||
                  input.deletingRouteId === detail.routePlan.id
                }
                onClick={() => {
                  if (detail !== null) input.onDeleteRoute(detail.routePlan.id);
                }}
                type="button"
              >
                {detail !== null &&
                input.deletingRouteId === detail.routePlan.id
                  ? t.deleting
                  : t.delete}
              </button>
            </div>
          </div>
          <div aria-label={t.routeBuilderTabs.label} className="route-tabs route-builder-tabs" role="tablist">
            <button
              aria-controls={driverPanelId}
              aria-selected={activeBuilderTab === "driver-options"}
              className={activeBuilderTab === "driver-options" ? "active" : ""}
              id={driverTabId}
              onKeyDown={handleBuilderTabKeyDown}
              onClick={() => setActiveBuilderTab("driver-options")}
              role="tab"
              type="button"
            >
              {t.routeBuilderTabs.driverOptions}
            </button>
            <button
              aria-controls={stopOrderPanelId}
              aria-selected={activeBuilderTab === "stop-order"}
              className={activeBuilderTab === "stop-order" ? "active" : ""}
              id={stopOrderTabId}
              onKeyDown={handleBuilderTabKeyDown}
              onClick={() => setActiveBuilderTab("stop-order")}
              role="tab"
              type="button"
            >
              {t.routeBuilderTabs.stopOrder}
            </button>
          </div>
          {activeBuilderTab === "driver-options" ? (
            <div aria-labelledby={driverTabId} className="route-builder-tab-panel" id={driverPanelId} role="tabpanel">
              {publishNotice === null ? null : (
                <div className={`route-publish-notice ${publishNotice.tone}`}>
                  {publishNotice.text}
                </div>
              )}
              <dl className="route-state-list">
                <div>
                  <dt>{t.table.status}</dt>
                  <dd>
                    {detail === null
                      ? "—"
                      : formatRoutePlanStatus(detail.routePlan.status, locale)}
                  </dd>
                </div>
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
                    {getRouteDriverDisplay(
                      effectiveRoutePlan,
                      input.drivers,
                      locale,
                    )}
                  </dd>
                </div>
              </dl>
              <label>
                {t.assignedDriver}
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
                <small>
                  {returnToDepotChecked
                    ? t.returnToStoreHelp
                    : t.endAtLastStopHelp}
                </small>
              </label>
              {!canReturnToDepot ? (
                <small className="form-warning" id={routeEndWarningId}>
                  {t.returnToStoreDepotMissing}
                </small>
              ) : null}
              {renderSaveControls()}
            </div>
          ) : (
            <div aria-labelledby={stopOrderTabId} className="route-builder-tab-panel" id={stopOrderPanelId} role="tabpanel">
              <div className="route-stop-compact-heading">
                <div>
                  <span className="eyebrow">{t.routeStops}</span>
                  <h3>{t.stopTableTitle}</h3>
                  <p>{t.stopTableHelp}</p>
                </div>
                <Badge>
                  {draftStops.length} {t.stops}
                </Badge>
              </div>
              <RouteStopOrderCompactList
                draggingStopId={draggingStopId}
                locale={locale}
                onDragEnd={() => setDraggingStopId(null)}
                onDragStart={setDraggingStopId}
                onDrop={dropDraftStop}
                onMove={moveDraftStop}
                stops={draftStops}
              />
              {renderSaveControls()}
            </div>
          )}
        </aside>
      }
      lower={
        <div className="summary-strip compact-kpis">
          <Kpi label={t.stops} value={stats.stops} />
          <Kpi label={t.completed} value={stats.completed} />
          <Kpi label={t.attempted} value={stats.attempted} />
          <Kpi label={t.missingCoords} value={stats.missingCoordinates} />
        </div>
      }
    />
  );
}

export function RouteStopOrderCompactList({
  draggingStopId,
  locale,
  onDragEnd,
  onDragStart,
  onDrop,
  onMove,
  stops,
}: {
  draggingStopId: string | null;
  locale?: string | null;
  onDragEnd(): void;
  onDragStart(deliveryStopId: string): void;
  onDrop(targetStopId: string): void;
  onMove(deliveryStopId: string, direction: -1 | 1): void;
  stops: RouteStopDto[];
}): ReactElement {
  const t = getRoutesCopy(locale);
  return (
    <div aria-label={t.stopTableTitle} className="route-stop-compact-list" role="list">
      {stops.map((stop, index) => (
        <div
          className={[
            "route-stop-compact-row",
            draggingStopId === stop.deliveryStopId ? "dragging" : "",
          ].filter(Boolean).join(" ")}
          draggable
          key={stop.deliveryStopId}
          onDragEnd={onDragEnd}
          onDragOver={(event) => event.preventDefault()}
          onDragStart={() => onDragStart(stop.deliveryStopId)}
          onDrop={(event) => {
            event.preventDefault();
            onDrop(stop.deliveryStopId);
          }}
          role="listitem"
        >
          <span
            aria-label={t.dragPlanOrder(stop.orderName)}
            className="drag-handle"
            role="img"
          >
            ::
          </span>
          <span className="stop-number compact">{index + 1}</span>
          <div className="route-stop-compact-main">
            <strong>{stop.orderName}</strong>
            <small>
              {stop.recipientName ?? t.noRecipient} · {stop.addressLabel}
            </small>
            <small className="route-stop-compact-meta">
              {stop.deliveryArea ?? "—"} · <Badge>{stop.status}</Badge>
            </small>
          </div>
          <div className="stop-actions route-stop-compact-actions">
            <button
              aria-label={t.moveUp(stop.orderName)}
              disabled={index === 0}
              onClick={() => onMove(stop.deliveryStopId, -1)}
              type="button"
            >
              ↑
            </button>
            <button
              aria-label={t.moveDown(stop.orderName)}
              disabled={index === stops.length - 1}
              onClick={() => onMove(stop.deliveryStopId, 1)}
              type="button"
            >
              ↓
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
