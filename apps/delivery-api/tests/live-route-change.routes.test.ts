import { describe, expect, test, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { LiveRouteChangeError } from '../src/modules/route-plans/live-route-change.service.js';
import type { AdminRoutePlanDependencies } from '../src/routes/admin-route-plans.routes.js';

const routePlanId = '60000000-0000-4000-8000-000000000001';
const command = {
  commandId: '80000000-0000-4000-8000-000000000003',
  expectedAssignmentGeneration: '2',
  expectedRouteVersionId: '60000000-0000-4000-8000-000000000002',
  expectedRevision: 3
};
const headers = { authorization: 'Bearer synthetic-session', 'x-clever-app-id': 'clever-route-kfood' };
const url = `/admin/route-plans/${routePlanId}/live-change/discard`;

function harness() {
  const draft = {
    routePlanId, revision: 4, assignmentGeneration: '2', expectedRouteVersionId: command.expectedRouteVersionId,
    publishedVersionId: '90000000-0000-4000-8000-000000000001', hasUnpublishedChanges: false,
    editableFutureStopIds: [], draft: { schemaVersion: 1 as const, stops: [] }
  };
  const discardAdminDraft = vi.fn<NonNullable<AdminRoutePlanDependencies['liveRouteChangeService']>['discardAdminDraft']>()
    .mockResolvedValue(draft);
  const unused = () => Promise.reject(new Error('Unexpected service call'));
  const dependencies: AdminRoutePlanDependencies = {
    sessionTokenVerifier: { verify: () => ({ appId: 'clever-route-kfood', shopDomain: '7hrud1-xq.myshopify.com', subject: 'synthetic-admin' }) },
    liveRouteChangeService: { getAdminDraft: unused, saveAdminDraft: unused, dispatchAdminDraft: unused, discardAdminDraft },
    routePlanService: {
      assignRoutePlanDriver: unused, createRoutePlan: unused, deleteRoutePlan: unused, getRoutePlanDetail: unused,
      listRoutePlans: unused, publishRoutePlan: unused, updateRoutePlanOptions: unused, updateRoutePlanStops: unused
    }
  };
  return { dependencies, discardAdminDraft, draft };
}

describe('live route private draft discard HTTP boundary', () => {
  test('uses authenticated tenant scope and returns the restored draft without publishing', async () => {
    const { dependencies, discardAdminDraft, draft } = harness();
    const app = await buildApp({ adminRoutePlans: dependencies });
    try {
      const response = await app.inject({ method: 'POST', url, headers, payload: command });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.json()).toEqual({ data: draft, error: null });
      expect(discardAdminDraft).toHaveBeenCalledExactlyOnceWith({ ...command, routePlanId, appId: 'clever-route-kfood', shopDomain: '7hrud1-xq.myshopify.com' });
    } finally { await app.close(); }
  });

  test('rejects unauthenticated discard before invoking the service', async () => {
    const { dependencies, discardAdminDraft } = harness();
    const app = await buildApp({ adminRoutePlans: dependencies });
    try {
      expect((await app.inject({ method: 'POST', url, payload: command })).statusCode).toBe(401);
      expect(discardAdminDraft).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  test.each([
    { ...command, shopId: 'foreign-tenant' },
    { ...command, expectedAssignmentGeneration: '02' },
    { ...command, expectedRevision: '3' },
    { ...command, expectedRouteVersionId: 'unknown' },
    { ...command, commandId: null }
  ])('rejects malformed or tenant-selecting command bodies', async payload => {
    const { dependencies, discardAdminDraft } = harness();
    const app = await buildApp({ adminRoutePlans: dependencies });
    try {
      const response = await app.inject({ method: 'POST', url, headers, payload });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ data: null, error: { code: 'BAD_REQUEST' } });
      expect(discardAdminDraft).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  test('preserves revision conflict status and error for explicit recovery', async () => {
    const { dependencies, discardAdminDraft } = harness();
    discardAdminDraft.mockRejectedValueOnce(new LiveRouteChangeError('REVISION_CONFLICT', 409, 'Draft revision has changed'));
    const app = await buildApp({ adminRoutePlans: dependencies });
    try {
      const response = await app.inject({ method: 'POST', url, headers, payload: command });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ data: null, error: { code: 'REVISION_CONFLICT', message: 'Draft revision has changed' } });
    } finally { await app.close(); }
  });
});
