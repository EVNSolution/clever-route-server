import { describe, expect, test } from 'vitest';

import {
  buildWooDeliveryFactsEvidence,
  type WooDeliveryFactEvidenceRecord,
} from '../src/scripts/woocommerce-delivery-facts-evidence.lib.js';

function fact(
  overrides: Partial<WooDeliveryFactEvidenceRecord>,
): WooDeliveryFactEvidenceRecord {
  return {
    deliveryDate: null,
    deliveryDateWeekdayMismatch: false,
    deliveryDateWeekdayVerified: false,
    deliveryDayParseStatus: 'NOT_PROVIDED',
    geocodeStatus: 'PENDING',
    rawDeliveryArea: null,
    rawDeliveryDate: null,
    rawDeliveryDay: null,
    rawDeliveryTimeWindow: null,
    readiness: 'NEEDS_REVIEW',
    reviewReasons: [],
    routeScopeKey: null,
    order: {
      deliveryStops: [
        {
          latitude: '43.0000000',
          longitude: '-79.0000000',
          routePlanStops: [],
        },
      ],
    },
    ...overrides,
  };
}

describe('WooCommerce delivery facts evidence taxonomy', () => {
  test('separates parser, address, geocode, planning, non-deliverable, and unknown blockers', () => {
    const evidence = buildWooDeliveryFactsEvidence({
      connectionId: 'connection-id',
      expectedTotal: 6,
      facts: [
        fact({
          rawDeliveryDay: 'bad raw day',
          reviewReasons: ['delivery_day_unparsed'],
        }),
        fact({ reviewReasons: ['missing_address'] }),
        fact({
          geocodeStatus: 'PENDING',
          readiness: 'READY_TO_PLAN',
          order: {
            deliveryStops: [
              { latitude: null, longitude: null, routePlanStops: [] },
            ],
          },
        }),
        fact({ reviewReasons: ['non_deliverable_status:cancelled'] }),
        fact({ reviewReasons: ['missing_order_date'] }),
        fact({
          deliveryDate: '2026-06-03',
          deliveryDateWeekdayVerified: true,
          geocodeStatus: 'SUCCESS',
          readiness: 'READY_TO_PLAN',
          routeScopeKey: '2026-06-03|DAY',
          order: {
            deliveryStops: [
              {
                latitude: '43.0000000',
                longitude: '-79.0000000',
                routePlanStops: [{ id: 'route-plan-stop-id' }],
              },
            ],
          },
        }),
      ],
      shopDomain: 'tomatonofood.com',
    });

    expect(evidence.report_scope).toBe(
      'diagnostic_evidence_not_operational_readiness',
    );
    expect(evidence.taxonomy_note).toContain('operational readiness remains owned');
    expect(evidence.blocker_class_counts).toEqual({
      address: 1,
      geocode: 1,
      non_deliverable: 1,
      parser: 1,
      planning: 1,
      unknown: 1,
    });
    expect(evidence.primary_blocker_class_counts).toEqual({
      address: 1,
      geocode: 1,
      non_deliverable: 1,
      parser: 1,
      planning: 1,
      unknown: 1,
    });
    expect(evidence.parser_blocked).toBe(1);
    expect(evidence.unknown_blocked).toBe(1);
    expect(evidence.unknown_reason_counts).toEqual({ missing_order_date: 1 });
  });

  test('treats raw-backed missing route scope/date/area as parser evidence without exporting raw values', () => {
    const evidence = buildWooDeliveryFactsEvidence({
      connectionId: null,
      expectedTotal: 1,
      facts: [
        fact({
          rawDeliveryDate: 'private customer note 555-123-4567',
          reviewReasons: ['missing_delivery_date', 'missing_route_scope'],
        }),
      ],
      shopDomain: 'tomatonofood.com',
    });

    expect(evidence.parser_blocked).toBe(1);
    expect(evidence.unknown_blocked).toBe(0);
    expect(JSON.stringify(evidence)).not.toContain('555-123-4567');
    expect(JSON.stringify(evidence)).not.toContain('private customer note');
  });

  test('summarizes mapping diagnostics by redacted paths and parser candidate counts', () => {
    const evidence = buildWooDeliveryFactsEvidence({
      connectionId: null,
      expectedTotal: 1,
      facts: [
        fact({
          matchedMappingPaths: {
            deliveryDate: 'meta_data.consumer_secret',
            deliveryDay: 'line_items[0].meta_data.delivery_day',
          },
          mappingDiagnostics: {
            deliveryMetadata: {
              candidates: [
                {
                  parseStatus: 'UNPARSED',
                  path: 'line_items[0].meta_data.delivery_day',
                  source: 'configured',
                  valuePreview: '1100 King Street West 555-123-4567',
                },
              ],
            },
            discoveredPathStats: {
              'line_items[0].meta_data.delivery_day': 2,
              'meta_data.consumer_secret': 1,
            },
            unsupportedValues: [
              { path: 'meta_data.password', type: 'object' },
            ],
          },
          rawDeliveryDay: 'unparseable private 555-123-4567',
          reviewReasons: ['delivery_day_unparsed'],
        }),
      ],
      shopDomain: 'tomatonofood.com',
    });

    expect(evidence.matched_mapping_path_counts).toEqual({
      'deliveryDate:[redacted-sensitive-path]': 1,
      'deliveryDay:line_items[].meta_data.delivery_day': 1,
    });
    expect(evidence.parser_candidate_path_counts).toEqual({
      'line_items[].meta_data.delivery_day:UNPARSED:configured': 1,
    });
    expect(evidence.redacted_diagnostics_summary).toEqual({
      delivery_metadata_candidate_counts: {
        'line_items[].meta_data.delivery_day:UNPARSED:configured': 1,
      },
      discovered_path_counts: {
        'line_items[].meta_data.delivery_day': 2,
        '[redacted-sensitive-path]': 1,
      },
      unsupported_value_type_counts: {
        '[redacted-sensitive-path]:object': 1,
      },
    });
    expect(JSON.stringify(evidence)).not.toContain('1100 King Street West');
    expect(JSON.stringify(evidence)).not.toContain('555-123-4567');
    expect(JSON.stringify(evidence)).not.toContain('consumer_secret');
  });

});
