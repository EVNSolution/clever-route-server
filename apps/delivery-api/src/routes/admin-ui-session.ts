import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import type { FastifyRequest } from 'fastify';

const SESSION_VERSION = 'v1';
const LAUNCH_VERSION = 'launch-v1';
const CSRF_VERSION = 'v1';
const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const DEFAULT_LAUNCH_TTL_MS = 2 * 60 * 1000;
export const ADMIN_UI_COOKIE_PATH = '/admin/ui';
export const LEGACY_ADMIN_UI_COOKIE_PATH = '/admin/ui/commerce-connections/woocommerce';
export const BROAD_LEGACY_ADMIN_UI_COOKIE_PATHS = ['/admin', '/'] as const;
export const DEFAULT_ADMIN_UI_COOKIE_NAME = 'clever_admin_ui';
export const MIN_ADMIN_WEB_SECRET_BYTES = 32;

type SessionPayload = {
  csrfSecret: string;
  expiresAt: number;
  issuedAt: number;
  sessionId: string;
  subject: string;
};

type LaunchPayload = {
  expiresAt: number;
  issuedAt: number;
  launchId: string;
  returnPath: string;
  shopDomain: string;
  subject: string;
};

export type AdminWebSession = {
  csrfToken: string;
  expiresAt: number;
  sessionId: string;
  subject: string;
};

export type CreateAdminWebSessionInput = {
  cookieName?: string;
  now?: () => Date;
  secure: boolean;
  sessionSecret: string;
  subject: string;
  ttlMs?: number;
};

export type CreateAdminWebLaunchTokenInput = {
  now?: () => Date;
  returnPath: string;
  sessionSecret: string;
  shopDomain: string;
  subject: string;
  ttlMs?: number;
};

export type AdminWebLaunchToken = {
  expiresAt: number;
  returnPath: string;
  shopDomain: string;
  subject: string;
};

export type VerifiedAdminWebSession = AdminWebSession & {
  cookieValue: string;
};

export function isStrongAdminWebSecret(value: string | undefined): value is string {
  if (value === undefined) return false;
  return Buffer.byteLength(value.trim(), 'utf8') >= MIN_ADMIN_WEB_SECRET_BYTES;
}

export function verifyAdminWebLoginSecret(input: { candidate: string; expected: string }): boolean {
  if (!isStrongAdminWebSecret(input.expected)) return false;
  const candidate = input.candidate.trim();
  if (candidate === '') return false;

  return timingSafeEqual(hashComparableSecret(candidate), hashComparableSecret(input.expected.trim()));
}

export function createAdminWebSession(input: CreateAdminWebSessionInput): {
  cookieHeader: string;
  session: AdminWebSession;
} {
  assertStrongAdminWebSecret(input.sessionSecret, 'CLEVER_ADMIN_WEB_SESSION_SECRET');
  const now = input.now?.() ?? new Date();
  const issuedAt = now.getTime();
  const expiresAt = issuedAt + (input.ttlMs ?? DEFAULT_SESSION_TTL_MS);
  const payload: SessionPayload = {
    csrfSecret: randomBytes(32).toString('base64url'),
    expiresAt,
    issuedAt,
    sessionId: randomBytes(16).toString('base64url'),
    subject: input.subject
  };
  const cookieValue = signPayload(payload, input.sessionSecret);
  const session = toAdminWebSession(payload);

  return {
    cookieHeader: serializeCookie({
      httpOnly: true,
      maxAgeSeconds: Math.max(1, Math.floor((expiresAt - issuedAt) / 1000)),
      name: input.cookieName ?? DEFAULT_ADMIN_UI_COOKIE_NAME,
      path: ADMIN_UI_COOKIE_PATH,
      sameSite: 'Strict',
      secure: input.secure,
      value: cookieValue
    }),
    session
  };
}

export function createAdminWebLaunchToken(input: CreateAdminWebLaunchTokenInput): {
  expiresAt: string;
  token: string;
} {
  assertStrongAdminWebSecret(input.sessionSecret, 'CLEVER_ADMIN_WEB_SESSION_SECRET');
  const now = input.now?.() ?? new Date();
  const issuedAt = now.getTime();
  const expiresAt = issuedAt + (input.ttlMs ?? DEFAULT_LAUNCH_TTL_MS);
  const payload: LaunchPayload = {
    expiresAt,
    issuedAt,
    launchId: randomBytes(16).toString('base64url'),
    returnPath: normalizeAdminUiReturnPath(input.returnPath),
    shopDomain: input.shopDomain,
    subject: input.subject
  };
  return {
    expiresAt: new Date(expiresAt).toISOString(),
    token: signLaunchPayload(payload, input.sessionSecret)
  };
}

export function verifyAdminWebLaunchToken(input: {
  now?: () => Date;
  sessionSecret: string;
  token: string;
}): AdminWebLaunchToken | null {
  const payload = verifySignedLaunchPayload(input);
  if (payload === null) return null;
  return {
    expiresAt: payload.expiresAt,
    returnPath: payload.returnPath,
    shopDomain: payload.shopDomain,
    subject: payload.subject
  };
}

export function verifyAdminWebSessionFromRequest(input: {
  cookieName?: string;
  now?: () => Date;
  request: FastifyRequest;
  sessionSecret: string;
}): VerifiedAdminWebSession | null {
  const cookieValue = readCookie(input.request.headers.cookie, input.cookieName ?? DEFAULT_ADMIN_UI_COOKIE_NAME);
  if (cookieValue === null) return null;

  const payload = verifySignedPayload({
    sessionSecret: input.sessionSecret,
    value: cookieValue,
    ...(input.now === undefined ? {} : { now: input.now })
  });
  if (payload === null) return null;

  return {
    ...toAdminWebSession(payload),
    cookieValue
  };
}

export function verifyAdminWebCsrfToken(input: {
  session: AdminWebSession;
  token: string | null | undefined;
}): boolean {
  if (input.token === undefined || input.token === null || input.token.trim() === '') return false;
  return timingSafeEqual(
    hashComparableSecret(input.token.trim()),
    hashComparableSecret(input.session.csrfToken)
  );
}

export function clearAdminWebSessionCookie(input: { cookieName?: string; secure: boolean }): string {
  return clearAdminWebSessionCookieAtPath({ ...input, path: ADMIN_UI_COOKIE_PATH });
}

export function clearLegacyAdminWebSessionCookie(input: { cookieName?: string; secure: boolean }): string {
  return clearAdminWebSessionCookieAtPath({ ...input, path: LEGACY_ADMIN_UI_COOKIE_PATH });
}

export function clearBroadLegacyAdminWebSessionCookies(input: {
  cookieName?: string;
  secure: boolean;
}): string[] {
  return BROAD_LEGACY_ADMIN_UI_COOKIE_PATHS.map((path) => clearAdminWebSessionCookieAtPath({ ...input, path }));
}

function clearAdminWebSessionCookieAtPath(input: { cookieName?: string; path: string; secure: boolean }): string {
  return serializeCookie({
    httpOnly: true,
    maxAgeSeconds: 0,
    name: input.cookieName ?? DEFAULT_ADMIN_UI_COOKIE_NAME,
    path: input.path,
    sameSite: 'Strict',
    secure: input.secure,
    value: ''
  });
}

export function assertStrongAdminWebSecret(value: string, variableName: string): void {
  if (!isStrongAdminWebSecret(value)) {
    throw new Error(`${variableName} must be at least ${MIN_ADMIN_WEB_SECRET_BYTES} bytes`);
  }
}

function toAdminWebSession(payload: SessionPayload): AdminWebSession {
  return {
    csrfToken: createCsrfToken(payload),
    expiresAt: payload.expiresAt,
    sessionId: payload.sessionId,
    subject: payload.subject
  };
}

function signPayload(payload: SessionPayload, sessionSecret: string): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = sign(`${SESSION_VERSION}.${encodedPayload}`, sessionSecret);
  return `${SESSION_VERSION}.${encodedPayload}.${signature}`;
}

function signLaunchPayload(payload: LaunchPayload, sessionSecret: string): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = sign(`${LAUNCH_VERSION}.${encodedPayload}`, sessionSecret);
  return `${LAUNCH_VERSION}.${encodedPayload}.${signature}`;
}

function verifySignedPayload(input: {
  now?: () => Date;
  sessionSecret: string;
  value: string;
}): SessionPayload | null {
  assertStrongAdminWebSecret(input.sessionSecret, 'CLEVER_ADMIN_WEB_SESSION_SECRET');
  const parts = input.value.split('.');
  if (parts.length !== 3) return null;
  const [version, encodedPayload, signature] = parts;
  if (version !== SESSION_VERSION || encodedPayload === undefined || signature === undefined) return null;

  const expected = sign(`${SESSION_VERSION}.${encodedPayload}`, input.sessionSecret);
  if (!timingSafeEqual(hashComparableSecret(signature), hashComparableSecret(expected))) return null;

  try {
    const decoded = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as Partial<SessionPayload>;
    if (!isSessionPayload(decoded)) return null;
    const now = input.now?.() ?? new Date();
    if (decoded.expiresAt <= now.getTime()) return null;
    return decoded;
  } catch {
    return null;
  }
}

function verifySignedLaunchPayload(input: {
  now?: () => Date;
  sessionSecret: string;
  token: string;
}): LaunchPayload | null {
  assertStrongAdminWebSecret(input.sessionSecret, 'CLEVER_ADMIN_WEB_SESSION_SECRET');
  const parts = input.token.split('.');
  if (parts.length !== 3) return null;
  const [version, encodedPayload, signature] = parts;
  if (version !== LAUNCH_VERSION || encodedPayload === undefined || signature === undefined) return null;

  const expected = sign(`${LAUNCH_VERSION}.${encodedPayload}`, input.sessionSecret);
  if (!timingSafeEqual(hashComparableSecret(signature), hashComparableSecret(expected))) return null;

  try {
    const decoded = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as Partial<LaunchPayload>;
    if (!isLaunchPayload(decoded)) return null;
    const now = input.now?.() ?? new Date();
    if (decoded.expiresAt <= now.getTime()) return null;
    return decoded;
  } catch {
    return null;
  }
}

function isSessionPayload(value: Partial<SessionPayload>): value is SessionPayload {
  return (
    typeof value.csrfSecret === 'string' &&
    typeof value.expiresAt === 'number' &&
    Number.isFinite(value.expiresAt) &&
    typeof value.issuedAt === 'number' &&
    Number.isFinite(value.issuedAt) &&
    typeof value.sessionId === 'string' &&
    value.sessionId !== '' &&
    typeof value.subject === 'string' &&
    value.subject !== ''
  );
}

function isLaunchPayload(value: Partial<LaunchPayload>): value is LaunchPayload {
  return (
    typeof value.expiresAt === 'number' &&
    Number.isFinite(value.expiresAt) &&
    typeof value.issuedAt === 'number' &&
    Number.isFinite(value.issuedAt) &&
    typeof value.launchId === 'string' &&
    value.launchId !== '' &&
    typeof value.returnPath === 'string' &&
    normalizeAdminUiReturnPath(value.returnPath) === value.returnPath &&
    typeof value.shopDomain === 'string' &&
    value.shopDomain !== '' &&
    typeof value.subject === 'string' &&
    value.subject !== ''
  );
}

function normalizeAdminUiReturnPath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '' || !trimmed.startsWith('/admin/ui')) {
    return '/admin/ui';
  }
  if (trimmed.startsWith('//') || /^https?:\/\//iu.test(trimmed)) {
    return '/admin/ui';
  }
  if (trimmed !== '/admin/ui' && !trimmed.startsWith('/admin/ui/') && !trimmed.startsWith('/admin/ui?')) {
    return '/admin/ui';
  }
  return trimmed;
}

function createCsrfToken(payload: SessionPayload): string {
  const body = `${CSRF_VERSION}.${payload.sessionId}.${payload.subject}.${payload.expiresAt}`;
  return `${body}.${sign(`${body}.${payload.csrfSecret}`, payload.csrfSecret)}`;
}

function sign(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

function hashComparableSecret(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function readCookie(header: string | undefined, name: string): string | null {
  if (header === undefined || header.trim() === '') return null;
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    if (key !== name) continue;
    try {
      return decodeURIComponent(trimmed.slice(separator + 1));
    } catch {
      return null;
    }
  }
  return null;
}

function serializeCookie(input: {
  httpOnly: boolean;
  maxAgeSeconds: number;
  name: string;
  path: string;
  sameSite: 'Strict';
  secure: boolean;
  value: string;
}): string {
  const attributes = [
    `${input.name}=${encodeURIComponent(input.value)}`,
    `Max-Age=${input.maxAgeSeconds}`,
    `Path=${input.path}`,
    `SameSite=${input.sameSite}`
  ];
  if (input.httpOnly) attributes.push('HttpOnly');
  if (input.secure) attributes.push('Secure');
  return attributes.join('; ');
}
