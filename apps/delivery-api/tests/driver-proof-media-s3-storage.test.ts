import { createHash } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';

import { createS3DriverProofMediaStorage } from '../src/modules/driver/driver-proof-media-s3-storage.js';

const awsExampleAccessKeyId = 'AKIAIOSFODNN7EXAMPLE';
const awsExampleSecretAccessKey = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

describe('createS3DriverProofMediaStorage', () => {
  test('creates AWS-compatible SigV4 presigned GET URLs for proof media read access', async () => {
    const storage = createS3DriverProofMediaStorage({
      accessKeyId: awsExampleAccessKeyId,
      bucket: 'examplebucket',
      endpoint: 'https://s3.amazonaws.com',
      forcePathStyle: false,
      now: () => new Date('2013-05-24T00:00:00.000Z'),
      region: 'us-east-1',
      secretAccessKey: awsExampleSecretAccessKey
    });

    const result = await storage.createReadAccess?.({
      contentType: 'text/plain',
      expiresAt: new Date('2013-05-25T00:00:00.000Z'),
      storageKey: 'test.txt'
    });

    expect(result?.url).toBe(
      'https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404'
    );
  });

  test('writes proof media bytes with SigV4 header authentication', async () => {
    const calls: { init: RequestInit | undefined; url: string }[] = [];
    const fetchMock = vi.fn((url: string | URL, init?: RequestInit) => {
      calls.push({ init, url: String(url) });
      return Promise.resolve(new Response('', { status: 200 }));
    });
    const storage = createS3DriverProofMediaStorage({
      accessKeyId: 'AKIA_TEST',
      bucket: 'clever-proof-media',
      endpoint: 'https://objects.example.test',
      fetch: fetchMock,
      forcePathStyle: true,
      now: () => new Date('2026-05-12T10:00:00.000Z'),
      region: 'ap-northeast-2',
      secretAccessKey: 'secret-test-key'
    });
    const fileBytes = Buffer.from('synthetic-proof-photo');

    await storage.write({
      fileBytes,
      storageKey: 'driver-proof/tomatono.myshopify.com/route-plan-id/stop-id/proof.jpg'
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      'https://objects.example.test/clever-proof-media/driver-proof/tomatono.myshopify.com/route-plan-id/stop-id/proof.jpg'
    );
    expect(calls[0]?.init?.method).toBe('PUT');
    expect(calls[0]?.init?.body).toEqual(fileBytes);
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers['x-amz-date']).toBe('20260512T100000Z');
    expect(headers['x-amz-content-sha256']).toBe(createHash('sha256').update(fileBytes).digest('hex'));
    expect(headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIA_TEST\/20260512\/ap-northeast-2\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[a-f0-9]{64}$/u
    );
    expect(headers.authorization).not.toContain('secret-test-key');
  });

  test('removes proof media through S3 DELETE and treats 404 as already missing', async () => {
    const methods: string[] = [];
    const fetchMock = vi.fn((_url: string | URL, init?: RequestInit) => {
      methods.push(String(init?.method));
      return Promise.resolve(new Response('', { status: 404 }));
    });
    const storage = createS3DriverProofMediaStorage({
      accessKeyId: 'AKIA_TEST',
      bucket: 'clever-proof-media',
      endpoint: 'https://objects.example.test',
      fetch: fetchMock,
      forcePathStyle: true,
      now: () => new Date('2026-05-12T10:00:00.000Z'),
      region: 'ap-northeast-2',
      secretAccessKey: 'secret-test-key'
    });

    await expect(storage.remove('driver-proof/tomatono.myshopify.com/route-plan-id/stop-id/proof.jpg')).resolves.toBe('missing');
    expect(methods).toEqual(['DELETE']);
  });
});
