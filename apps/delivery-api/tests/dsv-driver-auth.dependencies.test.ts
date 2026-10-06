import { describe, expect, test } from 'vitest';

import { loadDsvDriverAuthDependencies } from '../src/modules/dsv/dsv-driver-auth.dependencies.js';
import { loadDsvWebPublicOrigin } from '../src/modules/dsv/dsv-web-public-origin.js';

const prisma = {} as never;

describe('DSV driver auth runtime dependency gate', () => {
  test('requires a pathless HTTPS public origin except for local development HTTP', () => {
    expect(loadDsvWebPublicOrigin('https://dsv.example.com', 'production')).toBe('https://dsv.example.com');
    expect(loadDsvWebPublicOrigin('http://localhost:5173', 'development')).toBe('http://localhost:5173');
    expect(() => loadDsvWebPublicOrigin('http://localhost:5173', 'production')).toThrow(/HTTPS origin/u);
    expect(() => loadDsvWebPublicOrigin('http://dsv.example.com', 'development')).toThrow(/HTTPS origin/u);
    expect(() => loadDsvWebPublicOrigin('https://dsv.example.com/app', 'production')).toThrow(/HTTPS origin/u);
  });

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

  test('fails fast when the enabled JWT credential is shorter than 32 characters', () => {
    expect(() => loadDsvDriverAuthDependencies({
      env: {
        CLEVER_DSV_DRIVER_AUTH_ENABLED: 'true',
        JWT_SECRET: 'short-secret',
      },
      nodeEnv: 'production',
      prisma,
    })).toThrow('JWT_SECRET must contain at least 32 characters');
  });

  test('loads the repository only when explicitly enabled with complete secrets', () => {
    expect(loadDsvDriverAuthDependencies({
      env: {
        CLEVER_DSV_DRIVER_AUTH_ENABLED: 'true',
        JWT_SECRET: 'test-driver-jwt-secret-32-characters',
      },
      nodeEnv: 'production',
      prisma,
    })).toMatchObject({ jwtSecret: 'test-driver-jwt-secret-32-characters' });
  });
});
