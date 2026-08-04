const MAX_SIGNED_BIGINT = 9_223_372_036_854_775_807n;

export function parseOrderDisplaySequence(value: string | null): bigint | null {
  if (value === null) return null;
  const match = /^[^0-9]*([0-9]+)$/u.exec(value.trim());
  if (match === null) return null;
  const digits = match[1];
  if (digits === undefined) return null;
  const parsed = BigInt(digits);
  return parsed <= MAX_SIGNED_BIGINT ? parsed : null;
}
