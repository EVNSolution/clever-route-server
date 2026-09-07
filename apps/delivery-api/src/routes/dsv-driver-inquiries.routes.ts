import type { FastifyInstance, FastifyReply, FastifyRequest, onSendHookHandler } from 'fastify';
import { verifyDriverAccountToken } from '../modules/driver/driver-token-verifier.js';
import { DsvInquiryError, type DsvInquiryScope, type DsvInquiryCursor, type DsvDriverInquiryRepository } from '../modules/dsv/dsv-driver-inquiry.repository.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
export const dsvInquiryNoStore: onSendHookHandler = (_request, reply, payload, done) => {
  reply.header('Cache-Control', 'private, no-store');
  done(null, payload);
};

export function registerDsvDriverInquiryRoutes(app: FastifyInstance, repository: DsvDriverInquiryRepository, secret: string) {
  async function authenticated(request: FastifyRequest, reply: FastifyReply, action: (scope: DsvInquiryScope) => Promise<unknown>) {
    reply.header('Cache-Control', 'private, no-store');
    const bearer = request.headers.authorization?.match(/^Bearer (\S+)$/u)?.[1];
    let scope: DsvInquiryScope;
    try {
      if (bearer === undefined) throw new Error('missing');
      const token = verifyDriverAccountToken(bearer, { secret });
      if (!uuid.test(token.accountId)) throw new Error('invalid account');
      scope = { accountId: token.accountId, tokenVersion: token.tokenVersion };
    } catch { return failure(reply, 401, 'UNAUTHORIZED'); }
    try { return await action(scope); } catch (error) {
      if (error instanceof DsvInquiryError) return failure(reply, error.code === 'UNAUTHORIZED' ? 401 : error.code === 'NOT_FOUND' ? 404 : 409, error.code);
      return sendDsvInquiryUnexpectedError(request, reply, error);
    }
  }

  app.post('/api/dsv/driver/inquiries', { bodyLimit: 24_000, config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, onSend: dsvInquiryNoStore }, async (request, reply) =>
    authenticated(request, reply, async (scope) => {
      const body = object(request.body);
      const title = typeof body?.title === 'string' ? body.title.trim() : '';
      const content = typeof body?.body === 'string' ? body.body.trim() : '';
      const clientRequestId = request.headers['idempotency-key'];
      if (body === null || Object.keys(body).some(k => k !== 'title' && k !== 'body') || title.length < 1 || title.length > 120 || content.length < 1 || content.length > 4000 || title.includes('\u0000') || content.includes('\u0000') || typeof clientRequestId !== 'string' || !uuid.test(clientRequestId)) {
        return failure(reply, 400, 'BAD_REQUEST');
      }
      const result = await repository.create(scope, { title, body: content, clientRequestId });
      return reply.code(result.duplicate ? 200 : 201).send({ data: result, error: null });
    }));

  app.get('/api/dsv/driver/inquiries', { onSend: dsvInquiryNoStore }, async (request, reply) => authenticated(request, reply, async (scope) => {
    const page = readDsvInquiryPage(request.query);
    if (page === null) return failure(reply, 400, 'BAD_REQUEST');
    return reply.send({ data: await repository.list(scope, page.before, page.limit), error: null });
  }));

  app.get<{ Params: { id: string } }>('/api/dsv/driver/inquiries/:id', { onSend: dsvInquiryNoStore }, async (request, reply) => authenticated(request, reply, async (scope) => {
    if (!uuid.test(request.params.id) || Object.keys(object(request.query) ?? {}).length !== 0) return failure(reply, 400, 'BAD_REQUEST');
    return reply.send({ data: await repository.detail(scope, request.params.id), error: null });
  }));
}

export function readDsvInquiryPage(value: unknown): { before: DsvInquiryCursor | null; limit: number } | null {
  const query = object(value);
  if (query === null || Object.keys(query).some(k => k !== 'cursor' && k !== 'limit')) return null;
  if (query.limit !== undefined && (typeof query.limit !== 'string' || !/^[1-9][0-9]?$/u.test(query.limit))) return null;
  const limit = query.limit === undefined ? 20 : Number(query.limit);
  if (limit > 50) return null;
  if (query.cursor === undefined) return { before: null, limit };
  try {
    if (typeof query.cursor !== 'string' || query.cursor.length > 300 || !/^[A-Za-z0-9_-]+$/u.test(query.cursor)) return null;
    const cursor = object(JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')) as unknown);
    if (cursor === null || Object.keys(cursor).some(k => k !== 'id' && k !== 'createdAt') || typeof cursor.id !== 'string' || !uuid.test(cursor.id) || typeof cursor.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(cursor.createdAt)) return null;
    const createdAt = new Date(cursor.createdAt);
    if (!Number.isFinite(createdAt.valueOf()) || createdAt.getUTCFullYear() < 1 || createdAt.toISOString() !== cursor.createdAt) return null;
    return { before: { id: cursor.id, createdAt }, limit };
  } catch { return null; }
}

export function sendDsvInquiryUnexpectedError(request: FastifyRequest, reply: FastifyReply, error: unknown) {
  const dbCode = readPrismaErrorCode(error);
  request.log.error({
    dbCode,
    event: 'dsv_inquiry_request_failed',
    failureKind: dbCode === null ? 'UNKNOWN' : 'PrismaKnownRequestError',
    requestId: request.id,
    route: request.routeOptions.url,
  }, 'DSV inquiry request failed');
  return failure(reply, 500, 'INTERNAL_SERVER_ERROR');
}

function readPrismaErrorCode(error: unknown): string | null {
  try {
    if (typeof error !== 'object' || error === null || !('code' in error)) return null;
    return typeof error.code === 'string' && /^P\d{4}$/u.test(error.code) ? error.code : null;
  } catch { return null; }
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function failure(reply: FastifyReply, status: number, code: string) {
  return reply.code(status).send({ data: null, error: { code, message: code } });
}
