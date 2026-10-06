import Fastify from 'fastify';
import { describe, expect, test, vi } from 'vitest';
import { redactSensitiveUrl } from '../src/app.js';
import { OriginalObservationsError } from '../src/modules/route-tracking/original-observations.service.js';
import { registerAdminRoutePlanRoutes, type AdminRoutePlanDependencies } from '../src/routes/admin-route-plans.routes.js';

const url = '/admin/route-plans/10000000-0000-4000-8000-000000000001/tracking/original-observations?from=2026-09-01T00:00:00Z&to=2026-09-02T00:00:00Z';
function harness(available = true) {
  const app = Fastify();
  const get = vi.fn().mockResolvedValue({ observations: [], page: { returned: 0 }, emptyReason: 'NO_OBSERVATIONS' });
  const verify = vi.fn().mockReturnValue({ appId: 'clever', shopDomain: 'example.myshopify.com', subject: 'admin' });
  registerAdminRoutePlanRoutes(app, {
    routePlanService: {} as AdminRoutePlanDependencies['routePlanService'],
    sessionTokenVerifier: { verify }, ...(available ? { originalObservationsService: { get } } : {})
  });
  return { app, get, verify };
}
describe('administrator original observations route', () => {
  test('requires administrator bearer authentication before read', async () => {
    const h = harness();
    try {
      expect((await h.app.inject({ url })).statusCode).toBe(401);
      h.verify.mockImplementation(() => { throw new Error('Invalid signature'); });
      expect((await h.app.inject({ url, headers: { authorization: 'Bearer bad-token' } })).statusCode).toBe(401);
      expect(h.get).not.toHaveBeenCalled();
    } finally { await h.app.close(); }
  });
  test('propagates verified tenant and app scope, with private-cache prohibition', async () => {
    const h = harness();
    try {
      const response = await h.app.inject({ url, headers: { authorization: 'Bearer valid-token', 'x-clever-app-id': 'clever' } });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).toMatchObject({ data: { observations: [], emptyReason: 'NO_OBSERVATIONS' }, error: null });
      expect(h.verify).toHaveBeenCalledWith('valid-token', { expectedAppId: 'clever' });
      expect(h.get).toHaveBeenCalledWith({ appId: 'clever', shopDomain: 'example.myshopify.com',
        routePlanId: '10000000-0000-4000-8000-000000000001', query: { from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z' } });
    } finally { await h.app.close(); }
  });
  test('hides missing and foreign routes behind the same 404', async () => {
    const h = harness(); h.get.mockResolvedValue(null);
    try {
      const response = await h.app.inject({ url, headers: { authorization: 'Bearer valid-token' } });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ data: null, error: { code: 'NOT_FOUND', message: 'Route plan not found' } });
    } finally { await h.app.close(); }
  });
  test.each([['INVALID_QUERY', 400], ['INVALID_CURSOR', 400], ['ASSIGNMENT_CHANGED', 409], ['READ_TIMEOUT', 503]] as const)(
    'maps %s to %i without reflecting request values', async (code, status) => {
      const h = harness(); h.get.mockRejectedValue(new OriginalObservationsError(code));
      try {
        const response = await h.app.inject({ url, headers: { authorization: 'Bearer valid-token' } });
        expect(response.statusCode).toBe(status);
        expect(response.json()).toMatchObject({ data: null, error: { code } });
      } finally { await h.app.close(); }
    }
  );
  test('reports absent dependency explicitly', async () => {
    const h = harness(false);
    try { expect((await h.app.inject({ url, headers: { authorization: 'Bearer valid-token' } })).statusCode).toBe(501); }
    finally { await h.app.close(); }
  });
  test('redacts route identifier and complete query from request logs', () => {
    expect(redactSensitiveUrl(`${url}&cursor=private&driverPhone=private`)).toBe('/admin/route-plans/[redacted]/tracking/original-observations');
  });
});
