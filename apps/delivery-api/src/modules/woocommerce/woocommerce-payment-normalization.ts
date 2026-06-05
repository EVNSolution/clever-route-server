import type { NormalizedPaymentStatus } from "../payments/normalized-payment-status.js";
import type { WooCommerceOrder } from "./woocommerce-order.types.js";

export type WooPaymentMethodFamily = "cash" | "online" | "transfer";

export type WooPaymentMethodMappingConfig = {
  cashMethodIds?: string[];
  onlineMethodIds?: string[];
  transferMethodIds?: string[];
};

export type WooPaymentNormalizationInput = Pick<
  WooCommerceOrder,
  | "date_paid"
  | "date_paid_gmt"
  | "payment_method"
  | "payment_method_title"
  | "status"
  | "transaction_id"
>;

export type WooPaymentNormalizationResult = {
  normalizedPaymentReason: string;
  normalizedPaymentStatus: NormalizedPaymentStatus;
  paidAt: string | null;
  paymentMethodFamily: WooPaymentMethodFamily | null;
  paymentMethodId: string | null;
  paymentMethodTitle: string | null;
  paymentReviewReason: string | null;
  transactionId: string | null;
  wooOrderStatus: string | null;
};

const EXCEPTION_STATUSES = new Set(["cancelled", "refunded", "failed", "trash"]);
const PAID_STATUSES = new Set(["completed"]);
const ONLINE_PAID_STATUSES = new Set(["processing"]);

const DEFAULT_CASH_METHOD_IDS = new Set(["cod", "cash", "cash_on_delivery"]);
const DEFAULT_TRANSFER_METHOD_IDS = new Set([
  "bacs",
  "bank_transfer",
  "direct_bank_transfer",
  "email_transfer",
  "e-transfer",
  "etransfer",
  "interac",
  "wire",
]);
const DEFAULT_ONLINE_METHOD_IDS = new Set([
  "card",
  "stripe",
  "stripe_cc",
  "paypal",
  "woocommerce_payments",
  "square",
  "authorize_net",
]);

export function normalizeWooCommercePaymentStatus(
  input: WooPaymentNormalizationInput,
  config: WooPaymentMethodMappingConfig | null = null,
): WooPaymentNormalizationResult {
  const paymentMethodId = normalizeToken(input.payment_method);
  const paymentMethodTitle = normalizeText(input.payment_method_title);
  const wooOrderStatus = normalizeToken(input.status);
  const paidAt = normalizeText(input.date_paid_gmt) ?? normalizeText(input.date_paid);
  const transactionId = normalizeText(input.transaction_id);
  const paymentMethodFamily = classifyPaymentMethodFamily({
    config,
    paymentMethodId,
    paymentMethodTitle,
  });
  const hasPaidEvidence = paidAt !== null || transactionId !== null;

  if (wooOrderStatus !== null && EXCEPTION_STATUSES.has(wooOrderStatus)) {
    return result({
      normalizedPaymentReason: `woo_status_exception:${wooOrderStatus}`,
      normalizedPaymentStatus: "NOT_DELIVERABLE_OR_EXCEPTION",
      paidAt,
      paymentMethodFamily,
      paymentMethodId,
      paymentMethodTitle,
      paymentReviewReason: `Woo order status is ${wooOrderStatus}`,
      transactionId,
      wooOrderStatus,
    });
  }

  if (
    hasPaidEvidence ||
    (wooOrderStatus !== null && PAID_STATUSES.has(wooOrderStatus)) ||
    ((paymentMethodFamily === "online" || paymentMethodFamily === "transfer") &&
      wooOrderStatus !== null &&
      ONLINE_PAID_STATUSES.has(wooOrderStatus))
  ) {
    return result({
      normalizedPaymentReason:
        hasPaidEvidence
          ? "woo_paid_evidence"
          : `woo_status_paid:${wooOrderStatus ?? "unknown"}`,
      normalizedPaymentStatus: "PAID_CONFIRMED",
      paidAt,
      paymentMethodFamily,
      paymentMethodId,
      paymentMethodTitle,
      paymentReviewReason: null,
      transactionId,
      wooOrderStatus,
    });
  }

  if (paymentMethodFamily === "cash") {
    return result({
      normalizedPaymentReason: "cash_method_unpaid_active_order",
      normalizedPaymentStatus: "CASH_COLLECT_REQUIRED",
      paidAt,
      paymentMethodFamily,
      paymentMethodId,
      paymentMethodTitle,
      paymentReviewReason: null,
      transactionId,
      wooOrderStatus,
    });
  }

  if (paymentMethodFamily === "transfer") {
    return result({
      normalizedPaymentReason: "transfer_method_waiting_for_woo_confirmation",
      normalizedPaymentStatus: "TRANSFER_CHECK_PENDING",
      paidAt,
      paymentMethodFamily,
      paymentMethodId,
      paymentMethodTitle,
      paymentReviewReason: null,
      transactionId,
      wooOrderStatus,
    });
  }

  if (paymentMethodFamily === "online") {
    return result({
      normalizedPaymentReason: "online_method_pending_or_unconfirmed",
      normalizedPaymentStatus: "ONLINE_PAYMENT_PENDING_OR_FAILED",
      paidAt,
      paymentMethodFamily,
      paymentMethodId,
      paymentMethodTitle,
      paymentReviewReason: null,
      transactionId,
      wooOrderStatus,
    });
  }

  return result({
    normalizedPaymentReason: "unknown_payment_method_or_status",
    normalizedPaymentStatus: "UNKNOWN_REVIEW",
    paidAt,
    paymentMethodFamily,
    paymentMethodId,
    paymentMethodTitle,
    paymentReviewReason: "Payment method/status mapping is not configured",
    transactionId,
    wooOrderStatus,
  });
}

function result(input: WooPaymentNormalizationResult): WooPaymentNormalizationResult {
  return input;
}

function classifyPaymentMethodFamily(input: {
  config: WooPaymentMethodMappingConfig | null;
  paymentMethodId: string | null;
  paymentMethodTitle: string | null;
}): WooPaymentMethodFamily | null {
  const configured = classifyConfiguredMethod(input);
  if (configured !== null) return configured;

  if (input.paymentMethodId !== null) {
    if (DEFAULT_CASH_METHOD_IDS.has(input.paymentMethodId)) return "cash";
    if (DEFAULT_TRANSFER_METHOD_IDS.has(input.paymentMethodId)) return "transfer";
    if (DEFAULT_ONLINE_METHOD_IDS.has(input.paymentMethodId)) return "online";
    return null;
  }

  const title = input.paymentMethodTitle?.toLowerCase() ?? "";
  if (/\b(cash|cod|collect on delivery|cash on delivery)\b/u.test(title)) {
    return "cash";
  }
  if (
    /\b(e-?mail|e-?transfer|bank|wire|interac|direct transfer|송금)\b/iu.test(
      title,
    )
  ) {
    return "transfer";
  }
  if (/\b(card|credit|debit|visa|mastercard|amex|stripe|paypal|square)\b/iu.test(title)) {
    return "online";
  }

  return null;
}

function classifyConfiguredMethod(input: {
  config: WooPaymentMethodMappingConfig | null;
  paymentMethodId: string | null;
  paymentMethodTitle: string | null;
}): WooPaymentMethodFamily | null {
  const methodId = input.paymentMethodId;
  if (methodId === null || input.config === null) return null;
  if (methodSet(input.config.cashMethodIds).has(methodId)) return "cash";
  if (methodSet(input.config.transferMethodIds).has(methodId)) return "transfer";
  if (methodSet(input.config.onlineMethodIds).has(methodId)) return "online";
  return null;
}

function methodSet(values: string[] | undefined): Set<string> {
  return new Set((values ?? []).flatMap((value) => {
    const normalized = normalizeToken(value);
    return normalized === null ? [] : [normalized];
  }));
}

function normalizeText(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function normalizeToken(value: string | null | undefined): string | null {
  return normalizeText(value)?.toLowerCase().replace(/\s+/gu, "_") ?? null;
}
