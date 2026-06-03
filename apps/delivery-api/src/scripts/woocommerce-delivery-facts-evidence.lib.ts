type DeliveryStopEvidence = {
  latitude: unknown;
  longitude: unknown;
  routePlanStops: Array<{ id: string }>;
};

export type WooDeliveryFactEvidenceRecord = {
  deliveryDate: Date | string | null;
  deliveryDateWeekdayMismatch: boolean;
  deliveryDateWeekdayVerified: boolean;
  deliveryDayParseStatus: string;
  geocodeStatus: string;
  rawDeliveryArea: string | null;
  rawDeliveryDate: string | null;
  rawDeliveryDay: string | null;
  rawDeliveryTimeWindow: string | null;
  readiness: string;
  reviewReasons: unknown;
  routeScopeKey: string | null;
  matchedMappingPaths?: unknown;
  mappingDiagnostics?: unknown;
  order: {
    deliveryStops: DeliveryStopEvidence[];
  };
};

type BlockerClass =
  | 'address'
  | 'geocode'
  | 'non_deliverable'
  | 'parser'
  | 'planning'
  | 'unknown';

type FactBlockerClassification = {
  classes: BlockerClass[];
  primaryClass: BlockerClass | null;
  unknownReasons: string[];
};

const PARSER_REVIEW_REASONS = new Set([
  'delivery_day_unparsed',
  'ambiguous_delivery_day',
  'delivery_date_weekday_unverified',
  'delivery_date_weekday_mismatch',
  'ambiguous_delivery_time_window',
  'delivery_time_window_unparsed',
]);

const ADDRESS_REVIEW_REASONS = new Set(['missing_address']);

const RAW_BACKED_PARSER_REVIEW_REASONS = new Set([
  'missing_delivery_area',
  'missing_delivery_date',
  'missing_route_scope',
]);

export function buildWooDeliveryFactsEvidence(input: {
  connectionId: string | null;
  expectedTotal: number;
  facts: WooDeliveryFactEvidenceRecord[];
  shopDomain: string | null;
}): Record<string, unknown> {
  const reviewReasonCounts = new Map<string, number>();
  const parserReasonCounts = new Map<string, number>();
  const addressReasonCounts = new Map<string, number>();
  const nonDeliverableReasonCounts = new Map<string, number>();
  const unknownReasonCounts = new Map<string, number>();
  const matchedMappingPathCounts = new Map<string, number>();
  const discoveredPathCounts = new Map<string, number>();
  const parserCandidatePathCounts = new Map<string, number>();
  const deliveryMetadataCandidateCounts = new Map<string, number>();
  const unsupportedValueTypeCounts = new Map<string, number>();
  const geocodeStatusCounts = new Map<string, number>();
  const blockerClassCounts = createCounter<BlockerClass>();
  const primaryBlockerClassCounts = createCounter<BlockerClass>();
  let alreadyPlanned = 0;
  let dateDayMismatch = 0;
  let missingCoordinates = 0;
  let ready = 0;
  let unverifiedDayTime = 0;

  for (const fact of input.facts) {
    const reasons = readStringArray(fact.reviewReasons);
    for (const reason of reasons) {
      increment(reviewReasonCounts, reason);
      if (isParserReasonForFact(reason, fact)) increment(parserReasonCounts, reason);
      if (ADDRESS_REVIEW_REASONS.has(reason)) increment(addressReasonCounts, reason);
      if (reason.startsWith('non_deliverable_status:')) {
        increment(nonDeliverableReasonCounts, reason);
      }
    }
    increment(geocodeStatusCounts, fact.geocodeStatus);
    collectMappingEvidence({
      deliveryMetadataCandidateCounts,
      discoveredPathCounts,
      fact,
      matchedMappingPathCounts,
      parserCandidatePathCounts,
      unsupportedValueTypeCounts,
    });

    const stop = fact.order.deliveryStops[0] ?? null;
    const hasCoordinates = hasStopCoordinates(stop);
    const planned = (stop?.routePlanStops.length ?? 0) > 0;
    const mismatch =
      fact.deliveryDateWeekdayMismatch ||
      reasons.includes('delivery_date_weekday_mismatch');
    const rawDayOrTimePresent =
      fact.rawDeliveryDay !== null || fact.rawDeliveryTimeWindow !== null;
    const unverified =
      rawDayOrTimePresent &&
      (!fact.deliveryDateWeekdayVerified ||
        fact.deliveryDayParseStatus === 'UNPARSED' ||
        fact.deliveryDayParseStatus === 'UNVERIFIED' ||
        reasons.includes('delivery_day_unparsed') ||
        reasons.includes('delivery_date_weekday_unverified'));

    if (planned) alreadyPlanned += 1;
    if (mismatch) dateDayMismatch += 1;
    if (!hasCoordinates) missingCoordinates += 1;
    if (unverified) unverifiedDayTime += 1;
    if (
      fact.readiness === 'READY_TO_PLAN' &&
      hasCoordinates &&
      !planned &&
      !mismatch &&
      !unverified
    ) {
      ready += 1;
    }

    const classification = classifyFactBlockers({
      fact,
      hasCoordinates,
      planned,
      reasons,
    });
    for (const blockerClass of classification.classes) {
      blockerClassCounts[blockerClass] += 1;
    }
    if (classification.primaryClass !== null) {
      primaryBlockerClassCounts[classification.primaryClass] += 1;
    }
    for (const reason of classification.unknownReasons) {
      increment(unknownReasonCounts, reason);
    }
  }

  return {
    report_scope: 'diagnostic_evidence_not_operational_readiness',
    blocker_taxonomy_version: 1,
    taxonomy_note:
      'Read-only evidence grouping for parser improvement prioritization; operational readiness remains owned by order delivery facts and Route Ops services.',
    already_planned: alreadyPlanned,
    blocked: input.facts.length - ready,
    blocker_class_counts: blockerClassCounts,
    connection_id: input.connectionId,
    count_matches_expected: input.facts.length === input.expectedTotal,
    date_day_mismatch: dateDayMismatch,
    expected_total: input.expectedTotal,
    generated_at: new Date().toISOString(),
    matched_mapping_path_counts: topCounts(matchedMappingPathCounts, 30),
    missing_coordinates: missingCoordinates,
    parser_blocked: blockerClassCounts.parser,
    parser_candidate_path_counts: topCounts(parserCandidatePathCounts, 30),
    parser_reason_counts: topCounts(parserReasonCounts, 20),
    primary_blocker_class_counts: primaryBlockerClassCounts,
    ready,
    redacted_diagnostics_summary: {
      delivery_metadata_candidate_counts: topCounts(
        deliveryMetadataCandidateCounts,
        30,
      ),
      discovered_path_counts: topCounts(discoveredPathCounts, 30),
      unsupported_value_type_counts: topCounts(unsupportedValueTypeCounts, 30),
    },
    review_reason_counts: topCounts(reviewReasonCounts, 20),
    address_reason_counts: topCounts(addressReasonCounts, 20),
    geocode_status_counts: topCounts(geocodeStatusCounts, 20),
    non_deliverable_reason_counts: topCounts(nonDeliverableReasonCounts, 20),
    shop_domain: input.shopDomain,
    total: input.facts.length,
    unknown_blocked: blockerClassCounts.unknown,
    unknown_reason_counts: topCounts(unknownReasonCounts, 20),
    unverified_day_time: unverifiedDayTime,
  };
}


function collectMappingEvidence(input: {
  deliveryMetadataCandidateCounts: Map<string, number>;
  discoveredPathCounts: Map<string, number>;
  fact: WooDeliveryFactEvidenceRecord;
  matchedMappingPathCounts: Map<string, number>;
  parserCandidatePathCounts: Map<string, number>;
  unsupportedValueTypeCounts: Map<string, number>;
}): void {
  const matchedMappingPaths = readRecord(input.fact.matchedMappingPaths);
  for (const [field, path] of Object.entries(matchedMappingPaths)) {
    if (typeof path !== 'string' || path.trim() === '') continue;
    increment(
      input.matchedMappingPathCounts,
      `${field}:${redactDiagnosticPath(path)}`,
    );
  }

  const mappingDiagnostics = readRecord(input.fact.mappingDiagnostics);
  const discoveredPathStats = readRecord(mappingDiagnostics.discoveredPathStats);
  for (const [path, count] of Object.entries(discoveredPathStats)) {
    if (typeof path !== 'string') continue;
    incrementBy(
      input.discoveredPathCounts,
      redactDiagnosticPath(path),
      readPositiveInteger(count) ?? 1,
    );
  }

  const unsupportedValues = Array.isArray(mappingDiagnostics.unsupportedValues)
    ? mappingDiagnostics.unsupportedValues
    : [];
  for (const value of unsupportedValues) {
    const record = readRecord(value);
    const path = typeof record.path === 'string' ? record.path : 'unknown_path';
    const type = typeof record.type === 'string' ? record.type : 'unknown_type';
    increment(
      input.unsupportedValueTypeCounts,
      `${redactDiagnosticPath(path)}:${type}`,
    );
  }

  const deliveryMetadata = readRecord(mappingDiagnostics.deliveryMetadata);
  const candidates = Array.isArray(deliveryMetadata.candidates)
    ? deliveryMetadata.candidates
    : [];
  for (const candidate of candidates) {
    const record = readRecord(candidate);
    const path =
      typeof record.path === 'string'
        ? redactDiagnosticPath(record.path)
        : 'unknown_path';
    const parseStatus =
      typeof record.parseStatus === 'string'
        ? record.parseStatus
        : 'UNKNOWN_STATUS';
    const source = typeof record.source === 'string' ? record.source : 'unknown';
    const key = `${path}:${parseStatus}:${source}`;
    increment(input.deliveryMetadataCandidateCounts, key);
    if (parseStatus === 'UNPARSED' || parseStatus === 'UNVERIFIED') {
      increment(input.parserCandidatePathCounts, key);
    }
  }
}

function classifyFactBlockers(input: {
  fact: WooDeliveryFactEvidenceRecord;
  hasCoordinates: boolean;
  planned: boolean;
  reasons: string[];
}): FactBlockerClassification {
  const classes = new Set<BlockerClass>();
  const unknownReasons: string[] = [];
  const hasReviewBlocker =
    input.fact.readiness === 'NEEDS_REVIEW' || input.reasons.length > 0;

  if (input.planned) classes.add('planning');

  if (input.reasons.some((reason) => reason.startsWith('non_deliverable_status:'))) {
    classes.add('non_deliverable');
  }

  if (input.reasons.some((reason) => ADDRESS_REVIEW_REASONS.has(reason))) {
    classes.add('address');
  }

  if (hasParserEvidence(input.fact, input.reasons)) {
    classes.add('parser');
  }

  if (shouldCountGeocodeBlocker(input.fact, input.hasCoordinates, input.reasons)) {
    classes.add('geocode');
  }

  if (hasReviewBlocker) {
    for (const reason of input.reasons) {
      if (!isKnownClassifiedReason(reason, input.fact)) unknownReasons.push(reason);
    }
    if (classes.size === 0) classes.add('unknown');
  }

  return {
    classes: [...classes].sort(),
    primaryClass: choosePrimaryBlocker(classes),
    unknownReasons,
  };
}


function isParserReasonForFact(
  reason: string,
  fact: WooDeliveryFactEvidenceRecord,
): boolean {
  if (PARSER_REVIEW_REASONS.has(reason)) return true;
  if (!RAW_BACKED_PARSER_REVIEW_REASONS.has(reason)) return false;
  return hasRawParserEvidence(fact);
}

function hasRawParserEvidence(fact: WooDeliveryFactEvidenceRecord): boolean {
  return (
    hasValue(fact.rawDeliveryArea) ||
    hasValue(fact.rawDeliveryDate) ||
    hasValue(fact.rawDeliveryDay) ||
    hasValue(fact.rawDeliveryTimeWindow) ||
    fact.deliveryDate !== null ||
    fact.routeScopeKey !== null
  );
}

function hasParserEvidence(
  fact: WooDeliveryFactEvidenceRecord,
  reasons: string[],
): boolean {
  if (reasons.some((reason) => PARSER_REVIEW_REASONS.has(reason))) return true;
  return (
    hasRawParserEvidence(fact) &&
    reasons.some((reason) => RAW_BACKED_PARSER_REVIEW_REASONS.has(reason))
  );
}

function shouldCountGeocodeBlocker(
  fact: WooDeliveryFactEvidenceRecord,
  hasCoordinates: boolean,
  reasons: string[],
): boolean {
  if (hasCoordinates) return false;
  if (reasons.some((reason) => ADDRESS_REVIEW_REASONS.has(reason))) return false;
  return fact.readiness === 'READY_TO_PLAN' || fact.geocodeStatus !== 'SUCCESS';
}

function isKnownClassifiedReason(
  reason: string,
  fact: WooDeliveryFactEvidenceRecord,
): boolean {
  if (ADDRESS_REVIEW_REASONS.has(reason)) return true;
  if (PARSER_REVIEW_REASONS.has(reason)) return true;
  if (reason.startsWith('non_deliverable_status:')) return true;
  if (!RAW_BACKED_PARSER_REVIEW_REASONS.has(reason)) return false;
  return (
    hasValue(fact.rawDeliveryArea) ||
    hasValue(fact.rawDeliveryDate) ||
    hasValue(fact.rawDeliveryDay) ||
    hasValue(fact.rawDeliveryTimeWindow) ||
    fact.deliveryDate !== null ||
    fact.routeScopeKey !== null
  );
}

function choosePrimaryBlocker(classes: Set<BlockerClass>): BlockerClass | null {
  const priority: BlockerClass[] = [
    'non_deliverable',
    'address',
    'parser',
    'geocode',
    'planning',
    'unknown',
  ];
  return priority.find((blockerClass) => classes.has(blockerClass)) ?? null;
}

function hasStopCoordinates(stop: DeliveryStopEvidence | null): boolean {
  return (
    stop?.latitude !== null &&
    stop?.latitude !== undefined &&
    stop.longitude !== null &&
    stop.longitude !== undefined
  );
}

function hasValue(value: string | null): boolean {
  return value !== null && value.trim() !== '';
}


function readRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readPositiveInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return null;
  }
  return value;
}

function incrementBy(map: Map<string, number>, key: string, amount: number): void {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function redactDiagnosticPath(path: string): string {
  const normalized = path.trim();
  if (
    /(?:consumer[_-]?secret|consumer[_-]?key|webhook[_-]?secret|access[_-]?token|refresh[_-]?token|api[_-]?key|private[_-]?key|secret|password|cookie|authorization|auth[_-]?token)/iu.test(
      normalized,
    )
  ) {
    return '[redacted-sensitive-path]';
  }
  return normalized.replace(/\[\d+\]/gu, '[]');
}

function createCounter<T extends string>(): Record<T, number> {
  return {
    address: 0,
    geocode: 0,
    non_deliverable: 0,
    parser: 0,
    planning: 0,
    unknown: 0,
  } as Record<T, number>;
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function topCounts(map: Map<string, number>, limit: number): Record<string, number> {
  return Object.fromEntries(
    [...map.entries()].sort((left, right) => right[1] - left[1]).slice(0, limit),
  );
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}
