import { Fragment, useCallback, useEffect, useState } from "react";
import type { DragEvent, KeyboardEvent, ReactElement } from "react";

import {
  createRouteOptimizationJob,
  deleteRoute,
  getDrivers,
  getLatestRouteOptimizationJob,
  getRouteDetail,
  getRouteOptimizationJob,
  getRoutes,
  saveRoute,
} from "../api";
import { Badge, Kpi } from "../components/primitives";
import { TabLayout } from "../components/TabLayout";
import { RouteOpsMap } from "../components/maps/RouteOpsMap";
import { getRoutesCopy, resolveLocale } from "../i18n";
import { formatOrderItemLine, formatOrderItemOptions, getOrderItems, getRouteItemSummary } from "../orderItems";
import {
  deriveRouteStats,
  geometryLabel,
  hasStopSequenceChanged,
  moveStop,
  moveStopToDropPosition,
  moveStopToSequence,
} from "../state";
import type { StopDropPosition } from "../state";
import type {
  BootstrapPayload,
  DriverDto,
  RouteOptimizationJobDto,
  RouteGroupingSummaryDto,
  RoutePlanDetailDto,
  RoutePlanSummaryDto,
  RouteStopDto,
} from "../types";
import { readErrorMessage } from "../utils/format";

type RouteBuilderTab = "driver-options" | "stop-order";
type RouteEndMode = RoutePlanDetailDto["routePlan"]["routeEndMode"];
type SaveRouteInput = Parameters<typeof saveRoute>[0];
const ROUTE_OPTIMIZATION_POLL_MS = 2500;
const ROUTE_OPTIMIZATION_ELAPSED_TICK_MS = 1000;
type StopDropPreview = {
  position: StopDropPosition;
  targetStopId: string;
};

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

export function getRoutePublishBadge(
  routePlan: Pick<
    RoutePlanSummaryDto,
    "status"
  > | null,
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

export function isRouteOptimizationJobActive(
  job: RouteOptimizationJobDto | null,
): boolean {
  return job?.status === "QUEUED" || job?.status === "RUNNING";
}

export function getRouteOptimizationActionLabel(input: {
  copy: ReturnType<typeof getRoutesCopy>["routeOptimization"];
  hasUnsavedRouteChanges: boolean;
  isStartingOptimizationJob: boolean;
  optimizationJob: RouteOptimizationJobDto | null;
}): string {
  if (input.isStartingOptimizationJob) return input.copy.starting;
  if (input.hasUnsavedRouteChanges) return input.copy.saveAndRerun;
  return input.optimizationJob === null ? input.copy.start : input.copy.rerun;
}

export function getRouteOptimizationJobNotice(
  job: RouteOptimizationJobDto | null,
): { tone: "green" | "orange" | "neutral" } | null {
  if (job === null) return null;
  if (job.status === "QUEUED" || job.status === "RUNNING") return { tone: "neutral" };
  if (job.status === "APPLIED") return { tone: "green" };
  return { tone: "orange" };
}

type RouteOptimizationDetailRow = {
  label: string;
  monospace?: boolean;
  value: string;
};

export function getRouteOptimizationJobDetailRows(
  job: RouteOptimizationJobDto | null,
  locale: string | null | undefined = "en-CA",
  nowMs: number | null = null,
): RouteOptimizationDetailRow[] {
  if (job === null) return [];
  const copy = getRoutesCopy(locale).routeOptimization;
  const rows: RouteOptimizationDetailRow[] = [
    { label: copy.details.status, value: copy.statuses[job.status] },
    { label: copy.details.step, value: copy.steps[job.currentStep] },
    { label: copy.details.elapsed, value: formatRouteOptimizationDuration(getRouteOptimizationElapsedMs(job, nowMs), copy.details.notAvailable) },
    { label: copy.details.timeoutBudget, value: formatRouteOptimizationDuration(job.timeoutBudgetMs, copy.details.notAvailable) },
  ];
  if (job.errorCode !== null) rows.push({ label: copy.details.errorCode, monospace: true, value: job.errorCode });
  if (job.invalidatedReason !== null) rows.push({ label: copy.details.invalidatedReason, value: job.invalidatedReason });
  if (job.appliedAt !== null) rows.push({ label: copy.details.appliedAt, value: formatRouteOptimizationTimestamp(job.appliedAt, copy.details.notAvailable) });
  if (job.finishedAt !== null) rows.push({ label: copy.details.finishedAt, value: formatRouteOptimizationTimestamp(job.finishedAt, copy.details.notAvailable) });
  return rows;
}

function getRouteOptimizationElapsedMs(job: RouteOptimizationJobDto, nowMs: number | null = null): number | null {
  if (nowMs !== null && isRouteOptimizationJobActive(job)) {
    const startedAt = Date.parse(job.startedAt ?? job.createdAt);
    if (!Number.isNaN(startedAt)) {
      return Math.max(job.elapsedMs ?? 0, nowMs - startedAt);
    }
  }
  if (job.elapsedMs !== null) return job.elapsedMs;
  if (!isRouteOptimizationJobActive(job)) return null;
  const startedAt = Date.parse(job.startedAt ?? job.createdAt);
  if (Number.isNaN(startedAt)) return null;
  return Math.max(0, Date.now() - startedAt);
}

function formatRouteOptimizationDuration(valueMs: number | null, fallback: string): string {
  if (valueMs === null) return fallback;
  if (valueMs < 1000) return `${valueMs}ms`;
  const totalSeconds = Math.round(valueMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

function formatRouteOptimizationTimestamp(value: string, fallback: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return date.toLocaleString();
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
        <Kpi label={t.routes} value={routes.length + routeGroups.length} />
        <Kpi
          label={t.stops}
          value={routes.reduce((sum, item) => sum + item.stopsCount, 0) + routeGroups.reduce((sum, group) => sum + group.totalOrders, 0)}
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
            {routeGroups.map((group) => (
              <Fragment key={group.id}>
                <tr key={group.id} className="route-group-row">
                  <td>
                    <strong>{group.name}</strong>
                    <div className="muted">Driver split · v{group.currentVersion}</div>
                  </td>
                  <td><Badge>{group.displayStatus}</Badge></td>
                  <td>{group.totalOrders}</td>
                  <td>{group.planDate}</td>
                  <td>{group.unresolvedOrders === 0 ? "Resolved" : `${group.unresolvedOrders} unresolved`}</td>
                  <td>
                    <button onClick={() => navigate(`/admin/ui/app/route-groups/${encodeURIComponent(group.id)}`)} type="button">Open</button>
                  </td>
                </tr>
                {group.children.map((child) => (
                  <tr key={`${group.id}:${child.routePlanId ?? child.driverId}:${child.childVersion}`} className="route-group-child-row">
                    <td>↳ {child.driverName ?? "Unassigned driver"}</td>
                    <td><Badge>{child.displayStatus}</Badge></td>
                    <td>{child.stopsCount}</td>
                    <td>{group.planDate}</td>
                    <td>{child.notificationStatus}</td>
                    <td>
                      {child.routePlanId === null ? null : (
                        <button onClick={() => navigate(`/admin/ui/app/routes/${encodeURIComponent(child.routePlanId ?? "")}`)} type="button">{t.open}</button>
                      )}
                    </td>
                  </tr>
                ))}
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
  initialOptimizationJob?: RouteOptimizationJobDto | null;
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
  const [selectedRouteStopId, setSelectedRouteStopId] = useState<string | null>(null);
  const [draggingStopId, setDraggingStopId] = useState<string | null>(null);
  const [dropPreview, setDropPreview] = useState<StopDropPreview | null>(null);
  const [isSavingRoute, setIsSavingRoute] = useState(false);
  const [isStartingOptimizationJob, setIsStartingOptimizationJob] = useState(false);
  const [optimizationJob, setOptimizationJob] = useState<RouteOptimizationJobDto | null>(
    () => input.initialOptimizationJob ?? null,
  );
  const [optimizationElapsedNowMs, setOptimizationElapsedNowMs] = useState<number | null>(null);
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
    () => setDraftRouteEndMode(detail?.routePlan.routeEndMode ?? "END_AT_LAST_STOP"),
    [detail?.routePlan.id, detail?.routePlan.routeEndMode],
  );

  useEffect(() => {
    if (detail === null) {
      setOptimizationJob(null);
      return;
    }
    let cancelled = false;
    getLatestRouteOptimizationJob(detail.routePlan.id)
      .then((payload) => {
        if (!cancelled) setOptimizationJob(payload.job);
      })
      .catch((error: unknown) => {
        if (!cancelled) input.setError(readErrorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [detail?.routePlan.id, input.setError]);

  useEffect(() => {
    if (!isRouteOptimizationJobActive(optimizationJob)) {
      setOptimizationElapsedNowMs(null);
      return;
    }
    setOptimizationElapsedNowMs(Date.now());
    const interval = window.setInterval(() => {
      setOptimizationElapsedNowMs(Date.now());
    }, ROUTE_OPTIMIZATION_ELAPSED_TICK_MS);
    return () => {
      window.clearInterval(interval);
    };
  }, [optimizationJob]);

  useEffect(() => {
    if (detail === null || !isRouteOptimizationJobActive(optimizationJob)) return;
    let cancelled = false;
    const poll = async (): Promise<void> => {
      if (optimizationJob === null) return;
      try {
        const payload = await getRouteOptimizationJob(detail.routePlan.id, optimizationJob.id);
        if (cancelled) return;
        setOptimizationJob(payload.job);
        if (payload.job?.status === "APPLIED") {
          const updated = await getRouteDetail(detail.routePlan.id);
          if (!cancelled) {
            input.setDetail(updated);
            input.onRefreshRoutes();
          }
        }
      } catch (error) {
        if (!cancelled) input.setError(readErrorMessage(error));
      }
    };
    const interval = window.setInterval(() => {
      void poll();
    }, ROUTE_OPTIMIZATION_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [detail, input.onRefreshRoutes, input.setDetail, input.setError, optimizationJob]);

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
  const publishBadge = getRoutePublishBadge(
    effectiveRoutePlan,
    locale,
  );
  const canPublishOnSave =
    effectiveRoutePlan !== null &&
    effectiveRoutePlan.status === "DRAFT" &&
    effectiveRoutePlan.driverId !== null &&
    effectiveRoutePlan.stopsCount > 0;
  const hasActiveOptimizationJob = isRouteOptimizationJobActive(optimizationJob);
  const optimizationNotice = getRouteOptimizationJobNotice(optimizationJob);
  const hasUnsavedRouteChanges = hasSequenceChanges || hasDriverChanges || hasRouteEndChanges;
  const canSaveBeforeOptimization =
    detail !== null &&
    !isSavingRoute &&
    !isStartingOptimizationJob &&
    !hasActiveOptimizationJob &&
    !isUnsafeRouteEndDraft &&
    hasUnsavedRouteChanges;
  const canStartOptimizationJob =
    detail !== null &&
    !isStartingOptimizationJob &&
    !isSavingRoute &&
    !hasActiveOptimizationJob &&
    !isUnsafeRouteEndDraft &&
    (!hasUnsavedRouteChanges || canSaveBeforeOptimization);
  const canSaveRoute =
    detail !== null &&
    !isSavingRoute &&
    !hasActiveOptimizationJob &&
    !isUnsafeRouteEndDraft &&
    (hasSequenceChanges || hasDriverChanges || hasRouteEndChanges || canPublishOnSave);
  const saveRouteDraft = async (): Promise<RoutePlanDetailDto> => {
    if (detail === null) {
      throw new Error("Route detail is not loaded.");
    }
    const updated = await saveRoute(buildRouteSaveDraftInput({
      csrfToken: input.bootstrap.csrfToken,
      detail,
      driverId: effectiveDriverId,
      draftStops,
      routeEndMode: draftRouteEndMode,
    }));
    input.setDetail(updated);
    input.onRefreshRoutes();
    return updated;
  };

  const startOptimizationJob = async (): Promise<void> => {
    if (detail === null || !canStartOptimizationJob) return;
    setIsStartingOptimizationJob(true);
    if (hasUnsavedRouteChanges) setIsSavingRoute(true);
    try {
      const routeDetailForJob = hasUnsavedRouteChanges ? await saveRouteDraft() : detail;
      const payload = await createRouteOptimizationJob(
        routeDetailForJob.routePlan.id,
        input.bootstrap.csrfToken,
      );
      setOptimizationJob(payload.job);
      input.setError(null);
    } catch (error) {
      input.setError(readErrorMessage(error));
    } finally {
      setIsSavingRoute(false);
      setIsStartingOptimizationJob(false);
    }
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

  const moveDraftStop = (deliveryStopId: string, direction: -1 | 1): void => {
    if (hasActiveOptimizationJob) return;
    setDraftStops((current) => moveStop(current, deliveryStopId, direction));
    setSelectedRouteStopId(null);
  };

  const clearStopDragPreview = (): void => {
    setDraggingStopId(null);
    setDropPreview(null);
  };

  const dropDraftStop = (targetStopId: string, position: StopDropPosition): void => {
    if (hasActiveOptimizationJob) return;
    if (draggingStopId !== null) {
      setDraftStops((current) =>
        moveStopToDropPosition(current, draggingStopId, targetStopId, position),
      );
    }
    setSelectedRouteStopId(null);
    clearStopDragPreview();
  };

  const moveDraftStopToSequence = (deliveryStopId: string, sequence: number): void => {
    if (hasActiveOptimizationJob) return;
    setDraftStops((current) => moveStopToSequence(current, deliveryStopId, sequence));
    setSelectedRouteStopId(null);
    clearStopDragPreview();
  };

  const returnToDepotChecked = draftRouteEndMode === "RETURN_TO_DEPOT";
  const returnToDepotDisabled =
    detail === null || hasActiveOptimizationJob || (!returnToDepotChecked && !canReturnToDepot);
  const routeEndWarningId = "route-end-depot-warning";
  const driverTabId = "route-builder-tab-driver-options";
  const stopOrderTabId = "route-builder-tab-stop-order";
  const driverPanelId = "route-builder-panel-driver-options";
  const stopOrderPanelId = "route-builder-panel-stop-order";
  const selectBuilderTab = (tab: RouteBuilderTab): void => {
    setActiveBuilderTab(tab);
    setSelectedRouteStopId(null);
  };
  const focusBuilderTab = (tab: RouteBuilderTab): void => {
    selectBuilderTab(tab);
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
    </div>
  );
  const routeOptimizationAction = (
    <button
      className="primary route-optimize-button"
      disabled={!canStartOptimizationJob}
      onClick={() => void startOptimizationJob()}
      type="button"
    >
      {getRouteOptimizationActionLabel({
        copy: t.routeOptimization,
        hasUnsavedRouteChanges,
        isStartingOptimizationJob,
        optimizationJob,
      })}
    </button>
  );
  const routeMapHeaderAction = (
    <div className="route-map-header-actions">
      {publishBadge === null ? null : (
        <span className={`route-publish-badge ${publishBadge.tone}`}>
          {publishBadge.text}
        </span>
      )}
      {routeOptimizationAction}
    </div>
  );
  const routeOptimizationRows = getRouteOptimizationJobDetailRows(optimizationJob, locale, optimizationElapsedNowMs);
  const routeOptimizationSummaryRows = routeOptimizationRows.slice(0, 3);
  const routeOptimizationStatus = optimizationNotice === null ? undefined : (
    <details className={`route-optimization-notice route-optimization-notice--map route-optimization-disclosure ${optimizationNotice.tone}`}>
      <summary className="route-optimization-disclosure-summary">
        <strong>{t.routeOptimization.title}</strong>
        <span className="route-optimization-summary-line">
          {routeOptimizationSummaryRows.map((row) => (
            <span className="route-optimization-summary-chip" key={row.label}>
              <span>{row.label}</span>
              <b className={row.monospace === true ? "monospace" : undefined}>{row.value}</b>
            </span>
          ))}
        </span>
      </summary>
      <dl className="route-optimization-details" aria-label={t.routeOptimization.details.title}>
        {routeOptimizationRows.map((row) => (
          <div key={row.label}>
            <dt>{row.label}</dt>
            <dd className={row.monospace === true ? "monospace" : undefined}>{row.value}</dd>
          </div>
        ))}
      </dl>
      {hasActiveOptimizationJob ? <small>{t.routeOptimization.editingLocked}</small> : null}
    </details>
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
            statusContent={routeOptimizationStatus}
            onRouteStopPickerClose={() => setSelectedRouteStopId(null)}
            onRouteStopSelect={(deliveryStopId) => setSelectedRouteStopId(deliveryStopId)}
            onRouteStopSequencePick={moveDraftStopToSequence}
            selectedRouteStopId={selectedRouteStopId}
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
        <aside className="panel side-panel route-save-panel route-builder-card-shell">
          <div className="route-builder-card-header">
            <span className="eyebrow">{t.routeState}</span>
            <div className="route-row-actions route-builder-card-actions">
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
          <div aria-label={t.routeBuilderTabs.label} className="route-tabs route-builder-tabs route-builder-card-tabs" role="tablist">
            <button
              aria-controls={driverPanelId}
              aria-selected={activeBuilderTab === "driver-options"}
              className={activeBuilderTab === "driver-options" ? "active" : ""}
              id={driverTabId}
              onKeyDown={handleBuilderTabKeyDown}
              onClick={() => selectBuilderTab("driver-options")}
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
              onClick={() => selectBuilderTab("stop-order")}
              role="tab"
              type="button"
            >
              {t.routeBuilderTabs.stopOrder}
            </button>
          </div>
          {activeBuilderTab === "driver-options" ? (
            <div aria-labelledby={driverTabId} className="route-builder-tab-panel" id={driverPanelId} role="tabpanel">
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
                      {getRouteDriverDisplay(
                        effectiveRoutePlan,
                        input.drivers,
                        locale,
                      )}
                    </dd>
                  </div>
                </dl>
                <label>
                  {t.table.driver}
                  <select
                    disabled={hasActiveOptimizationJob}
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
            </div>
          ) : (
            <div aria-labelledby={stopOrderTabId} className="route-builder-tab-panel" id={stopOrderPanelId} role="tabpanel">
              <div className="route-builder-tab-body route-builder-tab-body--stop-order">
                <div className="route-stop-compact-toolbar">
                  <span className="badge route-stop-count-badge">
                    {draftStops.length} {t.stops.toLocaleLowerCase(locale)}
                  </span>
                </div>
                <RouteStopOrderCompactList
                  disabled={hasActiveOptimizationJob}
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
            </div>
          )}
          <div className="route-builder-card-footer">
            {renderSaveControls()}
          </div>
        </aside>
      }
      lower={
        <div className="route-summary-lower">
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
              {itemSummary.changedSincePublish ? <Badge>{t.itemsChanged}</Badge> : null}
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
                      <th>{t.sku}</th>
                      <th>{t.quantity}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {routeItems.map((item) => (
                      <tr key={`${item.productId}:${item.variationId}:${item.name}`}>
                        <td>{item.name}</td>
                        <td>{formatOrderItemOptions(item) || "—"}</td>
                        <td>{item.sku ?? "—"}</td>
                        <td>{item.quantity}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <section className="route-item-summary-card" aria-label="Stop notes and items">
            <div className="route-item-summary-heading">
              <h3>Stop notes and items</h3>
            </div>
            <div className="route-item-table-scroll">
              <table className="route-item-table">
                <thead>
                  <tr><th>#</th><th>Order</th><th>Customer note</th><th>Admin memo</th><th>Items</th></tr>
                </thead>
                <tbody>
                  {draftStops.map((stop) => (
                    <tr key={`${stop.deliveryStopId}:notes`}>
                      <td>{stop.sequence}</td>
                      <td>{stop.orderName}</td>
                      <td>{stop.customerNoteContext?.customerNote ?? "—"}</td>
                      <td>{stop.customerNoteContext?.adminMemo ?? "—"}</td>
                      <td>{getOrderItems(stop.items).map((item) => formatOrderItemLine(item)).join(" / ") || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      }
    />
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
  stops: RouteStopDto[];
}): ReactElement {
  const t = getRoutesCopy(locale);

  const scrollDragEdge = (event: DragEvent<HTMLElement>): void => {
    const list = event.currentTarget.closest<HTMLElement>(".route-stop-compact-list");
    if (list === null) return;
    const rect = list.getBoundingClientRect();
    const edge = Math.min(92, Math.max(44, rect.height / 5));
    const topDistance = event.clientY - rect.top;
    const bottomDistance = rect.bottom - event.clientY;
    const topStrength = topDistance < edge ? (edge - topDistance) / edge : 0;
    const bottomStrength = bottomDistance < edge ? (edge - bottomDistance) / edge : 0;
    const delta = bottomStrength > 0
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

  const previewFor = (event: DragEvent<HTMLElement>, targetStopId: string): StopDropPreview | null => {
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
      ].filter(Boolean).join(" ")}
      onDragOver={(event) => {
        event.preventDefault();
        scrollDragEdge(event);
      }}
      role="list"
    >
      {stops.map((stop, index) => {
        const isDropTarget = dropPreview?.targetStopId === stop.deliveryStopId;
        const dropPosition = isDropTarget ? dropPreview.position : null;
        const stopItems = getOrderItems(stop.items);
        return (
        <div
          className={[
            "route-stop-compact-row",
            draggingStopId === stop.deliveryStopId ? "dragging" : "",
            isDropTarget ? "drop-target" : "",
            dropPosition === "before" ? "drop-before" : "",
            dropPosition === "after" ? "drop-after" : "",
          ].filter(Boolean).join(" ")}
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
            const position = dropPreview?.targetStopId === stop.deliveryStopId
              ? dropPreview.position
              : getDropPosition(event);
            onDrop(stop.deliveryStopId, position);
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
            {stopItems.length === 0 ? null : (
              <ul className="route-stop-item-lines" aria-label={t.stopItems}>
                {stopItems.map((item, itemIndex) => (
                  <li key={`${item.productId}:${item.variationId}:${item.name}:${itemIndex}`}>
                    {formatOrderItemLine(item)}
                  </li>
                ))}
              </ul>
            )}
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
