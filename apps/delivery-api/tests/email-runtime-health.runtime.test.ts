import { describe, expect, test, vi } from 'vitest';

import { EmailRuntimeHealthRuntime } from '../src/modules/customer-email/email-runtime-health.runtime.js';

describe('EmailRuntimeHealthRuntime', () => {
  test('scans every tenant without waiting for the settings page to be opened', async () => {
    const prisma = {
      shop: { findMany: vi.fn().mockResolvedValue([
        { appId: 'clever-route', shopDomain: 'a.example' },
        { appId: 'clever-kfood', shopDomain: 'b.example' }
      ]) }
    };
    const service = {
      get: vi.fn().mockResolvedValue({ email: { state: 'INACTIVE' }, observedAt: new Date().toISOString() })
    };
    const runtime = new EmailRuntimeHealthRuntime(prisma as never, service);

    await runtime.runOnce();

    expect(prisma.shop.findMany).toHaveBeenCalledWith({ select: { appId: true, shopDomain: true } });
    expect(service.get).toHaveBeenCalledTimes(2);
    expect(service.get).toHaveBeenCalledWith({ appId: 'clever-route', shopDomain: 'a.example' });
    expect(service.get).toHaveBeenCalledWith({ appId: 'clever-kfood', shopDomain: 'b.example' });
  });
});
