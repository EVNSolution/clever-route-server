import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import type {
  DriverAssignedRoute,
  DriverAssignedRouteServiceContract,
  DriverRouteMapPreview
} from './driver-assigned-route.types.js';
import {
  DRIVER_ROUTE_MAP_PREVIEW_HEIGHT,
  DRIVER_ROUTE_MAP_PREVIEW_RENDERER_VERSION,
  DRIVER_ROUTE_MAP_PREVIEW_WIDTH,
  hasRenderableDriverRouteMapPreview,
  renderDriverRouteMapPreviewPng
} from './driver-route-map-preview.renderer.js';

export const DEFAULT_DRIVER_ROUTE_MAP_PREVIEW_TTL_SECONDS = 10 * 60;

export type DriverRouteMapPreviewServiceContract = {
  createRouteMapPreview(input: {
    baseUrl: string;
    driverId: string;
    route: DriverAssignedRoute;
    shopDomain: string;
  }): DriverRouteMapPreview | null;
  readRouteMapPreviewImage(input: {
    expires: string;
    previewId: string;
    signature: string;
  }): Promise<Buffer | null>;
};

type DriverRouteMapPreviewServiceOptions = {
  assignedRouteService: DriverAssignedRouteServiceContract;
  jwtSecret: string;
  now?: () => Date;
  ttlSeconds?: number;
};

type PreviewPayload = {
  checksum: string;
  driverId: string;
  routePlanId: string;
  shopDomain: string;
  version: 1;
};

export class DriverRouteMapPreviewService implements DriverRouteMapPreviewServiceContract {
  private readonly now: () => Date;
  private readonly ttlSeconds: number;
  private readonly encryptionKey: Buffer;
  private readonly signingKey: Buffer;

  constructor(private readonly options: DriverRouteMapPreviewServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.ttlSeconds = options.ttlSeconds ?? DEFAULT_DRIVER_ROUTE_MAP_PREVIEW_TTL_SECONDS;
    this.encryptionKey = createPurposeKey(options.jwtSecret, 'driver-route-map-preview-encryption');
    this.signingKey = createPurposeKey(options.jwtSecret, 'driver-route-map-preview-signing');
  }

  createRouteMapPreview(input: {
    baseUrl: string;
    driverId: string;
    route: DriverAssignedRoute;
    shopDomain: string;
  }): DriverRouteMapPreview | null {
    if (!hasRenderableDriverRouteMapPreview(input.route)) {
      return null;
    }

    const checksum = createRouteSequenceChecksum(input.route);
    const payload: PreviewPayload = {
      checksum,
      driverId: input.driverId,
      routePlanId: input.route.id,
      shopDomain: input.shopDomain,
      version: 1
    };
    const generatedAt = this.now();
    const expiresAt = new Date(generatedAt.getTime() + this.ttlSeconds * 1000);
    const expires = String(expiresAt.getTime());
    const previewId = this.encryptPayload(payload);
    const signature = this.signPreviewUrl(previewId, expires);
    const imageUrl = `${input.baseUrl.replace(/\/$/u, '')}/driver/route-map-preview/${previewId}?expires=${expires}&signature=${signature}`;

    return {
      altText: `Static route preview for ${input.route.stops.length} stops.`,
      contentType: 'image/png',
      expiresAt: expiresAt.toISOString(),
      generatedAt: generatedAt.toISOString(),
      height: DRIVER_ROUTE_MAP_PREVIEW_HEIGHT,
      imageUrl,
      kind: 'static_route_map',
      routeSequenceChecksum: checksum,
      width: DRIVER_ROUTE_MAP_PREVIEW_WIDTH
    };
  }

  async readRouteMapPreviewImage(input: {
    expires: string;
    previewId: string;
    signature: string;
  }): Promise<Buffer | null> {
    const expiresAt = Number(input.expires);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= this.now().getTime()) {
      return null;
    }
    if (!this.isValidSignature(input.previewId, input.expires, input.signature)) {
      return null;
    }

    const payload = this.decryptPayload(input.previewId);
    if (payload === null) {
      return null;
    }

    const result = await this.options.assignedRouteService.getAssignedRoute({
      driverId: payload.driverId,
      routeContext: payload.routePlanId,
      shopDomain: payload.shopDomain
    });
    if (result.status !== 'ASSIGNED_ROUTE') {
      return null;
    }
    if (createRouteSequenceChecksum(result.route) !== payload.checksum) {
      return null;
    }

    return renderDriverRouteMapPreviewPng(result.route);
  }

  private encryptPayload(payload: PreviewPayload): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(payload), 'utf8'),
      cipher.final()
    ]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]).toString('base64url');
  }

  private decryptPayload(previewId: string): PreviewPayload | null {
    try {
      const payload = Buffer.from(previewId, 'base64url');
      if (payload.length <= 28) return null;
      const iv = payload.subarray(0, 12);
      const tag = payload.subarray(12, 28);
      const encrypted = payload.subarray(28);
      const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, iv);
      decipher.setAuthTag(tag);
      const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
      return readPreviewPayload(JSON.parse(decrypted));
    } catch {
      return null;
    }
  }

  private signPreviewUrl(previewId: string, expires: string): string {
    return createHmac('sha256', this.signingKey).update(`${previewId}.${expires}`).digest('base64url');
  }

  private isValidSignature(previewId: string, expires: string, signature: string): boolean {
    const expected = Buffer.from(this.signPreviewUrl(previewId, expires), 'utf8');
    const actual = Buffer.from(signature, 'utf8');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
}

export function createRouteSequenceChecksum(route: DriverAssignedRoute): string {
  const digest = createHash('sha256');
  digest.update(route.id);
  digest.update('\0');
  digest.update(DRIVER_ROUTE_MAP_PREVIEW_RENDERER_VERSION);
  digest.update('\0');
  digest.update(JSON.stringify(readStableRouteSequence(route)));
  return digest.digest('base64url');
}

function readStableRouteSequence(route: DriverAssignedRoute): Array<{
  deliveryStopId: string;
  latitude: number | null;
  longitude: number | null;
  sequence: number;
}> {
  return route.stops
    .map((stop) => ({
      deliveryStopId: stop.deliveryStopId,
      latitude: stop.coordinates.latitude,
      longitude: stop.coordinates.longitude,
      sequence: stop.sequence
    }))
    .sort((left, right) => left.sequence - right.sequence || left.deliveryStopId.localeCompare(right.deliveryStopId));
}

function createPurposeKey(secret: string, purpose: string): Buffer {
  return createHash('sha256').update(`${purpose}:${secret}`).digest();
}

function readPreviewPayload(value: unknown): PreviewPayload | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const payload = value as Record<string, unknown>;
  if (
    payload.version !== 1 ||
    typeof payload.checksum !== 'string' ||
    typeof payload.driverId !== 'string' ||
    typeof payload.routePlanId !== 'string' ||
    typeof payload.shopDomain !== 'string'
  ) {
    return null;
  }
  return {
    checksum: payload.checksum,
    driverId: payload.driverId,
    routePlanId: payload.routePlanId,
    shopDomain: payload.shopDomain,
    version: 1
  };
}
