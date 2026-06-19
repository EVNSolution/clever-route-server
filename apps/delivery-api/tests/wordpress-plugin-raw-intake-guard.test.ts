import { describe, expect, test } from 'vitest';

import {
  classifyRawIntakeSource,
  decideRawOrderIntake,
  RAW_INTAKE_CODES,
  RAW_INTAKE_DECISIONS,
  RAW_INTAKE_SOURCE_LINES,
  sanitizeRawIntakeMetadata,
  sanitizeRawIntakeMessage
} from '../src/modules/wordpress-plugin/raw-order-intake-guard.js';

function wooOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 11815,
    line_items: [{ id: 1, name: 'Tomato box', quantity: 1 }],
    number: '11815',
    status: 'processing',
    ...overrides
  };
}

describe('raw order intake source classifier', () => {
  test('trusted Woo provenance outranks Shopify-looking payload shape', () => {
    const classification = classifyRawIntakeSource({
      context: { connectionPlatform: 'WOOCOMMERCE', routeSource: 'wordpress_plugin_raw_push' },
      rawPayload: { admin_graphql_api_id: 'gid://shopify/Order/1', line_items: [] }
    });

    expect(classification.sourceLine).toBe(RAW_INTAKE_SOURCE_LINES.WOOCOMMERCE);
    expect(classification.reason).toBe('trusted_source_context');
  });

  test('trusted Shopify legacy provenance bypasses Woo hard-skip decisions', () => {
    const decision = decideRawOrderIntake({
      context: { connectionPlatform: 'SHOPIFY_LEGACY', routeSource: 'shopify_legacy' },
      rawPayload: wooOrder({ status: 'cancelled' })
    });

    expect(decision.sourceLine).toBe(RAW_INTAKE_SOURCE_LINES.SHOPIFY_LEGACY);
    expect(decision.decision).toBe(RAW_INTAKE_DECISIONS.PROCESS_CANONICAL);
    expect(decision.code).toBe(RAW_INTAKE_CODES.SOURCE_LINE_SHOPIFY_LEGACY_BYPASS);
  });

  test('conflicting trusted signals reject instead of guessing', () => {
    const decision = decideRawOrderIntake({
      context: { connectionPlatform: 'SHOPIFY_LEGACY', routeSource: 'wordpress_plugin_raw_push' },
      rawPayload: wooOrder()
    });

    expect(decision.sourceLine).toBe(RAW_INTAKE_SOURCE_LINES.UNKNOWN_SOURCE_LINE);
    expect(decision.decision).toBe(RAW_INTAKE_DECISIONS.REJECT_PRE_INGEST);
    expect(decision.code).toBe(RAW_INTAKE_CODES.SOURCE_LINE_TRUSTED_SIGNAL_CONFLICT);
  });
});

describe('Woo raw intake decisions', () => {
  test.each([
    ['checkout-draft', RAW_INTAKE_CODES.WOO_STATUS_CHECKOUT_DRAFT],
    ['draft', RAW_INTAKE_CODES.WOO_STATUS_DRAFT],
    ['auto-draft', RAW_INTAKE_CODES.WOO_STATUS_AUTO_DRAFT],
    ['trash', RAW_INTAKE_CODES.WOO_STATUS_TRASH],
    ['cancelled', RAW_INTAKE_CODES.WOO_STATUS_CANCELLED],
    ['refunded', RAW_INTAKE_CODES.WOO_STATUS_REFUNDED],
    ['failed', RAW_INTAKE_CODES.WOO_STATUS_FAILED]
  ])('hard-skips Woo status %s with centralized code', (status, code) => {
    const decision = decideRawOrderIntake({
      context: { connectionPlatform: 'WOOCOMMERCE' },
      rawPayload: wooOrder({ status })
    });

    expect(decision.decision).toBe(RAW_INTAKE_DECISIONS.SKIP_RAW);
    expect(decision.code).toBe(code);
    expect(decision.message.length).toBeLessThanOrEqual(160);
  });

  test('rejects missing source order id before canonical import', () => {
    const decision = decideRawOrderIntake({
      context: { routeSource: 'wordpress_plugin_raw_push' },
      rawPayload: wooOrder({ id: null })
    });

    expect(decision.decision).toBe(RAW_INTAKE_DECISIONS.REJECT_PRE_INGEST);
    expect(decision.code).toBe(RAW_INTAKE_CODES.RAW_SHAPE_MISSING_ORDER_ID);
  });

  test('skips empty line items without treating the order as importable', () => {
    const decision = decideRawOrderIntake({
      context: { connectionPlatform: 'WOOCOMMERCE' },
      rawPayload: wooOrder({ line_items: [] })
    });

    expect(decision.decision).toBe(RAW_INTAKE_DECISIONS.SKIP_RAW);
    expect(decision.code).toBe(RAW_INTAKE_CODES.RAW_SHAPE_EMPTY_LINE_ITEMS);
  });

  test('keeps active processing orders without delivery metadata as canonical review rows', () => {
    const decision = decideRawOrderIntake({
      context: { connectionPlatform: 'WOOCOMMERCE' },
      rawPayload: wooOrder({ meta_data: [] })
    });

    expect(decision.decision).toBe(RAW_INTAKE_DECISIONS.REVIEW_CANONICAL);
    expect(decision.code).toBe(RAW_INTAKE_CODES.WOO_METADATA_MISSING_DELIVERY_SCOPE);
  });

  test('allows pending Woo orders with delivery metadata to proceed', () => {
    const decision = decideRawOrderIntake({
      context: { connectionPlatform: 'WOOCOMMERCE' },
      rawPayload: wooOrder({
        meta_data: [{ key: '_tomatono_delivery_day', value: 'Friday Evening' }],
        status: 'pending'
      })
    });

    expect(decision.decision).toBe(RAW_INTAKE_DECISIONS.PROCESS_CANONICAL);
    expect(decision.code).toBe(RAW_INTAKE_CODES.CANONICAL_DECISION_PROCESS);
  });
});

describe('raw intake redaction and capping', () => {
  test('caps safe messages and redacts PII-looking values', () => {
    const message = sanitizeRawIntakeMessage(
      `token=secret email driver@example.com phone +1 416 555 1212 ${'x'.repeat(220)}`
    );

    expect(message.length).toBeLessThanOrEqual(160);
    expect(message).toContain('[redacted-secret]');
    expect(message).toContain('[redacted-email]');
    expect(message).toContain('[redacted-phone]');
  });

  test.each(['api_key', 'api_token', 'access_token', 'authorization'])(
    'redacts sensitive diagnostic value label %s',
    (label) => {
      const message = sanitizeRawIntakeMessage(`${label}=secret-value`);

      expect(message).toBe('[redacted-secret]');
      expect(message).not.toContain('secret-value');
    }
  );

  test('redacts authorization scheme and credential together', () => {
    const message = sanitizeRawIntakeMessage('authorization=Bearer secret-token');

    expect(message).toBe('[redacted-secret]');
    expect(message).not.toContain('Bearer');
    expect(message).not.toContain('secret-token');
  });

  test('caps metadata and redacts sensitive keys without retaining raw payload shape', () => {
    const metadata = sanitizeRawIntakeMetadata({
      access_token: 'secret-token',
      nested: { email: 'customer@example.com', phone: '+1 416 555 1212' },
      rawPayload: { a: { b: { c: { d: 'too deep' } } } }
    });

    expect(metadata).toHaveProperty('[redacted-sensitive-path]');
    expect(JSON.stringify(metadata)).not.toContain('secret-token');
    expect(JSON.stringify(metadata)).not.toContain('customer@example.com');
    expect(JSON.stringify(metadata)).toContain('[truncated-depth]');
  });
});
