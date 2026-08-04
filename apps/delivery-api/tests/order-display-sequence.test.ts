import { describe, expect, it } from 'vitest';

import { parseOrderDisplaySequence } from '../src/modules/shopify/order-display-sequence.js';

describe('parseOrderDisplaySequence', () => {
  it.each([
    ['#1393', 1393n],
    ['0000001393', 1393n],
    ['ORDER-001', 1n],
    ['  #42  ', 42n]
  ])('maps %s to a stable numeric sequence', (value, expected) => {
    expect(parseOrderDisplaySequence(value)).toBe(expected);
  });

  it.each([null, '', 'ORDER', '12-34', '9223372036854775808'])('rejects %s', (value) => {
    expect(parseOrderDisplaySequence(value)).toBeNull();
  });
});
