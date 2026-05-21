import { createHmac } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import {
  DriverProofMediaAccessUnavailableError,
  DriverProofMediaScanRejectedError,
  DriverProofMediaScopeError
} from '../src/modules/driver/driver-proof-media.types.js';
import type { DriverApiDependencies } from '../src/routes/driver-events.routes.js';

const secret = 'driver-secret';
const now = new Date('2026-05-12T10:00:00.000Z');
const uploadBytes = Buffer.from('synthetic-proof-photo');

describe('Driver proof media route', () => {
  test('returns short-lived proof media read access for the authenticated driver', async () => {
    const { app, createProofMediaReadAccess } = await createAppHarness();

    try {
      const response = await app.inject({
        headers: {
          authorization: `Bearer ${driverToken()}`
        },
        method: 'GET',
        url: '/driver/proof-media/proof-media-id/access'
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        data: {
          contentType: 'image/jpeg',
          expiresAt: '2026-05-12T10:05:00.000Z',
          kind: 'photo',
          mediaId: 'proof-media-id',
          url: 'https://proof-media.example.test/signed/proof-media-id'
        },
        error: null
      });
      expect(createProofMediaReadAccess).toHaveBeenCalledWith({
        driverId: 'driver-id',
        mediaId: 'proof-media-id',
        shopDomain: 'tomatono.myshopify.com'
      });
    } finally {
      await app.close();
    }
  });

  test('maps proof media read scope rejection to a safe forbidden response', async () => {
    const { app, createProofMediaReadAccess } = await createAppHarness({ rejectAccessScope: true });

    try {
      const response = await app.inject({
        headers: {
          authorization: `Bearer ${driverToken()}`
        },
        method: 'GET',
        url: '/driver/proof-media/proof-media-id/access'
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'FORBIDDEN', message: 'Proof media route scope rejected' }
      });
      expect(createProofMediaReadAccess).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  test('maps missing proof media read backend support to service unavailable', async () => {
    const { app, createProofMediaReadAccess } = await createAppHarness({ rejectAccessUnavailable: true });

    try {
      const response = await app.inject({
        headers: {
          authorization: `Bearer ${driverToken()}`
        },
        method: 'GET',
        url: '/driver/proof-media/proof-media-id/access'
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'PROOF_MEDIA_ACCESS_UNAVAILABLE', message: 'Proof media access is not configured' }
      });
      expect(createProofMediaReadAccess).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  test('rejects proof media uploads without a driver bearer token', async () => {
    const { app, storeProofMedia } = await createAppHarness();

    try {
      const response = await app.inject({
        ...multipartUploadRequest(),
        method: 'POST',
        url: '/driver/proof-media'
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'UNAUTHORIZED', message: 'Missing driver bearer token' }
      });
      expect(storeProofMedia).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('stores an authenticated proof photo upload and returns durable media evidence', async () => {
    const { app, storeProofMedia } = await createAppHarness();

    try {
      const response = await app.inject({
        ...multipartUploadRequest(),
        headers: {
          ...multipartUploadRequest().headers,
          authorization: `Bearer ${driverToken()}`
        },
        method: 'POST',
        url: '/driver/proof-media'
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({
        data: {
          kind: 'photo',
          mediaId: 'proof-media-id',
          storageKey: 'driver-proof/tomatono.myshopify.com/route-plan-id/stop-id/proof-media-id.jpg',
          contentType: 'image/jpeg',
          source: 'camera',
          uploadedAt: '2026-05-12T10:00:00.000Z',
          sizeBytes: uploadBytes.byteLength,
          sha256: 'sha256-fixture'
        },
        error: null
      });
      expect(storeProofMedia).toHaveBeenCalledWith({
        contentType: 'image/jpeg',
        deliveryStopId: 'stop-id',
        driverId: 'driver-id',
        fileBytes: uploadBytes,
        filename: 'proof.jpg',
        routePlanId: 'route-plan-id',
        shopDomain: 'tomatono.myshopify.com',
        source: 'camera'
      });
    } finally {
      await app.close();
    }
  });

  test('rejects non-image proof media content before storage', async () => {
    const { app, storeProofMedia } = await createAppHarness();

    try {
      const response = await app.inject({
        ...multipartUploadRequest({ contentType: 'text/plain' }),
        headers: {
          ...multipartUploadRequest({ contentType: 'text/plain' }).headers,
          authorization: `Bearer ${driverToken()}`
        },
        method: 'POST',
        url: '/driver/proof-media'
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'BAD_REQUEST', message: 'Invalid proof media upload payload' }
      });
      expect(storeProofMedia).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  test('maps route or stop scope rejection to a safe forbidden response', async () => {
    const { app, storeProofMedia } = await createAppHarness({ rejectStorage: true });

    try {
      const response = await app.inject({
        ...multipartUploadRequest(),
        headers: {
          ...multipartUploadRequest().headers,
          authorization: `Bearer ${driverToken()}`
        },
        method: 'POST',
        url: '/driver/proof-media'
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'FORBIDDEN', message: 'Proof media route scope rejected' }
      });
      expect(storeProofMedia).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  test('maps scanner-rejected proof media to a safe unprocessable response', async () => {
    const { app, storeProofMedia } = await createAppHarness({ rejectScan: true });

    try {
      const response = await app.inject({
        ...multipartUploadRequest(),
        headers: {
          ...multipartUploadRequest().headers,
          authorization: `Bearer ${driverToken()}`
        },
        method: 'POST',
        url: '/driver/proof-media'
      });

      expect(response.statusCode).toBe(422);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'PROOF_MEDIA_REJECTED', message: 'Proof media rejected by safety scan' }
      });
      expect(storeProofMedia).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  test('rejects unsupported proof media sources before storage', async () => {
    const { app, storeProofMedia } = await createAppHarness();

    try {
      const response = await app.inject({
        ...multipartUploadRequest({ source: 'scanner' }),
        headers: {
          ...multipartUploadRequest({ source: 'scanner' }).headers,
          authorization: `Bearer ${driverToken()}`
        },
        method: 'POST',
        url: '/driver/proof-media'
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        data: null,
        error: { code: 'BAD_REQUEST', message: 'Invalid proof media upload payload' }
      });
      expect(storeProofMedia).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

type StoreProofMedia = (input: {
  contentType: string;
  deliveryStopId: string;
  driverId: string;
  fileBytes: Buffer;
  filename: string;
  routePlanId: string;
  shopDomain: string;
  source: 'camera' | 'library';
}) => Promise<{
  contentType: string;
  kind: 'photo';
  mediaId: string;
  sha256: string;
  sizeBytes: number;
  source: 'camera' | 'library';
  storageKey: string;
  uploadedAt: string;
}>;

type CreateProofMediaReadAccess = (input: {
  driverId: string;
  mediaId: string;
  shopDomain: string;
}) => Promise<{
  contentType: string;
  expiresAt: string;
  kind: 'photo';
  mediaId: string;
  url: string;
}>;

type ProofMediaDependencies = DriverApiDependencies & {
  proofMediaService: {
    createProofMediaReadAccess: CreateProofMediaReadAccess;
    storeProofMedia: StoreProofMedia;
  };
};

async function createAppHarness(input: {
  rejectAccessScope?: boolean;
  rejectAccessUnavailable?: boolean;
  rejectScan?: boolean;
  rejectStorage?: boolean;
} = {}): Promise<{
  app: Awaited<ReturnType<typeof buildApp>>;
  createProofMediaReadAccess: ReturnType<typeof vi.fn<CreateProofMediaReadAccess>>;
  storeProofMedia: ReturnType<typeof vi.fn<StoreProofMedia>>;
}> {
  const createProofMediaReadAccess = vi.fn<CreateProofMediaReadAccess>(() => {
    if (input.rejectAccessScope === true) {
      return Promise.reject(new DriverProofMediaScopeError('Proof media not found for driver'));
    }
    if (input.rejectAccessUnavailable === true) {
      return Promise.reject(new DriverProofMediaAccessUnavailableError());
    }

    return Promise.resolve({
      contentType: 'image/jpeg',
      expiresAt: '2026-05-12T10:05:00.000Z',
      kind: 'photo',
      mediaId: 'proof-media-id',
      url: 'https://proof-media.example.test/signed/proof-media-id'
    });
  });
  const storeProofMedia = vi.fn<StoreProofMedia>(() => {
    if (input.rejectStorage === true) {
      return Promise.reject(new DriverProofMediaScopeError('Route plan not assigned to driver'));
    }
    if (input.rejectScan === true) {
      return Promise.reject(new DriverProofMediaScanRejectedError('eicar-test-signature'));
    }

    return Promise.resolve({
      contentType: 'image/jpeg',
      kind: 'photo',
      mediaId: 'proof-media-id',
      sha256: 'sha256-fixture',
      sizeBytes: uploadBytes.byteLength,
      source: 'camera',
      storageKey: 'driver-proof/tomatono.myshopify.com/route-plan-id/stop-id/proof-media-id.jpg',
      uploadedAt: '2026-05-12T10:00:00.000Z'
    });
  });

  const dependencies: ProofMediaDependencies = {
    driverEventService: {
      recordDriverEvent: vi.fn(() => Promise.resolve({ duplicate: false, eventId: 'unused' }))
    },
    jwtSecret: secret,
    now: () => now,
    proofMediaService: {
      createProofMediaReadAccess,
      storeProofMedia
    }
  };

  const app = await buildApp({ driverApi: dependencies });
  return { app, createProofMediaReadAccess, storeProofMedia };
}

function multipartUploadRequest(input: { contentType?: string; source?: string } = {}): {
  headers: Record<string, string>;
  payload: Buffer;
} {
  const boundary = 'proof-media-boundary';
  const source = input.source ?? 'camera';
  const contentType = input.contentType ?? 'image/jpeg';
  const chunks = [
    fieldPart(boundary, 'deliveryStopId', 'stop-id'),
    fieldPart(boundary, 'routePlanId', 'route-plan-id'),
    fieldPart(boundary, 'source', source),
    Buffer.from(
      `--${boundary}\r\n` +
        'Content-Disposition: form-data; name="file"; filename="proof.jpg"\r\n' +
        `Content-Type: ${contentType}\r\n\r\n`,
      'utf8'
    ),
    uploadBytes,
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
  ];

  return {
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`
    },
    payload: Buffer.concat(chunks)
  };
}

function fieldPart(boundary: string, name: string, value: string): Buffer {
  return Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    'utf8'
  );
}

function driverToken(): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    aud: 'clever-delivery-driver',
    driverId: 'driver-id',
    exp: Math.floor(now.getTime() / 1000) + 60,
    iat: Math.floor(now.getTime() / 1000),
    shopDomain: 'tomatono.myshopify.com',
    sub: 'driver-auth-subject',
    tokenVersion: 0
  };
  const encodedHeader = Buffer.from(JSON.stringify(header), 'utf8').toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac('sha256', secret).update(signingInput).digest('base64url');

  return `${signingInput}.${signature}`;
}
