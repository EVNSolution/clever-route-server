import { describe, expect, test, vi } from 'vitest';

import {
  createHttpDriverProofMediaScanMonitor,
  createHttpDriverProofMediaScanner
} from '../src/modules/driver/driver-proof-media-http-scanner.js';

const fileBytes = Buffer.from('sanitized-proof-photo');

describe('HTTP driver proof-media scanner adapters', () => {
  test('posts sanitized proof media bytes and metadata headers to the scanner endpoint', async () => {
    const calls: { init: RequestInit | undefined; url: string }[] = [];
    const fetchMock = vi.fn((url: string | URL, init?: RequestInit) => {
      calls.push({ init, url: String(url) });
      return Promise.resolve(new Response(JSON.stringify({ status: 'clean' }), { status: 200 }));
    });
    const scanner = createHttpDriverProofMediaScanner({
      bearerToken: 'scanner-token',
      fetch: fetchMock,
      url: 'https://scanner.internal.example/scan'
    });

    await expect(scanner.scanProofMedia({
      contentType: 'image/jpeg',
      fileBytes,
      sha256: 'sha256-fixture',
      storageKey: 'driver-proof/shop/route/stop/proof.jpg'
    })).resolves.toEqual({ status: 'clean' });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://scanner.internal.example/scan');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.body).toEqual(fileBytes);
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer scanner-token');
    expect(headers['content-type']).toBe('image/jpeg');
    expect(headers['x-clever-proof-media-sha256']).toBe('sha256-fixture');
    expect(headers['x-clever-proof-media-storage-key']).toBe('driver-proof/shop/route/stop/proof.jpg');
  });

  test('maps scanner rejection responses to private rejection reasons', async () => {
    const scanner = createHttpDriverProofMediaScanner({
      fetch: () => Promise.resolve(new Response(JSON.stringify({ reason: 'scanner-fixture', status: 'rejected' }), { status: 200 })),
      url: 'https://scanner.internal.example/scan'
    });

    await expect(scanner.scanProofMedia({
      contentType: 'image/png',
      fileBytes,
      sha256: 'sha256-fixture',
      storageKey: 'driver-proof/shop/route/stop/proof.png'
    })).resolves.toEqual({ reason: 'scanner-fixture', status: 'rejected' });
  });

  test('posts scan monitor outcomes as sanitized JSON without proof bytes', async () => {
    const calls: { init: RequestInit | undefined; url: string }[] = [];
    const monitor = createHttpDriverProofMediaScanMonitor({
      bearerToken: 'monitor-token',
      fetch: (url: string | URL, init?: RequestInit) => {
        calls.push({ init, url: String(url) });
        return Promise.resolve(new Response('', { status: 202 }));
      },
      url: 'https://alerts.internal.example/proof-media-scan'
    });

    await monitor.recordProofMediaScan({
      contentType: 'image/jpeg',
      mediaId: 'media-id',
      reason: 'scanner-fixture',
      scannedAt: new Date('2026-05-12T10:00:00.000Z'),
      sha256: 'sha256-fixture',
      status: 'rejected',
      storageKey: 'driver-proof/shop/route/stop/proof.jpg'
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://alerts.internal.example/proof-media-scan');
    expect(calls[0]?.init?.method).toBe('POST');
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer monitor-token');
    expect(headers['content-type']).toBe('application/json');
    const body = calls[0]?.init?.body;
    if (typeof body !== 'string') {
      throw new Error('Expected scan monitor request body to be JSON text');
    }
    const payload = JSON.parse(body) as Record<string, unknown>;
    expect(payload).toEqual({
      contentType: 'image/jpeg',
      mediaId: 'media-id',
      reason: 'scanner-fixture',
      scannedAt: '2026-05-12T10:00:00.000Z',
      sha256: 'sha256-fixture',
      status: 'rejected',
      storageKey: 'driver-proof/shop/route/stop/proof.jpg'
    });
    expect(payload).not.toHaveProperty('fileBytes');
  });
});
