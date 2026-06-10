import type { FastifyRequest } from "fastify";

import type { AdminWooSyncServiceContract } from "../modules/commerce/admin-woocommerce-sync.service.js";
import { WooCommerceOnboardingError } from "../modules/commerce/woocommerce-connection-onboarding.service.js";
import type {
  WordPressPluginSyncRequestInput,
  WordPressPluginSyncRun,
} from "../modules/wordpress-plugin/wordpress-plugin.types.js";

export type RouteOpsWooSyncAccepted = Awaited<
  ReturnType<AdminWooSyncServiceContract["requestSync"]>
>;

export function toRouteOpsWooSyncResponse(accepted: RouteOpsWooSyncAccepted): {
  alreadyRunning: boolean;
  message: string;
  syncRun: WordPressPluginSyncRun;
} {
  return {
    alreadyRunning: accepted.alreadyRunning,
    message: accepted.message,
    syncRun: accepted.syncRun,
  };
}

export function scheduleRouteOpsWooSyncProcessing(input: {
  accepted: RouteOpsWooSyncAccepted;
  request: Pick<FastifyRequest, "log">;
  sanitizeError: (error: unknown) => string;
  service?: Pick<AdminWooSyncServiceContract, "processSyncRun">;
  shopDomain: string;
}): void {
  if (input.accepted.startBackgroundProcessing !== true) return;
  if (input.service === undefined) return;

  const syncRunId = input.accepted.syncRun.syncRunId;
  input.request.log.info(
    { shopDomain: input.shopDomain, syncRunId },
    "route ops admin WooCommerce sync background processing scheduled",
  );
  void input.service
    .processSyncRun({ shopDomain: input.shopDomain, syncRunId })
    .then((run) => {
      input.request.log.info(
        {
          pagesRead: run?.result?.pagesRead ?? null,
          received: run?.result?.sync.received ?? null,
          shopDomain: input.shopDomain,
          status: run?.status ?? null,
          syncRunId,
        },
        "route ops admin WooCommerce sync processed",
      );
    })
    .catch((error: unknown) => {
      input.request.log.error(
        {
          error: input.sanitizeError(error),
          shopDomain: input.shopDomain,
          syncRunId,
        },
        "route ops admin WooCommerce sync failed",
      );
    });
}

export function readRouteOpsWooSyncRequestBody(
  value: unknown,
): WordPressPluginSyncRequestInput {
  const body =
    value === undefined || value === null ? {} : readRouteOpsBodyObject(value);
  const rawPageSize = body.pageSize ?? 100;
  if (
    typeof rawPageSize !== "number" ||
    !Number.isInteger(rawPageSize) ||
    rawPageSize < 1 ||
    rawPageSize > 100
  ) {
    throw new WooCommerceOnboardingError(
      "BAD_REQUEST",
      "pageSize must be an integer from 1 to 100",
      400,
    );
  }
  return {
    modifiedAfter: readRouteOpsSyncModifiedAfter(body.modifiedAfter),
    pageSize: rawPageSize,
    status: readRouteOpsSyncStatus(body.status),
  };
}

export function readRouteOpsWooSourceOrderId(value: string): string {
  const trimmed = value.trim();
  if (!/^[1-9]\d*$/u.test(trimmed)) {
    throw new WooCommerceOnboardingError(
      "BAD_REQUEST",
      "WooCommerce source order id must be a positive integer",
      400,
    );
  }
  return trimmed;
}

function readRouteOpsSyncModifiedAfter(value: unknown): Date | null {
  const raw = readNullableJsonString(value);
  if (raw === null) return null;
  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime())) {
    throw new WooCommerceOnboardingError(
      "BAD_REQUEST",
      "modifiedAfter must be an ISO date-time string",
      400,
    );
  }
  return parsed;
}

function readRouteOpsSyncStatus(value: unknown): string | null {
  const status = readNullableJsonString(value);
  if (status === null) return null;
  if (status.length > 64) {
    throw new WooCommerceOnboardingError(
      "BAD_REQUEST",
      "status is too long",
      400,
    );
  }
  return status;
}

export function isRouteOpsUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}

function readRouteOpsBodyObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WooCommerceOnboardingError(
      "BAD_REQUEST",
      "JSON body is required",
      400,
    );
  }
  return value as Record<string, unknown>;
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
