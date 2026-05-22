# WooCommerce Customer Onboarding Rehearsal Runbook

Date: 2026-05-22
Scope: one controlled customer WooCommerce test order after staging/server gates pass.

This runbook is for the first real customer onboarding rehearsal using CLEVER Route's protected Woo credential onboarding API and WooCommerce signed webhooks.

## Preconditions

- Local verification and staging smoke checklist have passed.
- `DELIVERY_API_PUBLIC_URL` is `https://clever-route.cleversystem.ai`.
- `CLEVER_ADMIN_API_TOKEN` and `CREDENTIAL_ENCRYPTION_KEY` are configured server-side.
- `PRIVACY_CONTACT_EMAIL` is either an official business/privacy email or intentionally unset with pending contact copy.
- The customer/operator understands that exactly one controlled test order will be created.
- The tenant/shop/company mapping for the customer site is known before credential entry.

## Data handling rules

- Never paste Woo Consumer Key, Consumer Secret, webhook secret, admin token, or encryption key into Git, docs, Slack snippets, screenshots, or OMX artifacts.
- Store credentials only through the protected admin API.
- Evidence notes may include redacted connection IDs, status codes, timestamps, and sanitized error classes, but not raw payload secrets.

## Rehearsal steps

1. Customer/operator generates a WooCommerce REST API key in Woo Admin with the minimum permissions required for this phase.
2. Operator submits Woo site URL, Consumer Key, and Consumer Secret to the protected CLEVER admin API for the correct tenant/shop/company.
3. Server validates Woo REST access using a low-impact endpoint.
4. Server stores the credential encrypted and returns only safe connection metadata.
5. Operator generates or rotates the connection webhook secret through the protected admin API.
6. Operator manually registers WooCommerce webhook:
   - Delivery URL: `https://clever-route.cleversystem.ai/woocommerce/webhooks/:connectionId/orders`
   - Topic: approved order event for this phase
   - Secret: one-time webhook secret from the protected admin API response
7. Customer/operator creates one controlled test order.
8. Confirm CLEVER receives a signed webhook for the expected connection and tenant.
9. Confirm route/order side effects match the current implementation contract.
10. Confirm application logs and API responses do not reveal raw secrets.
11. Record redacted rehearsal evidence.

## Stop conditions

Stop immediately and do not continue the rehearsal if:

- any response or log reveals Woo REST keys, webhook secret, admin token, encryption key, or raw customer PII;
- Woo REST validation fails with an ambiguous or unsanitized error;
- webhook signature verification fails after confirming the exact URL and secret;
- tenant/shop/company scoping is ambiguous;
- production customer data is accidentally used outside the controlled test order;
- anyone attempts to start future browser `/admin` UI work before auth/session/CSRF/cookie/tenant ADR approval.

## Redacted evidence template

```text
Date/time:
Operator:
Customer/site identifier, redacted:
Connection id, redacted:
Woo REST validation: pass/fail, sanitized reason if fail
Webhook registration: pass/fail
Test order created: yes/no, redacted order reference
Signed webhook received: yes/no
Invalid signature control tested: yes/no
Secret/log scan result: pass/fail
Follow-up required:
```

## Follow-up after successful rehearsal

- Confirm whether automatic webhook registration is still deferred or should receive a new ADR.
- Confirm whether future same-host protected `/admin` pages should enter a new `$ralplan` for auth/session/CSRF/cookie/tenant decisions.
- Keep the bootstrap script as an internal emergency fallback, not the primary onboarding path.
