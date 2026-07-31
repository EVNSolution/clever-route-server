import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

import { buildApp } from '../src/app.js';

const dsvControlRouteSourceUrl = new URL('../src/routes/dsv-control.routes.ts', import.meta.url);
const dsvV1ReadRouteSourceUrl = new URL('../src/routes/dsv-v1-read.routes.ts', import.meta.url);

describe('API documentation routes', () => {
  test('GET /docs serves a minimal page pointing at the deployed OpenAPI document', async () => {
    const app = await buildApp();

    try {
      const response = await app.inject({ method: 'GET', url: '/docs' });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.body).toContain('CLEVER Delivery Server API Docs');
      expect(response.body).toContain('/docs/openapi.yaml');
      expect(response.body).toContain('rel="icon" href="data:,"');
    } finally {
      await app.close();
    }
  });

  test('GET /docs does not load scripts or third-party assets', async () => {
    const app = await buildApp();

    try {
      const response = await app.inject({ method: 'GET', url: '/docs' });
      const csp = String(response.headers['content-security-policy']);

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('/docs/openapi.yaml');
      expect(response.body).not.toContain('/docs/swagger-ui/');
      expect(response.body).not.toContain('cdn.jsdelivr.net');
      expect(response.body).not.toMatch(/<script[\s>]/u);
      expect(csp).toContain("script-src 'none'");
      expect(csp).not.toContain('cdn.jsdelivr.net');
    } finally {
      await app.close();
    }
  });

  test('public docs exposure is backed by a sanitized review and omits private operator material', async () => {
    const app = await buildApp();
    const review = await readFile(
      new URL('../../../docs/security/public-docs-sanitized-review.md', import.meta.url),
      'utf8'
    );
    const openApiDocument = await readFile(new URL('../docs/api/openapi.yaml', import.meta.url), 'utf8');

    try {
      const response = await app.inject({ method: 'GET', url: '/docs' });
      const publishedDocs = [response.body, openApiDocument].join('\n--- openapi ---\n');

      expect(response.statusCode).toBe(200);
      expect(review).toContain('Status: approved');
      expect(review).toContain('protect `/docs`');
      expect(review).toContain('query-string credential examples');
      expect(publishedDocs).not.toMatch(
        /CLEVER_ADMIN_API_TOKEN|DELIVERY_API_PUBLIC_URL|consumerSecret|consumer_secret|consumerKey|consumer_key|webhookSecret|webhook_secret/u
      );
      expect(publishedDocs).not.toMatch(/curl -sS|docker compose|Route53|Caddy|admin\.cleversystem\.ai|apps\/admin-web/u);
      expect(publishedDocs).not.toMatch(/sk_live_[A-Za-z0-9]+|AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/u);
    } finally {
      await app.close();
    }
  });

  test('GET /docs/openapi.yaml serves the committed OpenAPI contract', async () => {
    const app = await buildApp();
    const expected = await readFile(new URL('../docs/api/openapi.yaml', import.meta.url), 'utf8');

    try {
      const response = await app.inject({ method: 'GET', url: '/docs/openapi.yaml' });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('yaml');
      expect(response.body).toBe(expected);
    } finally {
      await app.close();
    }
  });

  test('GET /docs/openapi.yaml documents the complete served DSV v1 runtime boundary', async () => {
    const app = await buildApp();
    const [controlRouteSource, readRouteSource] = await Promise.all([
      readFile(dsvControlRouteSourceUrl, 'utf8'),
      readFile(dsvV1ReadRouteSourceUrl, 'utf8'),
    ]);
    const implementedRoutes = implementedDsvV1Routes(readRouteSource, controlRouteSource);

    try {
      const response = await app.inject({ method: 'GET', url: '/docs/openapi.yaml' });
      const documentedRoutes = openApiRoutes(response.body);

      expect(response.statusCode).toBe(200);
      expect(implementedRoutes).toEqual([
        { method: 'get', path: '/api/dsv/v1/conditions' },
        { method: 'get', path: '/api/dsv/v1/control' },
        { method: 'get', path: '/api/dsv/v1/customer/deliveries' },
        { method: 'get', path: '/api/dsv/v1/customers' },
        { method: 'get', path: '/api/dsv/v1/destinations' },
        { method: 'get', path: '/api/dsv/v1/dispatches' },
        { method: 'get', path: '/api/dsv/v1/drivers' },
        { method: 'get', path: '/api/dsv/v1/map/profile' },
        { method: 'get', path: '/api/dsv/v1/records' },
        { method: 'post', path: '/api/dsv/v1/seller-orders/:sellerOrderId/assignment/reassign' },
        { method: 'post', path: '/api/dsv/v1/seller-orders/:sellerOrderId/assignment/unassign' },
        { method: 'get', path: '/api/dsv/v1/session' },
        { method: 'post', path: '/api/dsv/v1/session/logout' },
        { method: 'get', path: '/api/dsv/v1/vehicles' },
      ]);
      expect(missingDocumentedRoutes(implementedRoutes, documentedRoutes)).toEqual([]);
    } finally {
      await app.close();
    }
  });

  test('GET /docs/openapi.yaml keeps forbidden G005 DSV v1 proof event route undocumented', async () => {
    const app = await buildApp();

    try {
      const response = await app.inject({ method: 'GET', url: '/docs/openapi.yaml' });
      const documentedRoutes = openApiRoutes(response.body);

      expect(response.statusCode).toBe(200);
      expect(documentedRoutes.has('/api/dsv/v1/resources/proofs/events')).toBe(false);
      expect(response.body).not.toContain('/api/dsv/v1/resources/proofs/events');
    } finally {
      await app.close();
    }
  });

  test('GET /docs/openapi.yaml documents strict DSV v1 vehicle driver assignment items', async () => {
    const app = await buildApp();

    try {
      const response = await app.inject({ method: 'GET', url: '/docs/openapi.yaml' });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('required: [displayName, driverAssignments, vehicleId]');
      expect(response.body).toContain('maxItems: 1');
      expect(response.body).toContain('$ref: \'#/components/schemas/DsvV1VehicleDriverAssignmentListItem\'');
      expect(response.body).toContain('DsvV1VehicleDriverAssignmentListItem:');
      expect(response.body).toContain('required: [assignmentId, driverId]');
      expect(response.body).toContain('additionalProperties: false');
      expect(response.body).not.toContain('DsvV1VehicleDriverAssignmentListItem:\n      type: object\n      required: [assignmentId, driverId, kind');
    } finally {
      await app.close();
    }
  });

  test('GET /docs/openapi.yaml documents pickup ETA snapshot without server-local status field', async () => {
    const app = await buildApp();

    try {
      const response = await app.inject({ method: 'GET', url: '/docs/openapi.yaml' });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('PICKUP_COMPLETED');
      expect(response.body).toContain('DriverRouteEtaSnapshot:');
      expect(response.body).toContain('etaSnapshot:');
      expect(response.body).toContain('PICKUP_COMPLETED requires a nonblank clientEventId and deliveryStopId must be omitted or null.');
      expect(response.body).toContain('clientEventId: pickup-2026-05-07T06-09-30Z');
      expect(response.body).toContain('deliveryStopId: null');
      expect(response.body).toContain('distanceFromPreviousMeters:');
      expect(response.body).toContain('estimatedCompletionAt:');
      expect(response.body).toContain('enum: [ROUTE_STARTED, STOP_ARRIVED, PICKUP_COMPLETED]');
      expect(response.body).not.toMatch(/DriverEventEnvelope:[\s\S]*required: \[duplicate, eventId, status\]/u);
    } finally {
      await app.close();
    }
  });

  test('GET /docs/openapi.yaml documents exact DSV v1 map and control scopes', async () => {
    const app = await buildApp();

    try {
      const response = await app.inject({ method: 'GET', url: '/docs/openapi.yaml' });

      expect(response.statusCode).toBe(200);
      expect(pathBlock(response.body, '/api/dsv/v1/control')).toContain(
        "x-required-scopes: ['dsv:control:read']"
      );
      expect(pathBlock(response.body, '/api/dsv/v1/map/profile')).toContain(
        'x-required-scopes: []'
      );
    } finally {
      await app.close();
    }
  });
});

type RouteMethod = 'delete' | 'get' | 'patch' | 'post' | 'put';

type RouteMethodPair = {
  method: RouteMethod;
  path: string;
};

const httpMethods = ['delete', 'get', 'patch', 'post', 'put'] as const satisfies readonly RouteMethod[];

function implementedDsvV1Routes(readRouteSource: string, controlRouteSource: string): RouteMethodPair[] {
  const routes: RouteMethodPair[] = [];

  for (const match of readRouteSource.matchAll(/app\.(get|post|put|patch|delete)\(`\$\{apiRoot\}(\/[^`]*)`/gu)) {
    const pathSuffix = match[2] ?? '';
    if (!pathSuffix.includes('${')) {
      routes.push({ method: toRouteMethod(match[1]), path: `/api/dsv/v1${pathSuffix}` });
    }
  }

  for (const match of readRouteSource.matchAll(/registerReadRoute\(\s*app,\s*dependencies,\s*'([^']+)'/gu)) {
    routes.push({ method: 'get', path: `/api/dsv/v1/${match[1] ?? ''}` });
  }

  for (const match of controlRouteSource.matchAll(
    /app\.(get|post|put|patch|delete)\(`\$\{versionedApiRoot\}(\/[^`]*)`/gu
  )) {
    routes.push({ method: toRouteMethod(match[1]), path: `/api/dsv/v1${match[2] ?? ''}` });
  }

  return [...routes].sort(compareRouteMethodPair);
}

function openApiRoutes(openApiYaml: string): Map<string, Set<RouteMethod>> {
  const routes = new Map<string, Set<RouteMethod>>();
  let currentPath: string | null = null;

  for (const line of openApiYaml.split('\n')) {
    const pathMatch = /^ {2}(\/[^:]+):\s*$/u.exec(line);
    if (pathMatch !== null) {
      currentPath = pathMatch[1] ?? null;
      if (currentPath !== null && !routes.has(currentPath)) {
        routes.set(currentPath, new Set<RouteMethod>());
      }
      continue;
    }

    const methodMatch = /^ {4}(delete|get|patch|post|put):\s*$/u.exec(line);
    if (methodMatch !== null && currentPath !== null) {
      routes.get(currentPath)?.add(toRouteMethod(methodMatch[1]));
    }
  }

  return routes;
}

function pathBlock(openApiYaml: string, path: string): string {
  const marker = `  ${path}:`;
  const start = openApiYaml.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const nextPathOffset = openApiYaml.slice(start + marker.length).search(/\n {2}\/[^:\n]+:/u);
  return nextPathOffset === -1
    ? openApiYaml.slice(start)
    : openApiYaml.slice(start, start + marker.length + nextPathOffset);
}

function missingDocumentedRoutes(
  implementedRoutes: readonly RouteMethodPair[],
  documentedRoutes: ReadonlyMap<string, ReadonlySet<RouteMethod>>,
): RouteMethodPair[] {
  return implementedRoutes.filter(({ method, path }) => !documentedRoutes.get(toOpenApiPath(path))?.has(method));
}

function toOpenApiPath(runtimePath: string): string {
  return runtimePath.replace(/:([A-Za-z][A-Za-z0-9_]*)/gu, '{$1}');
}

function compareRouteMethodPair(left: RouteMethodPair, right: RouteMethodPair): number {
  return left.path.localeCompare(right.path) || left.method.localeCompare(right.method);
}

function toRouteMethod(method: string | undefined): RouteMethod {
  for (const candidate of httpMethods) {
    if (candidate === method) {
      return candidate;
    }
  }
  throw new Error(`Unsupported HTTP method in route docs parity test: ${String(method)}`);
}
