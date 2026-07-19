export const NORMALIZED_PAYMENT_STATUSES = [
  "PAID_CONFIRMED",
  "CASH_COLLECT_REQUIRED",
  "TRANSFER_CHECK_PENDING",
  "ONLINE_PAYMENT_PENDING_OR_FAILED",
  "NOT_DELIVERABLE_OR_EXCEPTION",
  "UNKNOWN_REVIEW",
] as const;

export type NormalizedPaymentStatus =
  (typeof NORMALIZED_PAYMENT_STATUSES)[number];

const normalizedPaymentStatusSet = new Set<string>(
  NORMALIZED_PAYMENT_STATUSES,
);
const exceptionFinancialStatusSet = new Set([
  "EXPIRED",
  "PARTIALLY_REFUNDED",
  "REFUNDED",
  "VOIDED",
]);

export function readNormalizedPaymentStatus(
  value: unknown,
): NormalizedPaymentStatus | null {
  if (typeof value !== "string") return null;
  return normalizedPaymentStatusSet.has(value)
    ? (value as NormalizedPaymentStatus)
    : null;
}

export function resolveNormalizedPaymentStatus(input: {
  financialStatus: unknown;
  normalizedPaymentStatus: unknown;
}): NormalizedPaymentStatus | null {
  const canonicalStatus = readNormalizedPaymentStatus(input.normalizedPaymentStatus);
  if (canonicalStatus !== null) return canonicalStatus;
  if (typeof input.financialStatus !== "string") return null;

  const financialStatus = input.financialStatus.trim().toUpperCase();
  if (financialStatus === "") return null;
  if (financialStatus === "PAID") return "PAID_CONFIRMED";
  if (exceptionFinancialStatusSet.has(financialStatus)) {
    return "NOT_DELIVERABLE_OR_EXCEPTION";
  }
  return "UNKNOWN_REVIEW";
}
