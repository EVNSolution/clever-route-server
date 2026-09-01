import { describe, expect, test, vi } from 'vitest';

import {
  readDriverAccountDeletionCliArguments,
  runDriverAccountDeletionCli,
} from '../src/scripts/process-driver-account-deletion.js';

const requestId = '11111111-1111-4111-8111-111111111111';
const accountId = '22222222-2222-4222-8222-222222222222';

describe('driver account deletion CLI', () => {
  test('defaults destructive actions to dry-run and never accepts phone or PIN inputs', () => {
    expect(readDriverAccountDeletionCliArguments([
      '--action', 'fulfill',
      '--request-id', requestId,
      '--actor', 'privacy-ops',
    ])).toEqual({
      action: 'fulfill',
      actor: 'privacy-ops',
      execute: false,
      requestId,
    });
    expect(() => readDriverAccountDeletionCliArguments([
      '--action', 'request',
      '--phone', '+14165550123',
    ])).toThrow('Unsupported argument: --phone');
    expect(() => readDriverAccountDeletionCliArguments([
      '--action', 'request',
      '--pin', '123456',
    ])).toThrow('Unsupported argument: --pin');
  });

  test('requires exact UUID confirmation before execution', () => {
    expect(() => readDriverAccountDeletionCliArguments([
      '--action', 'fulfill',
      '--request-id', requestId,
      '--actor', 'privacy-ops',
      '--execute', 'true',
      '--confirm-request-id', accountId,
    ])).toThrow('confirm-request-id must match request-id');
    expect(readDriverAccountDeletionCliArguments([
      '--action', 'request',
      '--account-id', accountId,
      '--actor', 'privacy-support',
      '--execute', 'true',
      '--confirm-account-id', accountId,
    ])).toEqual({
      accountId,
      action: 'request',
      actor: 'privacy-support',
      confirmAccountId: accountId,
      execute: true,
    });
  });

  test('dry-run inspects sanitized counts without fulfilling the request', async () => {
    const service = {
      fulfill: vi.fn(),
      inspect: vi.fn(() => Promise.resolve({
        accountPresent: true,
        activeRouteCount: 0,
        accountSessionCount: 1,
        driverCount: 1,
        driverSessionCount: 1,
        pushTokenCount: 1,
        requestId,
        signupInviteCount: 0,
        status: 'REQUESTED',
      })),
    };
    await expect(runDriverAccountDeletionCli({
      action: 'fulfill',
      actor: 'privacy-ops',
      execute: false,
      requestId,
    }, service as never)).resolves.toEqual(expect.objectContaining({
      action: 'fulfill',
      dryRun: true,
      requestId,
      status: 'REQUESTED',
    }));
    expect(service.fulfill).not.toHaveBeenCalled();
  });
});
