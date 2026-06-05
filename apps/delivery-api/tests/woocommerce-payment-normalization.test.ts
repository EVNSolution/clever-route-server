import { describe, expect, test } from "vitest";

import {
  normalizeWooCommercePaymentStatus,
} from "../src/modules/woocommerce/woocommerce-payment-normalization.js";

describe("normalizeWooCommercePaymentStatus", () => {
  test("classifies representative Woo payment/status combinations into safe buckets", () => {
    expect(normalizeWooCommercePaymentStatus({
      payment_method: "cod",
      payment_method_title: "Cash",
      status: "processing",
    }).normalizedPaymentStatus).toBe("CASH_COLLECT_REQUIRED");

    expect(normalizeWooCommercePaymentStatus({
      payment_method: "bacs",
      payment_method_title: "E-mail transfer",
      status: "on-hold",
    }).normalizedPaymentStatus).toBe("TRANSFER_CHECK_PENDING");

    expect(normalizeWooCommercePaymentStatus({
      payment_method: "stripe",
      payment_method_title: "Credit Card",
      status: "pending",
    }).normalizedPaymentStatus).toBe("ONLINE_PAYMENT_PENDING_OR_FAILED");

    expect(normalizeWooCommercePaymentStatus({
      payment_method: "stripe",
      payment_method_title: "Credit Card",
      status: "processing",
      transaction_id: "txn_123",
    }).normalizedPaymentStatus).toBe("PAID_CONFIRMED");

    expect(normalizeWooCommercePaymentStatus({
      payment_method: "custom_gateway",
      payment_method_title: "Mystery payment",
      status: "on-hold",
    }).normalizedPaymentStatus).toBe("UNKNOWN_REVIEW");

    expect(normalizeWooCommercePaymentStatus({
      payment_method: "custom_gateway",
      payment_method_title: "Mystery payment",
      status: "processing",
    }).normalizedPaymentStatus).toBe("UNKNOWN_REVIEW");
  });

  test("keeps unmapped custom method ids in review even when titles look collectable", () => {
    expect(normalizeWooCommercePaymentStatus({
      payment_method: "custom_cash_gateway",
      payment_method_title: "Cash",
      status: "processing",
    })).toEqual(expect.objectContaining({
      normalizedPaymentStatus: "UNKNOWN_REVIEW",
      paymentMethodFamily: null,
      paymentReviewReason: "Payment method/status mapping is not configured",
    }));

    expect(normalizeWooCommercePaymentStatus({
      payment_method: "custom_card_gateway",
      payment_method_title: "Credit Card",
      status: "processing",
    })).toEqual(expect.objectContaining({
      normalizedPaymentStatus: "UNKNOWN_REVIEW",
      paymentMethodFamily: null,
    }));
  });

  test("uses title heuristics only when Woo omits a payment method id", () => {
    expect(normalizeWooCommercePaymentStatus({
      payment_method: "",
      payment_method_title: "Cash",
      status: "processing",
    }).normalizedPaymentStatus).toBe("CASH_COLLECT_REQUIRED");

    expect(normalizeWooCommercePaymentStatus({
      payment_method: null,
      payment_method_title: "E-mail transfer",
      status: "on-hold",
    }).normalizedPaymentStatus).toBe("TRANSFER_CHECK_PENDING");
  });

  test("exception Woo statuses override method and paid evidence", () => {
    for (const status of ["cancelled", "refunded", "failed", "trash"]) {
      expect(normalizeWooCommercePaymentStatus({
        date_paid_gmt: "2026-05-21T00:00:00",
        payment_method: "stripe",
        payment_method_title: "Credit Card",
        status,
        transaction_id: "txn_123",
      })).toEqual(expect.objectContaining({
        normalizedPaymentStatus: "NOT_DELIVERABLE_OR_EXCEPTION",
        paymentReviewReason: `Woo order status is ${status}`,
      }));
    }
  });

  test("connection-specific method config wins before title heuristics", () => {
    expect(normalizeWooCommercePaymentStatus({
      payment_method: "tomatono_email_transfer",
      payment_method_title: "Store Custom Payment",
      status: "pending",
    }, {
      transferMethodIds: ["tomatono_email_transfer"],
    }).normalizedPaymentStatus).toBe("TRANSFER_CHECK_PENDING");

    expect(normalizeWooCommercePaymentStatus({
      payment_method: "custom_cash",
      payment_method_title: "Credit card-looking title",
      status: "pending",
    }, {
      cashMethodIds: ["custom_cash"],
    }).normalizedPaymentStatus).toBe("CASH_COLLECT_REQUIRED");
  });
});
