import type {
  AdminNotificationDto,
  AppLocale,
  RuntimeHealthDto,
  OperationalHealthState,
  OperationalRuntimeComponentDto,
  OperationalRuntimeHealthDto,
  RouteOperationalAlertDto,
  RouteOperationalStateDto,
} from "./types";

export type OperationalPillTone =
  | "critical"
  | "info"
  | "neutral"
  | "success"
  | "warning";

export type OperationalPillModel = {
  ariaLabel: string;
  key: string;
  label: string;
  tone: OperationalPillTone;
};

const runtimeLabels = {
  "en-CA": {
    alertStream: "Alert stream",
    emailOutbox: "Email outbox",
    emailSender: "Email sender",
    externalLogSink: "External logs",
    syncDetector: "Sync detector",
    trackingStream: "Tracking stream",
    webhookConsumer: "Webhook consumer",
    webhookIngest: "Webhook ingest",
  },
  "ko-KR": {
    alertStream: "알림 스트림",
    emailOutbox: "이메일 보관함",
    emailSender: "이메일 발송",
    externalLogSink: "외부 로그",
    syncDetector: "동기화 감지",
    trackingStream: "추적 스트림",
    webhookConsumer: "웹훅 처리",
    webhookIngest: "웹훅 수신",
  },
} as const;

const stateLabels = {
  "en-CA": {
    DEGRADED: "degraded",
    DISABLED: "disabled",
    HEALTHY: "healthy",
    UNKNOWN: "unknown",
  },
  "ko-KR": {
    DEGRADED: "저하",
    DISABLED: "비활성",
    HEALTHY: "정상",
    UNKNOWN: "알 수 없음",
  },
} as const;

export function runtimeHealthPills(
  health: RuntimeHealthDto | null | undefined,
  locale: AppLocale,
): OperationalPillModel[] {
  const keys = [
    "webhookIngest",
    "webhookConsumer",
    "emailSender",
    "emailOutbox",
    "syncDetector",
    "trackingStream",
    "alertStream",
    "externalLogSink",
  ] as const;
  return keys.map((key) => {
    const component = runtimeComponent(health, key);
    const state = normalizeHealthState(component?.state);
    const detail = runtimeHealthDetail(component, locale);
    const label = `${runtimeLabels[locale][key]} ${stateLabels[locale][state]}`;
    return {
      ariaLabel: detail === null ? label : `${label}. ${detail}`,
      key,
      label,
      tone: toneForHealthState(state),
    };
  });
}

export function routeOperationalPills(
  state: RouteOperationalStateDto | null | undefined,
  fallbackTotalStops: number,
  locale: AppLocale,
): OperationalPillModel[] {
  const unknown = locale === "ko-KR" ? "알 수 없음" : "unknown";
  const pills: OperationalPillModel[] = [];
  const activeAlert = highestActiveAlert(state?.activeAlerts);
  if (activeAlert !== null) {
    const critical = activeAlert.severity.toUpperCase() === "CRITICAL";
    const label = critical
      ? locale === "ko-KR" ? "알림 긴급" : "Alert critical"
      : locale === "ko-KR" ? "알림 경고" : "Alert warning";
    pills.push({ ariaLabel: `${label}. ${activeAlert.type}`, key: "alert", label, tone: critical ? "critical" : "warning" });
  } else if (state?.activeAlerts === undefined) {
    const label = locale === "ko-KR" ? "알림 알 수 없음" : "Alert unknown";
    pills.push({ ariaLabel: label, key: "alert", label, tone: "neutral" });
  } else {
    const label = locale === "ko-KR" ? "활성 알림 없음" : "No active alerts";
    pills.push({ ariaLabel: label, key: "alert", label, tone: "success" });
  }

  const routeStatus = state?.routeStatus;
  const routeLabel = routeStatus === undefined
    ? locale === "ko-KR" ? "경로 알 수 없음" : "Route unknown"
    : `${locale === "ko-KR" ? "경로" : "Route"} ${humanizeStatus(routeStatus)}`;
  pills.push({
    ariaLabel: routeLabel,
    key: "route",
    label: routeLabel,
    tone: routeStatus === "COMPLETED" ? "success"
      : routeStatus === "IN_PROGRESS" ? "info"
        : routeStatus === "CANCELLED" ? "warning" : "neutral",
  });

  const position = state?.physicalPosition;
  const gpsFreshness = position?.freshness ?? "UNKNOWN";
  const gpsLabel = gpsFreshness === "FRESH"
    ? locale === "ko-KR" ? "GPS 실시간" : "GPS live"
    : gpsFreshness === "AGING"
      ? locale === "ko-KR" ? "GPS 지연" : "GPS aging"
      : gpsFreshness === "STALE"
        ? locale === "ko-KR" ? "GPS 오래됨" : "GPS stale"
        : locale === "ko-KR" ? "GPS 알 수 없음" : "GPS unknown";
  const gpsDetails = [
    position?.accuracyMeters == null ? null : `Accuracy ${position.accuracyMeters} metres`,
    position?.reliableForProximity === false
      ? locale === "ko-KR" ? "정류지 근접도 사용 불가" : "Stop proximity unavailable"
      : position?.withinProximityThreshold === true && position.nearestStopSequence != null
        ? locale === "ko-KR" ? `${position.nearestStopSequence}번 정류지 근처` : `Near stop ${position.nearestStopSequence}`
        : null,
  ].filter((value): value is string => value !== null);
  pills.push({
    ariaLabel: gpsDetails.length === 0 ? gpsLabel : `${gpsLabel}. ${gpsDetails.join(". ")}`,
    key: "gps",
    label: gpsLabel,
    tone: gpsFreshness === "FRESH" ? "info" : gpsFreshness === "AGING" ? "warning" : gpsFreshness === "STALE" ? "critical" : "neutral",
  });

  const device = state?.deviceProgress;
  const deviceTotal = device?.totalStopCount ?? fallbackTotalStops;
  const deviceCompleted = device?.completedStopCount;
  pills.push({
    ariaLabel: deviceCompleted === undefined ? `Device ${unknown}` : `Device ${deviceCompleted} of ${deviceTotal}`,
    key: "device",
    label: deviceCompleted === undefined ? `Device ${unknown}` : `Device ${deviceCompleted}/${deviceTotal}`,
    tone: deviceCompleted === undefined ? "neutral" : "info",
  });

  const server = state?.serverProgress;
  const serverTotal = server?.totalStopCount ?? fallbackTotalStops;
  const serverResolved = server?.resolvedStopCount;
  pills.push({
    ariaLabel: serverResolved === undefined ? `Server ${unknown}` : `Server ${serverResolved} of ${serverTotal} confirmed`,
    key: "server",
    label: serverResolved === undefined ? `Server ${unknown}` : `Server ${serverResolved}/${serverTotal}`,
    tone: serverResolved === undefined ? "neutral" : serverResolved === serverTotal && serverTotal > 0 ? "success" : "info",
  });

  const progressGap = deviceCompleted === undefined || serverResolved === undefined
    ? null
    : Math.abs(deviceCompleted - serverResolved);
  const gapLabel = progressGap === null
    ? locale === "ko-KR" ? "차이 알 수 없음" : "Gap unknown"
    : locale === "ko-KR" ? `차이 ${progressGap}개 정류지` : `Gap ${progressGap} ${progressGap === 1 ? "stop" : "stops"}`;
  pills.push({
    ariaLabel: progressGap === null
      ? gapLabel
      : locale === "ko-KR"
        ? `기기와 서버 진행 차이 ${progressGap}개 정류지`
        : `Progress gap ${progressGap} ${progressGap === 1 ? "stop" : "stops"} between device and server`,
    key: "gap",
    label: gapLabel,
    tone: progressGap === null ? "neutral" : progressGap === 0 ? "success" : "warning",
  });

  const syncState = normalizeSyncState(state?.syncHealth?.state);
  const queueDepth = state?.syncHealth?.queueDepth;
  const syncLabel = syncState === "BLOCKED"
    ? locale === "ko-KR" ? "동기화 차단" : "Sync blocked"
    : syncState === "DELAYED"
      ? queueDepth === null || queueDepth === undefined
        ? locale === "ko-KR" ? "동기화 지연" : "Sync delayed"
        : locale === "ko-KR" ? `동기화 대기 ${queueDepth}건` : `Sync ${queueDepth} pending`
      : syncState === "HEALTHY"
        ? locale === "ko-KR" ? "동기화 정상" : "Sync healthy"
        : locale === "ko-KR" ? "동기화 알 수 없음" : "Sync unknown";
  pills.push({
    ariaLabel: state?.syncHealth?.lastErrorCode == null ? syncLabel : `${syncLabel}. ${state.syncHealth.lastErrorCode}`,
    key: "sync",
    label: syncLabel,
    tone: syncState === "BLOCKED" ? "critical" : syncState === "DELAYED" ? "warning" : syncState === "HEALTHY" ? "success" : "neutral",
  });
  return pills;
}

type AlertLifecycleProjection = AdminNotificationDto | RouteOperationalAlertDto;

export function isActiveAlert(alert: AlertLifecycleProjection): boolean {
  return alert.resolvedAt == null;
}

export function highestActiveAlert<T extends AlertLifecycleProjection>(
  alerts: T[] | null | undefined,
): T | null {
  const severity = { CRITICAL: 0, WARNING: 1, INFO: 2, SUCCESS: 3 } as const;
  return [...(alerts ?? [])]
    .filter(isActiveAlert)
    .sort((left, right) => {
      const leftSeverity = severity[left.severity.toUpperCase() as keyof typeof severity] ?? 4;
      const rightSeverity = severity[right.severity.toUpperCase() as keyof typeof severity] ?? 4;
      const severityDifference = leftSeverity - rightSeverity;
      if (severityDifference !== 0) return severityDifference;
      return Date.parse(alertOpenedAt(left)) - Date.parse(alertOpenedAt(right));
    })[0] ?? null;
}

function alertOpenedAt(alert: AlertLifecycleProjection): string {
  if (alert.openedAt != null) return alert.openedAt;
  return 'createdAt' in alert ? alert.createdAt : alert.lastObservedAt;
}

function normalizeHealthState(value: OperationalHealthState | undefined): OperationalHealthState {
  return value === "HEALTHY" || value === "DEGRADED" || value === "DISABLED" ? value : "UNKNOWN";
}

function normalizeSyncState(value: string | undefined): "BLOCKED" | "DELAYED" | "HEALTHY" | "UNKNOWN" {
  return value === "BLOCKED" || value === "DELAYED" || value === "HEALTHY" ? value : "UNKNOWN";
}

function toneForHealthState(state: OperationalHealthState): OperationalPillTone {
  if (state === "HEALTHY") return "success";
  if (state === "DEGRADED") return "warning";
  if (state === "DISABLED") return "critical";
  return "neutral";
}

function runtimeComponent(
  health: RuntimeHealthDto | null | undefined,
  key: keyof Omit<OperationalRuntimeHealthDto, "observedAt">,
): OperationalRuntimeComponentDto | null {
  const direct = health?.[key];
  if (direct !== undefined && direct !== null) return direct;
  const email = health?.email;
  if (key === "emailSender" && email !== undefined) {
    return {
      state: email.state,
      ...(email.configured ? {} : { lastErrorCode: "EMAIL_RUNTIME_NOT_CONFIGURED" }),
    };
  }
  if (key === "emailOutbox" && email !== undefined) {
    return {
      failedCount: email.outbox.deadLetter,
      lastErrorCode: email.outbox.lastErrorCode,
      lastSuccessAt: email.outbox.lastSuccessAt,
      oldestPendingAt: email.outbox.oldestPendingAt,
      pendingCount: email.outbox.pending + email.outbox.processing + email.outbox.retryWait,
      state: email.outbox.deadLetter > 0 || email.outbox.retryWait > 0 ? "DEGRADED" : "HEALTHY",
    };
  }
  return null;
}

function humanizeStatus(value: string): string {
  return value.toLowerCase().split(/[_\s-]+/u).filter(Boolean).join(" ");
}

function runtimeHealthDetail(
  component: OperationalRuntimeComponentDto | null,
  locale: AppLocale,
): string | null {
  if (component === null) return null;
  const details: string[] = [];
  if (component.pendingCount != null) details.push(locale === "ko-KR" ? `대기 ${component.pendingCount}건` : `${component.pendingCount} pending`);
  if (component.failedCount != null) details.push(locale === "ko-KR" ? `실패 ${component.failedCount}건` : `${component.failedCount} failed`);
  if (component.attemptCount != null) details.push(locale === "ko-KR" ? `시도 ${component.attemptCount}회` : `${component.attemptCount} attempts`);
  if (component.oldestPendingAt != null) details.push(locale === "ko-KR" ? `가장 오래된 대기 ${component.oldestPendingAt}` : `oldest pending ${component.oldestPendingAt}`);
  if (component.lastSuccessAt != null) details.push(locale === "ko-KR" ? `마지막 성공 ${component.lastSuccessAt}` : `last success ${component.lastSuccessAt}`);
  if (component.lastErrorCode != null) details.push(component.lastErrorCode);
  return details.length === 0 ? null : details.join(", ");
}
