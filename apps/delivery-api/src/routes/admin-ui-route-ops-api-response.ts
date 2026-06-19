import type { FastifyReply, FastifyRequest } from "fastify";

import { WooCommerceOnboardingError } from "../modules/commerce/woocommerce-connection-onboarding.service.js";
import { RouteScopeConfigValidationError } from "../modules/route-ops/route-scope-config.js";
import { RoutePlanBatchInvalidError } from "../modules/route-plans/route-plan.types.js";
import type { AdminWebSession } from "./admin-ui-session.js";

export type RouteOpsApiResponse<T> = {
  data: T;
  statusCode: number;
};

export type RouteOpsHttpError = Error & {
  code: string;
  httpStatus: 400 | 404 | 409;
  name: "RouteOpsHttpError";
};

export function createRouteOpsHttpError(
  code: string,
  message: string,
  httpStatus: 400 | 404 | 409,
): RouteOpsHttpError {
  return Object.assign(new Error(message), {
    code,
    httpStatus,
    name: "RouteOpsHttpError" as const,
  });
}

function isRouteOpsHttpError(error: unknown): error is RouteOpsHttpError {
  return (
    error instanceof Error &&
    error.name === "RouteOpsHttpError" &&
    "code" in error &&
    "httpStatus" in error
  );
}

export function createRouteOpsApiResponder(input: {
  buildCsp: () => string;
  countRoutePlanBatchBlockers: (
    blockers: readonly string[],
  ) => Record<string, number>;
  sanitizeError: (error: unknown) => string;
}): {
  routeOpsData: <T>(data: T, statusCode?: number) => RouteOpsApiResponse<T>;
  sendRouteOpsApiError: (
    reply: FastifyReply,
    statusCode: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) => unknown;
  withRouteOpsApi: <T>(
    request: FastifyRequest,
    reply: FastifyReply,
    session: AdminWebSession | null,
    handler: (
      session: AdminWebSession,
    ) => Promise<RouteOpsApiResponse<T>> | RouteOpsApiResponse<T>,
  ) => Promise<unknown>;
} {
  function routeOpsData<T>(data: T, statusCode = 200): RouteOpsApiResponse<T> {
    return { data, statusCode };
  }

  function sendRouteOpsApiError(
    reply: FastifyReply,
    statusCode: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ): unknown {
    return reply
      .code(statusCode)
      .type("application/json; charset=utf-8")
      .header("Cache-Control", "no-store")
      .header("Content-Security-Policy", input.buildCsp())
      .send({
        data: null,
        error: { code, ...(details === undefined ? {} : { details }), message },
      });
  }

  async function withRouteOpsApi<T>(
    request: FastifyRequest,
    reply: FastifyReply,
    session: AdminWebSession | null,
    handler: (
      session: AdminWebSession,
    ) => Promise<RouteOpsApiResponse<T>> | RouteOpsApiResponse<T>,
  ): Promise<unknown> {
    if (session === null) {
      return sendRouteOpsApiError(
        reply,
        401,
        "UNAUTHORIZED",
        "Admin UI login required",
      );
    }
    try {
      const response = await handler(session);
      return reply
        .code(response.statusCode)
        .type("application/json; charset=utf-8")
        .header("Cache-Control", "no-store")
        .header("Content-Security-Policy", input.buildCsp())
        .send({ data: response.data, error: null });
    } catch (error) {
      if (error instanceof RoutePlanBatchInvalidError) {
        request.log.warn(
          {
            blockerCounts: input.countRoutePlanBatchBlockers(error.blockers),
            blockersCount: error.blockers.length,
          },
          "route plan batch creation hard-failed",
        );
        return sendRouteOpsApiError(
          reply,
          400,
          error.code,
          input.sanitizeError(error),
          {
            blockerCounts: input.countRoutePlanBatchBlockers(error.blockers),
            blockers: error.blockers,
          },
        );
      }
      if (error instanceof RouteScopeConfigValidationError) {
        return sendRouteOpsApiError(reply, 400, error.code, error.message);
      }
      if (isRouteOpsHttpError(error)) {
        return sendRouteOpsApiError(
          reply,
          error.httpStatus,
          error.code,
          error.message,
        );
      }
      const statusCode =
        error instanceof WooCommerceOnboardingError ? error.httpStatus : 500;
      const code =
        error instanceof WooCommerceOnboardingError
          ? error.code
          : "ADMIN_UI_REQUEST_FAILED";
      if (!(error instanceof WooCommerceOnboardingError)) {
        request.log.error({ err: error }, "route ops API request failed");
      }
      return sendRouteOpsApiError(
        reply,
        statusCode,
        code,
        input.sanitizeError(error),
      );
    }
  }

  return { routeOpsData, sendRouteOpsApiError, withRouteOpsApi };
}
