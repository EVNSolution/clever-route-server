import { randomUUID } from "node:crypto";

import type { GeocodingService } from "../modules/geocoding/geocoding.service.js";
import type { GeocodingResult } from "../modules/geocoding/geocoding.types.js";
import { summarizeGeocodeDiagnostic } from "../modules/geocoding/geocoding.diagnostics.js";
import type { CanonicalOrderRow } from "../modules/shopify/order-sync.mapper.js";
import type {
  ListCanonicalOrdersFilters,
  PatchCanonicalOrderCoordinatesInput,
  PatchCanonicalOrderGeocodeDiagnosticsInput,
} from "../modules/shopify/order-sync.repository.js";
import { WooCommerceOnboardingError } from "../modules/commerce/woocommerce-connection-onboarding.service.js";

export type AdminUiBulkGeocodeOrderPresenter = (
  order: CanonicalOrderRow,
) => unknown;

export type BulkGeocodeJobStatus =
  | "accepted"
  | "running"
  | "completed"
  | "failed";

export type BulkGeocodeResult =
  | {
      cached: boolean;
      order: ReturnType<AdminUiBulkGeocodeOrderPresenter>;
      orderId: string;
      orderName: string;
      status: "resolved";
    }
  | {
      code: string;
      message: string;
      orderId: string;
      orderName: string;
      status: "failed" | "no_address";
    };

type BulkGeocodeServiceInput = {
  geocodingService?: Pick<GeocodingService, "geocode" | "status">;
  orderSyncService?: {
    listCanonicalOrders(input: {
      filters?: ListCanonicalOrdersFilters;
      shopDomain: string;
    }): Promise<CanonicalOrderRow[]>;
    patchCanonicalOrderCoordinates?: (
      input: PatchCanonicalOrderCoordinatesInput,
    ) => Promise<CanonicalOrderRow | null>;
    patchCanonicalOrderGeocodeDiagnostics?: (
      input: PatchCanonicalOrderGeocodeDiagnosticsInput,
    ) => Promise<CanonicalOrderRow | null>;
  };
};

export type BulkGeocodeServices = {
  geocodingService: Pick<GeocodingService, "geocode" | "status">;
  orderSyncService: NonNullable<BulkGeocodeServiceInput["orderSyncService"]> & {
    patchCanonicalOrderCoordinates: NonNullable<
      NonNullable<
        BulkGeocodeServiceInput["orderSyncService"]
      >["patchCanonicalOrderCoordinates"]
    >;
  };
};

export type BulkGeocodeJob = {
  completedAt: string | null;
  counts: {
    alreadyHasCoordinates: number;
    attempted: number;
    failed: number;
    matched: number;
    noAddress: number;
    succeeded: number;
  };
  createdAt: string;
  error: string | null;
  filters: ListCanonicalOrdersFilters;
  jobId: string;
  results: BulkGeocodeResult[];
  shopDomain: string;
  status: BulkGeocodeJobStatus;
  updatedAt: string;
};

const bulkGeocodeJobs = new Map<string, BulkGeocodeJob>();

export function requireBulkGeocodeServices(
  dependencies: BulkGeocodeServiceInput,
): BulkGeocodeServices {
  if (dependencies.orderSyncService === undefined) {
    throw new WooCommerceOnboardingError(
      "BAD_REQUEST",
      "Order list service is not enabled in this runtime.",
      400,
    );
  }
  if (dependencies.geocodingService === undefined) {
    throw new WooCommerceOnboardingError(
      "BAD_REQUEST",
      "Geocoding is not enabled in this runtime.",
      400,
    );
  }
  if (
    dependencies.orderSyncService.patchCanonicalOrderCoordinates === undefined
  ) {
    throw new WooCommerceOnboardingError(
      "BAD_REQUEST",
      "Order coordinate editing is not enabled in this runtime.",
      400,
    );
  }
  const orderSyncService = dependencies.orderSyncService;
  const patchCanonicalOrderCoordinates = (
    input: PatchCanonicalOrderCoordinatesInput,
  ): Promise<CanonicalOrderRow | null> =>
    orderSyncService.patchCanonicalOrderCoordinates === undefined
      ? Promise.resolve(null)
      : orderSyncService.patchCanonicalOrderCoordinates(input);
  const patchCanonicalOrderGeocodeDiagnostics =
    orderSyncService.patchCanonicalOrderGeocodeDiagnostics === undefined
      ? undefined
      : (input: PatchCanonicalOrderGeocodeDiagnosticsInput) =>
          orderSyncService.patchCanonicalOrderGeocodeDiagnostics === undefined
            ? Promise.resolve(null)
            : orderSyncService.patchCanonicalOrderGeocodeDiagnostics(input);
  return {
    geocodingService: dependencies.geocodingService,
    orderSyncService: {
      listCanonicalOrders:
        orderSyncService.listCanonicalOrders.bind(orderSyncService),
      patchCanonicalOrderCoordinates,
      ...(patchCanonicalOrderGeocodeDiagnostics === undefined
        ? {}
        : { patchCanonicalOrderGeocodeDiagnostics }),
    },
  };
}

export function createBulkGeocodeJob(input: {
  filters: ListCanonicalOrdersFilters;
  shopDomain: string;
}): BulkGeocodeJob {
  const now = new Date().toISOString();
  const job: BulkGeocodeJob = {
    completedAt: null,
    counts: {
      alreadyHasCoordinates: 0,
      attempted: 0,
      failed: 0,
      matched: 0,
      noAddress: 0,
      succeeded: 0,
    },
    createdAt: now,
    error: null,
    filters: input.filters,
    jobId: randomUUID(),
    results: [],
    shopDomain: input.shopDomain,
    status: "accepted",
    updatedAt: now,
  };
  bulkGeocodeJobs.set(job.jobId, job);
  return job;
}

export async function runBulkGeocodeJob(input: {
  actor: string;
  job: BulkGeocodeJob;
  services: BulkGeocodeServices;
  toOrderDto: AdminUiBulkGeocodeOrderPresenter;
}): Promise<void> {
  updateBulkGeocodeJob(input.job, { status: "running" });
  try {
    const orders = await input.services.orderSyncService.listCanonicalOrders({
      filters: input.job.filters,
      shopDomain: input.job.shopDomain,
    });
    input.job.counts.matched = orders.length;
    const ordersToGeocode = orders.filter(
      (order) => !hasRouteOpsCoordinates(order),
    );
    input.job.counts.alreadyHasCoordinates =
      orders.length - ordersToGeocode.length;
    touchBulkGeocodeJob(input.job);

    for (const order of ordersToGeocode) {
      const geocode = await input.services.geocodingService.geocode({
        address: routeOpsGeocodeAddress(order),
        shopDomain: input.job.shopDomain,
      });
      if (!geocode.ok) {
        if (geocode.code === "BLANK_ADDRESS") input.job.counts.noAddress += 1;
        else input.job.counts.failed += 1;
        input.job.counts.attempted += 1;
        input.job.results.push({
          code: geocode.code,
          message: geocode.message,
          orderId: order.orderId,
          orderName: order.name,
          status: geocode.code === "BLANK_ADDRESS" ? "no_address" : "failed",
        });
        await input.services.orderSyncService.patchCanonicalOrderGeocodeDiagnostics?.(
          {
            actor: input.actor,
            diagnostic: summarizeGeocodeDiagnostic(geocode, "bulk_geocode"),
            geocodeStatus:
              geocode.code === "BLANK_ADDRESS" ? "PENDING" : "FAILED",
            orderId: order.orderId,
            shopDomain: input.job.shopDomain,
            source: "bulk_geocode",
          },
        );
        touchBulkGeocodeJob(input.job);
        continue;
      }

      input.job.counts.attempted += 1;
      const updatedOrder =
        await input.services.orderSyncService.patchCanonicalOrderCoordinates({
          actor: input.actor,
          geocodeDiagnostic: {
            diagnostic: summarizeGeocodeDiagnostic(geocode, "bulk_geocode"),
            source: "bulk_geocode",
          },
          latitude: geocode.result.latitude,
          longitude: geocode.result.longitude,
          orderId: order.orderId,
          provider: geocode.result.provider,
          providerPlaceId: geocode.result.providerPlaceId,
          shopDomain: input.job.shopDomain,
          source: "geocoder",
        });
      if (updatedOrder === null) {
        input.job.counts.failed += 1;
        input.job.results.push({
          code: "ORDER_NOT_FOUND",
          message: "Order not found while saving geocoded coordinates.",
          orderId: order.orderId,
          orderName: order.name,
          status: "failed",
        });
        touchBulkGeocodeJob(input.job);
        continue;
      }

      input.job.counts.succeeded += 1;
      input.job.results.push({
        cached: geocode.cached,
        order: input.toOrderDto(updatedOrder),
        orderId: order.orderId,
        orderName: order.name,
        status: "resolved",
      });
      touchBulkGeocodeJob(input.job);
    }

    updateBulkGeocodeJob(input.job, { status: "completed" });
  } catch (error) {
    updateBulkGeocodeJob(input.job, {
      error: error instanceof Error ? error.message : "Bulk geocode failed.",
      status: "failed",
    });
  }
}

export function routeOpsGeocodeAddress(
  order: Pick<CanonicalOrderRow, "rawWooGeocodeAddress" | "shippingAddress">,
): CanonicalOrderRow["shippingAddress"] {
  return order.rawWooGeocodeAddress ?? order.shippingAddress;
}

function updateBulkGeocodeJob(
  job: BulkGeocodeJob,
  patch: Partial<Pick<BulkGeocodeJob, "error" | "status">>,
): void {
  if (patch.status !== undefined) job.status = patch.status;
  if (patch.error !== undefined) job.error = patch.error;
  if (patch.status === "completed" || patch.status === "failed") {
    job.completedAt = new Date().toISOString();
  }
  touchBulkGeocodeJob(job);
}

function touchBulkGeocodeJob(job: BulkGeocodeJob): void {
  job.updatedAt = new Date().toISOString();
}

export function readBulkGeocodeJobForSession(
  jobId: string,
  shopDomain: string,
): BulkGeocodeJob {
  const job = bulkGeocodeJobs.get(jobId) ?? null;
  if (job === null || job.shopDomain !== shopDomain) {
    throw new WooCommerceOnboardingError(
      "NOT_FOUND",
      "Bulk geocode job not found",
      404,
    );
  }
  return job;
}

export function toBulkGeocodeOrderResponse(job: BulkGeocodeJob): {
  jobId: string;
  status: BulkGeocodeJobStatus;
  summary: {
    alreadyHasCoordinates: number;
    attempted: number;
    failed: number;
    matched: number;
    noAddress: number;
    resolved: number;
  };
} {
  return {
    jobId: job.jobId,
    status: job.status,
    summary: {
      alreadyHasCoordinates: job.counts.alreadyHasCoordinates,
      attempted: job.counts.attempted,
      failed: job.counts.failed,
      matched: job.counts.matched,
      noAddress: job.counts.noAddress,
      resolved: job.counts.succeeded,
    },
  };
}

export function toBulkGeocodeJobDto(job: BulkGeocodeJob): {
  completedAt: string | null;
  counts: BulkGeocodeJob["counts"];
  createdAt: string;
  error: string | null;
  jobId: string;
  results: BulkGeocodeResult[];
  status: BulkGeocodeJobStatus;
  updatedAt: string;
} {
  return {
    completedAt: job.completedAt,
    counts: job.counts,
    createdAt: job.createdAt,
    error: job.error,
    jobId: job.jobId,
    results: job.results,
    status: job.status,
    updatedAt: job.updatedAt,
  };
}

function hasRouteOpsCoordinates(order: CanonicalOrderRow): boolean {
  return (
    order.hasCoordinates && order.latitude !== null && order.longitude !== null
  );
}

export function readRouteOpsAddress(
  value: unknown,
  fallback: CanonicalOrderRow["shippingAddress"],
): CanonicalOrderRow["shippingAddress"] {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new WooCommerceOnboardingError(
      "BAD_REQUEST",
      "address must be an object",
      400,
    );
  }
  const body = value as Record<string, unknown>;
  return {
    address1: Object.hasOwn(body, "address1")
      ? readNullableJsonString(body.address1)
      : fallback.address1,
    address2: Object.hasOwn(body, "address2")
      ? readNullableJsonString(body.address2)
      : fallback.address2,
    city: Object.hasOwn(body, "city")
      ? readNullableJsonString(body.city)
      : fallback.city,
    countryCode: Object.hasOwn(body, "countryCode")
      ? readNullableJsonString(body.countryCode)
      : fallback.countryCode,
    postalCode: Object.hasOwn(body, "postalCode")
      ? readNullableJsonString(body.postalCode)
      : fallback.postalCode,
    province: Object.hasOwn(body, "province")
      ? readNullableJsonString(body.province)
      : fallback.province,
  };
}

function readNullableJsonString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new WooCommerceOnboardingError(
      "BAD_REQUEST",
      "Expected string or null",
      400,
    );
  }
  return value.trim() === "" ? null : value.trim();
}

export function toSafeRouteOpsGeocodeResponse(
  geocode: Extract<GeocodingResult, { ok: true }>,
): Extract<GeocodingResult, { ok: true }> {
  return {
    ...geocode,
    result: {
      ...geocode.result,
      addressLabel: safeGeocodeAddressLabel(geocode.result.addressLabel),
      rawLabel: null,
    },
  };
}

function safeGeocodeAddressLabel(value: string): string {
  return value === "freeform" ||
    value === "freeform_without_unit" ||
    value === "structured" ||
    value === "structured_without_unit" ||
    value === "store_settings"
    ? value
    : "geocoded_address";
}
