import { describe, expect, test, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { signDriverAccountToken, signDriverRouteToken } from '../src/modules/driver/driver-token-verifier.js';
import { DsvInquiryError, type DsvDriverInquiryRepository } from '../src/modules/dsv/dsv-driver-inquiry.repository.js';

const secret = 'inquiry-route-test-secret-not-for-production';
const accountId = '81000000-0000-4000-8000-000000000011';
const id = '81000000-0000-4000-8000-000000000012';
const key = '81000000-0000-4000-8000-000000000013';
const root = '/api/dsv/driver/inquiries';
const inquiry = { id, title: '제목', body: '문의 내용', authorName: '서버 작성자', createdAt: new Date('2026-09-07T00:00:00.123Z') };
const token = signDriverAccountToken({ accountId, subject: accountId, tokenVersion: 3, expiresInSeconds: 900 }, { secret }).token;
const headers = { authorization: `Bearer ${token}`, 'idempotency-key': key };

async function harness(logLines?: string[]) {
  const repository = {
    create: vi.fn<DsvDriverInquiryRepository['create']>().mockResolvedValue({ inquiry, duplicate: false }),
    list: vi.fn<DsvDriverInquiryRepository['list']>().mockResolvedValue({ items: [inquiry], nextCursor: null }),
    detail: vi.fn<DsvDriverInquiryRepository['detail']>().mockResolvedValue({ inquiry }),
  };
  const app = await buildApp({
    dsvDriverAuth: { jwtSecret: secret, repository: {} as never, inquiryRepository: repository },
    ...(logLines === undefined ? {} : { logger: { level: 'error', stream: { write: (line: string) => logLines.push(line) } } }),
  });
  return { app, repository };
}

describe('DSV Driver inquiries HTTP contract', () => {
  test('creates plain-text inquiries with server author/time and replays the same request', async () => {
    const { app, repository } = await harness();
    try {
      const created = await app.inject({ method: 'POST', url: root, headers, payload: { title: ' 제목 ', body: ' 문의 내용\n' } });
      expect(created.statusCode).toBe(201);
      expect(created.headers['cache-control']).toBe('private, no-store');
      expect(created.json()).toEqual({ data: { inquiry: { ...inquiry, createdAt: inquiry.createdAt.toISOString() }, duplicate: false }, error: null });
      expect(repository.create).toHaveBeenCalledWith({ accountId, tokenVersion: 3 }, { title: '제목', body: '문의 내용', clientRequestId: key });
      repository.create.mockResolvedValueOnce({ inquiry, duplicate: true });
      expect((await app.inject({ method: 'POST', url: root, headers, payload: { title: '제목', body: '문의 내용' } })).statusCode).toBe(200);
      repository.create.mockRejectedValueOnce(new DsvInquiryError('IDEMPOTENCY_CONFLICT'));
      const conflict = await app.inject({ method: 'POST', url: root, headers, payload: { title: '다른 제목', body: '문의 내용' } });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toMatchObject({ data: null, error: { code: 'IDEMPOTENCY_CONFLICT' } });
    } finally { await app.close(); }
  });

  test.each([
    {}, { title: '', body: '내용' }, { title: '제목', body: ' ' }, { title: 1, body: '내용' },
    { title: '가'.repeat(121), body: '내용' }, { title: '제목', body: '가'.repeat(4001) },
    { title: '제목', body: '내용\u0000' }, { title: '제목', body: '내용', accountId },
    { title: '제목', body: '내용', authorName: 'spoof' }, { title: '제목', body: '내용', createdAt: '2020-01-01' },
  ])('rejects invalid or server-owned input %j', async (payload) => {
    const { app, repository } = await harness();
    try {
      expect((await app.inject({ method: 'POST', url: root, headers, payload })).statusCode).toBe(400);
      expect(repository.create).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  test('requires a UUID idempotency key and enforces size/rate limits', async () => {
    const { app, repository } = await harness();
    try {
      const payload = { title: '제목', body: '내용' };
      for (const value of ['', 'not-a-uuid']) {
        expect((await app.inject({ method: 'POST', url: root, headers: { ...headers, 'idempotency-key': value }, payload })).statusCode).toBe(400);
      }
      const oversized = await app.inject({ method: 'POST', url: root, headers, payload: { title: '제목', body: 'x'.repeat(25_000) } });
      expect(oversized.statusCode).toBe(413);
      expect(oversized.headers['cache-control']).toBe('private, no-store');
      expect(oversized.json()).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } });
      for (let attempt = 0; attempt < 7; attempt++) await app.inject({ method: 'POST', url: root, headers, payload });
      const limited = await app.inject({ method: 'POST', url: root, headers, payload });
      expect(limited.statusCode).toBe(429);
      expect(limited.headers['cache-control']).toBe('private, no-store');
      expect(limited.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
      expect(repository.create.mock.calls.length).toBeLessThanOrEqual(8);
    } finally { await app.close(); }
  });

  test('keeps malformed JSON responses private and non-cacheable', async () => {
    const { app, repository } = await harness();
    try {
      const response = await app.inject({
        method: 'POST',
        url: root,
        headers: { ...headers, 'content-type': 'application/json' },
        payload: '{"title":',
      });
      expect(response.statusCode).toBe(400);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.json()).toMatchObject({ error: { code: 'INVALID_JSON' } });
      expect(repository.create).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  test('rejects missing, expired, wrong-audience, malformed and revoked tokens for every operation', async () => {
    const { app, repository } = await harness();
    const expired = signDriverAccountToken({ accountId, subject: accountId, expiresInSeconds: 1 }, { secret, now: new Date('2020-01-01') }).token;
    const route = signDriverRouteToken({ accountId, subject: accountId, routePlanId: id, expiresInSeconds: 900 }, { secret }).token;
    try {
      for (const authorization of ['', 'Bearer invalid', `Bearer ${expired}`, `Bearer ${route}`]) {
        for (const [method, url] of [['POST', root], ['GET', root], ['GET', `${root}/${id}`]] as const) {
          expect((await app.inject({ method, url, headers: { ...headers, authorization }, ...(method === 'POST' ? { payload: { title: '제목', body: '내용' } } : {}) })).statusCode).toBe(401);
        }
      }
      expect(repository.create).not.toHaveBeenCalled();
      expect(repository.list).not.toHaveBeenCalled();
      expect(repository.detail).not.toHaveBeenCalled();
      repository.list.mockRejectedValueOnce(new DsvInquiryError('UNAUTHORIZED'));
      expect((await app.inject({ method: 'GET', url: root, headers })).statusCode).toBe(401);
    } finally { await app.close(); }
  });

  test('paginates own inquiries and does not expose foreign or missing ids', async () => {
    const { app, repository } = await harness();
    try {
      const cursor = Buffer.from(JSON.stringify({ id, createdAt: inquiry.createdAt.toISOString() })).toString('base64url');
      const list = await app.inject({ method: 'GET', url: `${root}?limit=1&cursor=${cursor}`, headers });
      expect(list.statusCode).toBe(200);
      expect(list.headers['cache-control']).toBe('private, no-store');
      expect(repository.list).toHaveBeenCalledWith({ accountId, tokenVersion: 3 }, { id, createdAt: inquiry.createdAt }, 1);
      repository.detail.mockRejectedValue(new DsvInquiryError('NOT_FOUND'));
      const detail = await app.inject({ method: 'GET', url: `${root}/${id}`, headers });
      expect(detail.statusCode).toBe(404);
      expect(detail.headers['cache-control']).toBe('private, no-store');
      expect(detail.json()).toEqual({ data: null, error: { code: 'NOT_FOUND', message: 'NOT_FOUND' } });
      for (const query of ['accountId=other', 'limit=0', 'limit=51', 'limit=1&limit=2', 'limit=1e1', 'cursor=@@', 'cursor=e30', 'cursor=']) {
        expect((await app.inject({ method: 'GET', url: `${root}?${query}`, headers })).statusCode).toBe(400);
      }
      for (const createdAt of ['0000-01-01T00:00:00.000Z', '+275760-09-13T00:00:00.000Z', '-271821-04-20T00:00:00.000Z']) {
        const invalidCursor = Buffer.from(JSON.stringify({ id, createdAt })).toString('base64url');
        expect((await app.inject({ method: 'GET', url: `${root}?cursor=${invalidCursor}`, headers })).statusCode).toBe(400);
      }
      expect((await app.inject({ method: 'GET', url: `${root}/${id}?accountId=other`, headers })).statusCode).toBe(400);
    } finally { await app.close(); }
  });

  test('does not return or log private database error text', async () => {
    const privateText = 'Private inquiry body and author sentinel';
    const logs: string[] = [];
    const { app, repository } = await harness(logs);
    try {
      repository.create.mockRejectedValueOnce(Object.assign(new Error(privateText), { code: 'P2021', name: 'PrivateCreateError', privateMetadata: 'create-secret' }));
      repository.list.mockRejectedValueOnce(Object.assign(new Error(privateText), { code: 'P1001', name: 'PrivateListError', privateMetadata: 'list-secret' }));
      repository.detail.mockRejectedValueOnce(Object.assign(new Error(privateText), { code: 'unsafe-code', name: 'PrivateDetailError', privateMetadata: 'detail-secret' }));
      const responses = await Promise.all([
        app.inject({ method: 'POST', url: root, headers, payload: { title: '제목', body: '내용' } }),
        app.inject({ method: 'GET', url: root, headers }),
        app.inject({ method: 'GET', url: `${root}/${id}`, headers }),
      ]);
      for (const response of responses) {
        expect(response.statusCode).toBe(500);
        expect(response.headers['cache-control']).toBe('private, no-store');
        expect(response.json()).toMatchObject({ data: null, error: { code: 'INTERNAL_SERVER_ERROR' } });
      }
      const serialized = `${responses.map(response => response.body).join('\n')}\n${logs.join('\n')}`;
      expect(serialized).not.toContain(privateText);
      expect(serialized).not.toMatch(/Private(Create|List|Detail)Error|(?:create|list|detail)-secret|unsafe-code/u);
      expect(serialized).toContain('P1001');
      expect(serialized).toContain('P2021');
      expect(serialized).toContain('PrismaKnownRequestError');
      expect(serialized).toContain('UNKNOWN');
      expect(logs.join('\n')).not.toContain('unexpected_request_error');
      expect(logs.filter(line => line.includes('dsv_inquiry_request_failed'))).toHaveLength(3);
    } finally { await app.close(); }
  });
});
