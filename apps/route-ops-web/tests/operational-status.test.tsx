import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';

import { OperationalPillGroup } from '../src/components/primitives';
import {
  highestActiveAlert,
  routeOperationalPills,
  runtimeHealthPills,
} from '../src/operationalStatus';
import type { AdminNotificationDto } from '../src/types';

describe('operational status projection', () => {
  test('renders Kitchener source states as independent accessible pills', () => {
    const pills = routeOperationalPills({
      activeAlerts: [{
        acknowledgedAt: null,
        id: 'critical-alert',
        lastObservedAt: '2026-08-24T01:05:00.000Z',
        openedAt: '2026-08-24T01:00:00.000Z',
        resolvedAt: null,
        severity: 'CRITICAL',
        type: 'ROUTE_PROGRESS_MISMATCH',
      }],
      deviceProgress: { completedStopCount: 11, totalStopCount: 11 },
      physicalPosition: { accuracyMeters: 12, distanceMeters: 18, freshness: 'FRESH', nearestStopSequence: 11, occurredAt: '2026-08-24T01:01:00.000Z', proximityPolicyVersion: 1, proximityThresholdMeters: 100, receivedAt: '2026-08-24T01:01:01.000Z', reliableForProximity: true, withinProximityThreshold: true },
      routeStatus: 'IN_PROGRESS',
      serverProgress: { deliveredStopCount: 1, failedStopCount: 0, lastConfirmedAt: '2026-08-24T01:00:00.000Z', resolvedStopCount: 1, totalStopCount: 11 },
      syncHealth: { lastErrorCode: 'STOP_EVENT_REJECTED', queueDepth: 10, state: 'BLOCKED' },
    }, 11, 'en-CA');
    const html = renderToStaticMarkup(
      <OperationalPillGroup ariaLabel="Kitchener operational state" pills={pills} />,
    );

    expect(pills.map((pill) => pill.label)).toEqual([
      'Alert critical',
      'Route in progress',
      'GPS live',
      'Device 11/11',
      'Server 1/11',
      'Gap 10 stops',
      'Sync blocked',
    ]);
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="GPS live. Accuracy 12 metres. Near stop 11"');
    expect(html).toContain('aria-label="Sync blocked. STOP_EVENT_REJECTED"');
    expect(html).not.toContain('·');
  });

  test('legacy routes render unknown instead of inferring device and sync health', () => {
    expect(routeOperationalPills(undefined, 11, 'en-CA').map((pill) => pill.label)).toEqual([
      'Alert unknown',
      'Route unknown',
      'GPS unknown',
      'Device unknown',
      'Server unknown',
      'Gap unknown',
      'Sync unknown',
    ]);
  });

  test('renders zero progress gap as a successful independent accessible pill', () => {
    const gap = routeOperationalPills({
      activeAlerts: [],
      deviceProgress: { completedStopCount: 4, totalStopCount: 11 },
      physicalPosition: null,
      routeStatus: 'IN_PROGRESS',
      serverProgress: { deliveredStopCount: 4, failedStopCount: 0, lastConfirmedAt: null, resolvedStopCount: 4, totalStopCount: 11 },
      syncHealth: { lastErrorCode: null, queueDepth: 0, state: 'HEALTHY' },
    }, 11, 'en-CA').find((pill) => pill.key === 'gap');

    expect(gap).toEqual({
      ariaLabel: 'Progress gap 0 stops between device and server',
      key: 'gap',
      label: 'Gap 0 stops',
      tone: 'success',
    });
  });

  test('runtime health separates sender, outbox, attempt evidence, and infrastructure facts', () => {
    const pills = runtimeHealthPills({
      emailOutbox: { attemptCount: 3, failedCount: 1, pendingCount: 2, state: 'DEGRADED' },
      emailSender: { state: 'DISABLED' },
      webhookIngest: { state: 'HEALTHY' },
    }, 'en-CA');

    expect(pills.find((pill) => pill.key === 'emailSender')).toEqual(expect.objectContaining({
      label: 'Email sender disabled',
      tone: 'critical',
    }));
    expect(pills.find((pill) => pill.key === 'emailOutbox')?.ariaLabel).toBe(
      'Email outbox degraded. 2 pending, 1 failed, 3 attempts',
    );
    expect(pills.find((pill) => pill.key === 'externalLogSink')?.label).toBe('External logs unknown');
    expect(pills.map((pill) => pill.label).join(' ')).not.toContain('·');
  });

  test('email runtime contract projects sender and attempt backlog independently', () => {
    const pills = runtimeHealthPills({
      email: {
        configured: true,
        outbox: { deadLetter: 1, lastErrorCode: 'SMTP_TIMEOUT', lastSuccessAt: '2026-08-24T00:30:00.000Z', oldestPendingAt: '2026-08-24T01:00:00.000Z', pending: 2, processing: 1, retryWait: 3 },
        state: 'DEGRADED',
      },
      observedAt: '2026-08-24T02:00:00.000Z',
    }, 'en-CA');

    expect(pills).toHaveLength(8);
    expect(pills.find((pill) => pill.key === 'emailSender')).toEqual(expect.objectContaining({ label: 'Email sender degraded' }));
    expect(pills.find((pill) => pill.key === 'emailOutbox')).toEqual(expect.objectContaining({
      ariaLabel: expect.stringContaining('SMTP_TIMEOUT'),
      label: 'Email outbox degraded',
      tone: 'warning',
    }));
    expect(pills.find((pill) => pill.key === 'webhookIngest')?.label).toBe('Webhook ingest unknown');
  });

  test('resolved alerts are not active and a critical active alert wins deterministically', () => {
    const resolved = notification({ id: 'resolved', resolvedAt: '2026-08-24T02:00:00.000Z', severity: 'critical' });
    const warning = notification({ id: 'warning', severity: 'warning' });
    const critical = notification({ id: 'critical', severity: 'critical' });

    expect(highestActiveAlert([resolved, warning, critical])?.id).toBe('critical');
    expect(highestActiveAlert([resolved])).toBeNull();
  });

  test('Route Ops source contains no separator-dot operational copy', () => {
    const sourceRoot = fileURLToPath(new URL('../src', import.meta.url));
    const offenders = sourceFiles(sourceRoot).filter((path) => readFileSync(path, 'utf8').includes('·'));

    expect(offenders).toEqual([]);
  });
});

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.(?:ts|tsx)$/u.test(path) ? [path] : [];
  });
}

function notification(overrides: Partial<AdminNotificationDto> = {}): AdminNotificationDto {
  return {
    body: null,
    createdAt: '2026-08-24T01:00:00.000Z',
    href: null,
    id: 'alert',
    orderId: null,
    payload: null,
    readAt: null,
    routePlanId: 'route-1',
    severity: 'warning',
    title: 'Review sync',
    type: 'ROUTE_PROGRESS_MISMATCH',
    ...overrides,
  };
}
