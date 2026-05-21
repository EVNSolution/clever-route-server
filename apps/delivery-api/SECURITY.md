# Security Policy

## Reporting a vulnerability

Report security or privacy issues privately to the EVNSolution maintainers. If GitHub private vulnerability reporting is enabled for this repository, use that channel. Otherwise, contact the repository owner or the project maintainer through the existing EVNSolution coordination channel before opening a public issue.

Do not post real Shopify tokens, JWT secrets, driver phone numbers, customer addresses, route data, location records, proof media, database dumps, production env files, or access logs in public issues, pull requests, logs, or screenshots.

## Scope

Security review for this server includes:

- Shopify App Bridge session-token verification and token exchange
- encrypted Shopify Admin API token storage
- Shopify webhook HMAC validation and idempotent receipt recording
- tenant/company, route, stop, and assigned-driver authorization boundaries
- driver route-access, consent, assigned-route, event, and proof-media APIs
- proof-media storage keys, retention, deletion, retrieval access, scan-hook behavior, and malware-scanner deployment controls
- PostgreSQL schema changes, migrations, backups, and runtime deployment configuration
- environment variables, secrets, logs, and operational evidence handling

## Current supported branches

- `main`: deploy branch
- `dev`: integration branch
- active issue-linked `cc-<change-control>-<scope>` branches under review

## Data-handling expectations

- `.env*` files, production secrets, database dumps, local proof-media files, build outputs, and logs must remain ignored unless a sanitized example is explicitly intended for git.
- Public API responses must not leak Shopify Admin tokens, driver JWT secrets, unrelated tenant data, raw proof-media paths, or internal storage roots.
- Driver data access must remain scoped by shop/company, assigned driver, route plan, and stop membership before disclosing route details or accepting proof evidence.
- Proof-media production hardening must address object-storage bucket/IAM ownership, S3 signing credential custody, signed retrieval/access evidence, HTTP scanner endpoint custody, deployed malware scanner evidence, scan alert evidence, deletion, and retention before release use.
- Proof-media cleanup evidence in `RetentionJobRun` must stay sanitized: counts, timestamps, retention policy, and private evidence references only; do not store media ids, storage keys, proof bytes, coordinates, phone numbers, or customer data there.

## Evidence handling

When sharing reproduction evidence, use synthetic shop domains, route contexts, driver phone numbers, customer addresses, coordinates, proof media, and redacted logs. Completed proof-media production evidence manifests belong in the private evidence store and should be validated only through a local working copy with `npm run driver:proof-media:evidence:verify -- <private-manifest-path>`. If real production data is unavoidable for diagnosis, coordinate privately and keep the evidence out of git.
