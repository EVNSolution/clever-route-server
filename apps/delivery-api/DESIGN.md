# CLEVER Route Admin UI Design Contract

Source: initialized with `npx getdesign@latest add apple --out apps/delivery-api/DESIGN.md` on 2026-05-26, then narrowed for the CLEVER Route server admin UI.

## Scope

This file applies only to the Fastify SSR browser admin UI in `apps/delivery-api`, especially `/admin/ui` and its protected sub-pages. It does not define visual rules for the WordPress connector plugin, customer WordPress admin screens, JSON APIs, driver app, or infrastructure docs.

## Trademark and asset guardrails

- Use Apple-inspired qualities only: calm hierarchy, generous spacing, system typography, restrained color, and high polish.
- Do not use Apple logos, Apple product imagery, Apple marks, copied Apple layouts/assets, or external Apple-hosted assets.
- Do not imply an Apple partnership, endorsement, or visual identity.
- Use CLEVER-owned naming, icons, screenshots, and operational copy.
- External fonts/images are not required for the server admin MVP; prefer local/system resources.

## Product intent

The CLEVER admin UI is an operator tool. It should feel precise, quiet, and trustworthy rather than promotional. Operators must quickly understand where they are, what is already configured, and which action is safe to take next.

Current canonical structure:

- `/admin/ui` — protected admin dashboard and default browser entry.
- `/admin/ui/login` — protected web-login surface using the dedicated admin web secret.
- `/admin/ui/logout` — protected logout endpoint.
- `/admin/ui/commerce-connections` — commerce-source overview.
- `/admin/ui/commerce-connections/woocommerce` — WooCommerce credential and webhook onboarding module.
- `/admin/ui/route-plans`, `/admin/ui/settings`, `/admin/ui/orders`, `/admin/ui/drivers` — protected planned-module placeholders until real module work starts.

## Principles

1. **Admin first, integration second** — the first page is the CLEVER server admin dashboard, not a WooCommerce-only screen.
2. **Security visible but not noisy** — explain write-only secrets, one-time webhook secrets, and protected pages in plain language.
3. **Generous whitespace** — use spacing to reduce operational stress and make destructive or sensitive actions easier to distinguish.
4. **Restrained surfaces** — use neutral cards, light borders, and minimal elevation. Avoid decorative gradients and heavy shadows.
5. **System typography** — use platform-native font stacks; no external font fetch is required.
6. **No secret echoing** — never render submitted REST keys, REST secrets, webhook secrets, ciphertext, API tokens, or session material.

## Visual tokens

```yaml
colors:
  canvas: "#f5f5f7"
  card: "rgba(255, 255, 255, 0.92)"
  ink: "#1d1d1f"
  muted: "#6e6e73"
  line: "#d2d2d7"
  accent: "#0071e3"
  success: "#067647"
  danger: "#b42318"

typography:
  family: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', ui-sans-serif, system-ui, sans-serif"
  h1: "clamp(34px, 5vw, 56px), 600, tight tracking"
  h2: "24-28px, 600, tight tracking"
  body: "16-17px, 400"
  small-label: "12px, 700, uppercase, 0.08em tracking"

radii:
  card: "24px"
  input: "10px"
  pill: "999px"

spacing:
  page-x: "20px min, 40px preferred"
  page-y: "44px"
  card: "28px"
  gap: "20px"
```

## Components

### Admin shell

- Header card with eyebrow, page title, explanatory subtitle, primary nav, and logout form.
- Navigation links are pills. Active state uses the accent color with white text.
- Exact `/admin` may redirect to `/admin/ui`, but browser UI pages live under `/admin/ui/*`.
- Do not create broad `/admin/*` catch-all redirects because `/admin/*` also contains JSON API routes.

### Dashboard module card

- Use cards for module entry points.
- Each card needs title, short operational description, status pill, and link.
- Ready modules use `Ready`; not-yet-implemented modules use `Planned` and must not pretend the feature is complete.

### Forms

- Labels stay visible above each input.
- Secret inputs use `type="password"` and `autocomplete="off"`.
- Do not prefill or echo stored secrets.
- Form action URLs should point to canonical `/admin/ui/*` browser routes.

### Guided setup pages

- Start sensitive onboarding with a checklist before secret fields so operators know exactly what to gather from the customer system.
- Use one consolidated credential form for normal setup; do not duplicate separate "test" and "create" secret-entry forms on the same page.
- Use secondary buttons with explicit labels for safe validation-only actions, and primary buttons for persisted changes.
- Keep generated secrets one-time and copy-now; stored or supplied secrets must never be rendered later.
- Explain integration readiness as a sequence: REST credential verification, WooCommerce webhook creation, then accepted signed order webhook.

### Alerts

- Success alerts use a soft green background and clear one-line confirmation.
- Error alerts use a soft red background and sanitized messages only.
- Never include submitted secrets or tokens in alert copy.

### Tables / connection cards

- Use definition-list style metadata for connection details.
- Long URLs and identifiers must wrap safely.
- Sensitive fields display only status/fingerprint metadata, never raw credentials.

## Interaction rules

- State-changing browser actions require a valid admin UI session, CSRF token, and same-origin request.
- Logout clears both the current `/admin/ui` cookie and the legacy Woo-specific cookie path.
- Legacy Woo login routes redirect to `/admin/ui/login`; they must not forward submitted credentials.
- Placeholder pages are protected and clearly marked as planned modules.

## Accessibility

- Keep body text at 16px or larger.
- Maintain 44px minimum touch/click targets for buttons and important nav links.
- Use semantic headings in order.
- Preserve visible labels for every input.
- Use color plus text/status labels; do not rely on color alone.

## Do

- Use `/admin/ui` as the operator-facing URL in docs and UI copy.
- Use cards to separate dashboard modules and sensitive Woo actions.
- Use system typography, tight heading tracking, calm surfaces, and restrained accent color.
- Keep future modules labeled `Planned` until real backing functionality exists.
- Keep JSON API and browser UI language separate.

## Don't

- Don't use Apple logos, Apple product imagery, Apple marks, copied Apple layouts/assets, or external Apple assets.
- Don't create a broad `/admin/*` browser redirect.
- Don't widen browser session cookies to all `/admin` routes.
- Don't display API bearer tokens or Woo secrets in HTML.
- Don't add heavy promotional imagery to credential onboarding.
- Don't introduce a separate SPA or frontend package without a new ADR.

## Implementation notes for current SSR UI

- Current CSS should remain inline in the Fastify SSR document until a second real admin module justifies extraction.
- A future split can introduce `admin-ui-shell.ts`, `admin-ui-layout.ts`, and module-specific route files.
- The design language should be treated as a CLEVER-owned admin style, not as a replica of any third-party website.
