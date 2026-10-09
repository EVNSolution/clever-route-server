import { describe, expect, test, vi } from 'vitest';
import { readCashSettlementCommand } from '../src/modules/payments/cash-settlement.service.js';
import { assertDeliveryOptionsEditable, assertProofDriverCompatible, readDeliveryProof } from '../src/modules/route-plans/delivery-options.js';
import { validateDriverDeliveryProof } from '../src/modules/driver/driver-delivery-proof.js';
import { buildApp } from '../src/app.js';
import { signDriverAccountToken } from '../src/modules/driver/driver-token-verifier.js';
const anyDateMatcher: unknown = expect.any(Date);
const command = { commandId: '11111111-1111-4111-8111-111111111111', receiptId: '22222222-2222-4222-8222-222222222222', expectedRevision: 0, confirmedAmount: '0', currency: 'CAD' };
describe('KFood office and delivery option contracts', () => {
  test('money preserves zero, normalizes decimals and requires correction reasons', () => {
    expect(readCashSettlementCommand(command).confirmedAmount).toBe('0.00');
    expect(readCashSettlementCommand({ ...command, confirmedAmount: '122.25', expectedRevision: 1, reason: 'Counting correction' }).reason).toBe('Counting correction');
    for (const patch of [{ confirmedAmount: -1 }, { confirmedAmount: '-1' }, { confirmedAmount: '1e2' }, { confirmedAmount: '1.111' }, { expectedRevision: undefined }, { expectedRevision: 1 }, { expectedRevision: 1, reason: ' ' }]) {
      expect(() => readCashSettlementCommand({ ...command, ...patch })).toThrow();
    }
  });
  test('proof defaults OFF and assigned, published or active routes cannot change policy', () => {
    expect(readDeliveryProof(null)).toEqual({ photoRequired: false, signatureRequired: false });
    expect(() => assertDeliveryOptionsEditable({ status: 'READY', driverId: null, constraints: {} })).not.toThrow();
    for (const route of [{ status: 'IN_PROGRESS', driverId: null, constraints: {} }, { status: 'READY', driverId: 'driver', constraints: {} }, { status: 'READY', constraints: { cleverDispatchReservedAt: 'now' } }]) expect(() => assertDeliveryOptionsEditable(route)).toThrow(/DELIVERY_OPTIONS_LOCKED/);
  });
  test('Dispatch accepts one compatible live account session despite an older second device', async () => {
    const old = process.env.KFOOD_DELIVERY_PROOF_ENABLED;
    process.env.KFOOD_DELIVERY_PROOF_ENABLED = 'true';
    const good = { deliveryProofCapability: 'delivery-proof-v1', capabilityVersionCode: 43, capabilityPackageId: 'com.evnsolution.clever.routes', capabilityTokenVersion: 1 };
    const sessions = vi.fn().mockResolvedValue([good]);
    const tx = { driver: { findFirst: vi.fn().mockResolvedValue({ account: { id: 'a', status: 'ACTIVE', tokenVersion: 1 } }) }, driverAccountSession: { findMany: sessions } };
    const route = { driverId: 'd', constraints: { deliveryProof: { signatureRequired: true, photoRequired: false } } };
    try {
      await expect(assertProofDriverCompatible(tx as never, route, 'shop')).resolves.toBeUndefined();
      sessions.mockResolvedValueOnce([good, { ...good, capabilityVersionCode: 42 }]);
      await expect(assertProofDriverCompatible(tx as never, route, 'shop')).resolves.toBeUndefined();
      expect(sessions).toHaveBeenCalledWith(expect.objectContaining({ where: { accountId: 'a', revokedAt: null, expiresAt: { gt: anyDateMatcher } } }));
      for (const invalid of [[], [{ ...good, capabilityVersionCode: 42 }], [{ ...good, capabilityPackageId: 'com.evnsolution.clever.routes.qa' }], [{ ...good, capabilityTokenVersion: 0 }]]) {
        sessions.mockResolvedValueOnce(invalid); await expect(assertProofDriverCompatible(tx as never, route, 'shop')).rejects.toThrow(/UPDATE_REQUIRED/);
      }
    } finally { if (old === undefined) delete process.env.KFOOD_DELIVERY_PROOF_ENABLED; else process.env.KFOOD_DELIVERY_PROOF_ENABLED = old; }
  });
  test('required proof checks READY exact driver/stop media before completion', async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: 'media' });
    const tx = { routePlan: { findFirst: vi.fn().mockResolvedValue({ constraints: { deliveryProof: { photoRequired: true, signatureRequired: true } } }) }, driverProofMedia: { findFirst } };
    const input = { eventType: 'STOP_DELIVERED', versionCode: 43, routePlanId: 'r', shopId: 's', driverId: 'd', deliveryStopId: 'stop', payload: { deliveryProofCapability: 'delivery-proof-v1', proof: { photoMediaId: command.commandId, signatureMediaId: command.receiptId } } };
    await validateDriverDeliveryProof(tx as never, input as never);
    expect(findFirst).toHaveBeenLastCalledWith({ where: { id: command.receiptId, kind: 'SIGNATURE', source: 'SIGNATURE', contentType: 'image/png', driverId: 'd', shopId: 's', routePlanId: 'r', deliveryStopId: 'stop', uploadStatus: 'READY', deletedAt: null }, select: { id: true } });
    findFirst.mockResolvedValueOnce(null);
    await expect(validateDriverDeliveryProof(tx as never, input as never)).rejects.toThrow(/belong/);
    for (const eventType of ['ROUTE_STARTED', 'PICKUP_COMPLETED', 'STOP_DELIVERED']) {
      await expect(validateDriverDeliveryProof(tx as never, { ...input, eventType, versionCode: 42 } as never)).rejects.toThrow(/Update/);
      await expect(validateDriverDeliveryProof(tx as never, { ...input, eventType, payload: {} } as never)).rejects.toThrow(/Update/);
    }
    await expect(validateDriverDeliveryProof(tx as never, { ...input, payload: { deliveryProofCapability: 'delivery-proof-v1' } } as never)).rejects.toThrow(/Upload/);
  });
  test('capability registration requires account bearer and production version bound to current refresh session', async () => {
    const registerDeliveryProofCapability = vi.fn().mockResolvedValue(true);
    const app = await buildApp({ driverAuth: { driverAuthRepository: { registerDeliveryProofCapability } as never, jwtSecret: 'synthetic-proof-secret' } });
    const token = signDriverAccountToken({ accountId: 'a', subject: 'account:a', tokenVersion: 2, expiresInSeconds: 60 }, { secret: 'synthetic-proof-secret' }).token;
    const body = { refreshToken: 'synthetic-refresh-token-not-a-real-secret', capability: 'delivery-proof-v1', versionCode: 43, packageId: 'com.evnsolution.clever.routes' };
    try {
      expect((await app.inject({ method: 'POST', url: '/driver/capabilities', payload: body })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: '/driver/capabilities', headers: { authorization: `Bearer ${token}` }, payload: { ...body, versionCode: 42 } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url: '/driver/capabilities', headers: { authorization: `Bearer ${token}` }, payload: body })).statusCode).toBe(200);
      expect(registerDeliveryProofCapability).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'a', tokenVersion: 2, refreshToken: body.refreshToken }));
      registerDeliveryProofCapability.mockResolvedValue(false);
      expect((await app.inject({ method: 'POST', url: '/driver/capabilities', headers: { authorization: `Bearer ${token}` }, payload: body })).statusCode).toBe(401);
    } finally { await app.close(); }
  });
});
