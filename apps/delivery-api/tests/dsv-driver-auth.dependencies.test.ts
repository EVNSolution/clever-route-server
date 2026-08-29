import { describe, expect, test } from 'vitest';

import { loadDsvDriverAuthDependencies } from '../src/modules/dsv/dsv-driver-auth.dependencies.js';

const prisma = {} as never;

describe('DSV driver auth runtime dependency gate', () => {
  test('stays disabled only when the explicit feature flag is not enabled', () => {
    expect(loadDsvDriverAuthDependencies({ env: {}, nodeEnv: 'production', prisma })).toBeUndefined();
    expect(loadDsvDriverAuthDependencies({
      env: { CLEVER_DSV_DRIVER_AUTH_ENABLED: 'false' },
      nodeEnv: 'production',
      prisma,
    })).toBeUndefined();
  });

  test('fails fast when the enabled JWT credential is absent', () => {
    expect(() => loadDsvDriverAuthDependencies({
      env: { CLEVER_DSV_DRIVER_AUTH_ENABLED: 'true' },
      nodeEnv: 'production',
      prisma,
    })).toThrow('requires JWT_SECRET');
  });

  test('loads the repository only when explicitly enabled with complete secrets', () => {
    expect(loadDsvDriverAuthDependencies({
      env: {
        CLEVER_DSV_DRIVER_AUTH_ENABLED: 'true',
        JWT_SECRET: 'jwt',
      },
      nodeEnv: 'production',
      prisma,
    })).toMatchObject({ jwtSecret: 'jwt' });
  });
});
