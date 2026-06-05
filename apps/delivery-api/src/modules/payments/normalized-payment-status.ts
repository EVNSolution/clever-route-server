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

export function readNormalizedPaymentStatus(
  value: unknown,
): NormalizedPaymentStatus | null {
  if (typeof value !== "string") return null;
  return normalizedPaymentStatusSet.has(value)
    ? (value as NormalizedPaymentStatus)
    : null;
}
