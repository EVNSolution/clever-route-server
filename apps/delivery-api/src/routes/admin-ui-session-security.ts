import type { FastifyReply } from "fastify";

import { WooCommerceOnboardingError } from "../modules/commerce/woocommerce-connection-onboarding.service.js";
import {
  clearAdminWebSessionCookie,
  clearBroadLegacyAdminWebSessionCookies,
  clearLegacyAdminWebSessionCookie,
  type AdminWebSession,
} from "./admin-ui-session.js";

type SessionCookieDependencies = {
  cookieName?: string;
  secureCookies: boolean;
};

export function redirectWithClearedSession(
  reply: FastifyReply,
  dependencies: SessionCookieDependencies,
  loginPath: string,
): unknown {
  return reply
    .code(303)
    .header("Set-Cookie", sessionClearCookieHeaders(dependencies))
    .header("Location", loginPath)
    .send("");
}

export function sessionSetCookieHeaders(
  dependencies: SessionCookieDependencies,
  sessionCookieHeader: string,
): string[] {
  return [
    sessionCookieHeader,
    ...clearLegacySessionCookieHeaders(dependencies),
  ];
}

function sessionClearCookieHeaders(
  dependencies: SessionCookieDependencies,
): string[] {
  return [
    clearAdminWebSessionCookie({
      secure: dependencies.secureCookies,
      ...(dependencies.cookieName === undefined
        ? {}
        : { cookieName: dependencies.cookieName }),
    }),
    ...clearLegacySessionCookieHeaders(dependencies),
  ];
}

function clearLegacySessionCookieHeaders(
  dependencies: SessionCookieDependencies,
): string[] {
  const input = {
    secure: dependencies.secureCookies,
    ...(dependencies.cookieName === undefined
      ? {}
      : { cookieName: dependencies.cookieName }),
  };
  return [
    clearLegacyAdminWebSessionCookie(input),
    ...clearBroadLegacyAdminWebSessionCookies(input),
  ];
}

export function assertWpPluginShopAccess(
  session: AdminWebSession,
  requestedShopDomain: string | null,
): void {
  const authorizedShopDomain = readWpPluginSessionShopDomain(session);
  if (authorizedShopDomain === null || requestedShopDomain === null) return;
  if (requestedShopDomain !== authorizedShopDomain) {
    throw new WooCommerceOnboardingError(
      "FORBIDDEN",
      "WordPress-launched admin session is limited to its connected shopDomain.",
      403,
    );
  }
}

export function readWpPluginSessionShopDomain(
  session: AdminWebSession,
): string | null {
  const prefix = "wordpress-plugin:";
  if (!session.subject.startsWith(prefix)) return null;
  return normalizeOptionalShopDomain(session.subject.slice(prefix.length));
}

export function isWpPluginSession(session: AdminWebSession): boolean {
  return readWpPluginSessionShopDomain(session) !== null;
}

function normalizeOptionalShopDomain(
  value: string | null | undefined,
): string | null {
  if (value === undefined || value === null || value.trim() === "") return null;
  return normalizeRequiredShopDomain(value);
}

function normalizeRequiredShopDomain(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//iu, "")
    .replace(/\/.*$/u, "");
  if (
    normalized === "" ||
    normalized.length > 255 ||
    !/^[a-z0-9.-]+$/u.test(normalized)
  ) {
    throw new WooCommerceOnboardingError(
      "BAD_REQUEST",
      "shopDomain is invalid",
      400,
    );
  }
  return normalized;
}
