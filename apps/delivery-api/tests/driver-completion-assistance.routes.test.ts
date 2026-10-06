import { describe, expect, test, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import { signDriverAccountToken } from '../src/modules/driver/driver-token-verifier.js';
import type { DriverApiDependencies } from '../src/routes/driver-events.routes.js';

const now = new Date('2026-09-21T08:00:00.000Z');
const token = signDriverAccountToken({
  accountId: 'account-id',
  expiresInSeconds: 900,
  subject: 'driver-account:account-id',
  tokenVersion: 3
}, { now, secret: 'driver-secret' }).token;

describe('driver completion assistance routes', () => {
  test('serves the raw v1 snapshot to an active account token with no-store', async () => {
    const { dependencies, snapshot } = harness();
    const app = await buildApp({ driverApi: dependencies });
    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${token}` },
        method: 'GET',
        url: '/driver/completion-assistance'
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).toEqual({
        candidates: [],
        contractVersion: 1,
        runs: [],
        serverTime: now.toISOString()
      });
      expect(snapshot).toHaveBeenCalledWith('account-id');
    } finally {
      await app.close();
    }
  });

  test('accepts a raw v1 command and returns the applied acknowledgement', async () => {
    const { command, dependencies } = harness();
    const app = await buildApp({ driverApi: dependencies });
    try {
      const response = await app.inject({
        headers: { authorization: `Bearer ${token}` },
        method: 'POST',
        payload: {
          contractVersion: 1,
          command: {
            assignmentGeneration: '2',
            commandId: 'return-command',
            expectedRouteVersionId: '22222222-2222-4222-8222-222222222222',
            kind: 'return_intent',
            occurredAt: now.toISOString(),
            routePlanId: 'route-plan-id',
            runId: 'run-id'
          }
        },
        url: '/driver/completion-assistance'
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).toEqual({
        commandId: 'return-command',
        contractVersion: 1,
        status: 'applied'
      });
      expect(command).toHaveBeenCalledWith('account-id', expect.objectContaining({
        commandId: 'return-command',
        kind: 'return_intent'
      }));
    } finally {
      await app.close();
    }
  });

  test('rejects inactive account tokens and malformed commands without leaking state', async () => {
    const inactive = harness(false);
    const inactiveApp = await buildApp({ driverApi: inactive.dependencies });
    try {
      const denied = await inactiveApp.inject({
        headers: { authorization: `Bearer ${token}` },
        method: 'GET',
        url: '/driver/completion-assistance'
      });
      expect(denied.statusCode).toBe(401);
      expect(denied.headers['cache-control']).toBe('no-store');
      expect(denied.json()).toEqual({
        contractVersion: 1,
        error: { code: 'UNAUTHORIZED', message: 'Invalid driver account bearer token' }
      });
      expect(inactive.snapshot).not.toHaveBeenCalled();
    } finally {
      await inactiveApp.close();
    }

    const active = harness();
    const activeApp = await buildApp({ driverApi: active.dependencies });
    try {
      const malformed = await activeApp.inject({
        headers: { authorization: `Bearer ${token}` },
        method: 'POST',
        payload: { contractVersion: 1, command: { kind: 'response' } },
        url: '/driver/completion-assistance'
      });
      expect(malformed.statusCode).toBe(400);
      expect(malformed.headers['cache-control']).toBe('no-store');
      expect(malformed.json()).toMatchObject({
        contractVersion: 1,
        error: { code: 'COMPLETION_ASSISTANCE_INVALID' }
      });
      expect(active.command).not.toHaveBeenCalled();
    } finally {
      await activeApp.close();
    }
  });
});

function harness(active = true): {
  command: ReturnType<typeof vi.fn>;
  dependencies: DriverApiDependencies;
  snapshot: ReturnType<typeof vi.fn>;
} {
  const snapshot = vi.fn().mockResolvedValue({
    candidates: [],
    contractVersion: 1,
    runs: [],
    serverTime: now.toISOString()
  });
  const command = vi.fn().mockImplementation((_accountId: string, input: { commandId: string }) => Promise.resolve({
    commandId: input.commandId,
    contractVersion: 1,
    status: 'applied'
  }));
  return {
    command,
    dependencies: {
      completionAssistanceService: { command, processDue: vi.fn(), snapshot },
      driverEventService: {
        admitDriverEventAttempt: vi.fn(),
        finalizeDriverEventAttempt: vi.fn(),
        recordDriverEvent: vi.fn()
      },
      driverTokenAccessRepository: {
        isDriverAccessTokenActive: vi.fn(),
        isDriverAccountAccessTokenActive: vi.fn().mockResolvedValue(active),
        resolveDriverRouteAccess: vi.fn()
      },
      jwtSecret: 'driver-secret',
      now: () => now
    },
    snapshot
  };
}
