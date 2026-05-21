# Location Data Handling Reference

_Last reviewed: 2026-05-11_

This document records how `clever-route-server` should treat location information so later implementation, evidence collection, and retention decisions are easy to review. It is an engineering control reference, not legal advice. Legal filings, terms, consent UX, and privacy notices remain a separate legal review track.

## Legal / regulatory anchors checked

- `위치정보의 보호 및 이용 등에 관한 법률` Article 16 requires management/technical safeguards and automatic recording/preservation of location collection/use/provision confirmation data. Source: 국가법령정보센터, Article 16, law effective 2025-10-01: https://www.law.go.kr/lsLawLinkInfo.do?chrClsCd=010202&lsJoLnkSeq=1001048442
- Enforcement Decree Article 20 lists management controls and technical controls including manager designation, access authority limitation, ledger operation, regular self-inspection, authentication, firewall/access blocking, access-log preservation, security programs, and encryption or equivalent measures. Source: 국가법령정보센터, 시행령 Article 20, effective 2026-02-10: https://www.law.go.kr/LSW/lumLsLinkPop.do?chrClsCd=010202&lspttninfSeq=79542
- Detailed standard: `위치정보의 관리적·기술적 보호조치 기준` [방송통신위원회고시 제2022-11호, 2022-06-09]. Source: https://law.go.kr/LSW/admRulLsInfoP.do?admRulSeq=2100000211939
- Planning assumption from the detailed standard: access-right grant/change/revoke records are retained for at least 5 years, location handling ledgers/confirmation records for at least 6 months, system access logs for at least 1 year, and location-protection self-inspection runs at least annually.

## Current location data inventory

| Data | Current storage | Why it exists | Sensitivity | Handling hint |
| --- | --- | --- | --- | --- |
| Delivery stop latitude/longitude | `DeliveryStop.latitude`, `DeliveryStop.longitude` | Dispatch planning, routing, geocode status | High | Keep as canonical coordinate; restrict admin/driver access by shop and route/stop ownership. |
| Driver event latitude/longitude | `DriverEvent.latitude`, `DriverEvent.longitude`, `DriverEvent.payload` | Driver route progress, live/update events | High | Treat as personal location if tied to a driver; retain raw update events for the shortest operational period. |
| Depot coordinates | `RoutePlan.depotLatitude`, `RoutePlan.depotLongitude`, route plan request | Dispatch start point | Medium | Usually business location; still keep behind admin auth. |
| Route plan stop sequence/location context | `RoutePlanStop`, related `DeliveryStop` | Route execution and audit | High when joined with customer address | Log accesses when returned through admin/driver APIs. |
| Shopify snapshot coordinates | `Order.rawPayload.shippingAddress.latitude/longitude` if app sends full snapshot | Original source snapshot | High and duplicated | Remove from raw payload in a hardening pass; keep coordinates only in `DeliveryStop`. |
| Shipping address | `Order.shippingAddress`, `DeliveryStop.address*` | Delivery destination | Personal data, can infer location | Apply same access logging and minimization mindset even without explicit GPS coordinates. |
| Email | `Order.email`, route plan payloads, tests | Legacy/customer contact | Protected customer data risk | Do not query from Shopify Admin API; stop searching/storing unless app explicitly and lawfully provides it. |

## Record classes and role separation

A single API call can create more than one compliance record. Keep these records separate so evidence is easy to explain.

| Record | Meaning | Example | Proposed retention |
| --- | --- | --- | ---: |
| `LocationPermissionAudit` | Who granted/changed/revoked location-information access rights | Admin role scope changed from route-read to route-write | 5 years |
| `LocationAccessLog` | Who accessed the location-information system/API | Admin called route detail API | 400 days |
| `LocationUsageRecord` | Statutory-style confirmation record that location information was collected, used, or provided | Driver GPS collected; route planner used stop coordinates; driver app received assigned stop coordinates | 215 days |
| `RetentionJobRun` | Internal lifecycle execution evidence for deletion, anonymization, correction, sanitizer, and backfill runs | rawPayload sanitizer dry-run/apply; driver coordinate anonymization | Keep with operational evidence policy; do not include raw location values |

## Legal classification note for records

`LocationUsageRecord` primarily exists as the automatic confirmation record for location information collection, use, and provision.

Deletion, anonymization, correction, sanitizer, and retention cleanup events are internal lifecycle audit events. Record those events in `RetentionJobRun`; link from `LocationUsageRecord` only if a future implementation explicitly marks the event as `INTERNAL_LIFECYCLE`, so statutory collection/use/provision evidence remains distinguishable.

Engineering classification rule:

- `USE`: location data is processed inside admin/server-side operations.
- `PROVIDE`: location data is returned to another principal, client app, driver app, partner system, or external recipient.
- Final legal classification remains subject to legal review.

## Automatic recording coverage map

| API / operation | `LocationAccessLog` | `LocationUsageRecord` usage kind | Notes |
| --- | ---: | --- | --- |
| `PATCH /admin/orders/sync` collecting Shopify/app coordinates | Yes | `COLLECT` | Record counts and routeScope summary only; do not log coordinates. |
| `GET /admin/orders` list/filter | Yes | `USE` when rows include address/coordinates | Include filter summary and result count. |
| `GET /admin/route-plans/:routePlanId` detail | Yes | `USE` | Route detail exposes stop/address/location context. |
| `POST /admin/route-plans` create | Yes | `USE` | Route planning uses delivery stop coordinates; record routeScopeKey and order count. |
| `POST /driver/consents` consent record write | No | Not normally usage | Consent acceptance evidence only; do not store coordinates/customer data in optional app/device/route context. |
| `GET /driver/assigned-route` | Yes | `PROVIDE` by engineering default | Enforces bearer-token shop/driver boundary before returning stop address/location context; dedicated access/usage log persistence remains follow-up. |
| Driver stop detail read, once implemented | Yes | `PROVIDE` by engineering default | Must block other drivers with 403 and log denied access without coordinates. |
| `POST /driver/proof-media` | Yes | Not normally location usage unless image metadata/location is stored | Stores proof photo metadata and file bytes under driver/shop/route/stop scope; JPEG EXIF APP1 metadata is stripped before storage and any configured scanner sees sanitized bytes before persistence to reduce accidental image location/device metadata retention and block rejected media. |
| `GET /driver/proof-media/:mediaId/access` | Yes | `PROVIDE` by engineering default | Verifies bearer-token shop/driver boundary, requires undeleted media, and returns only short-lived storage backend read access metadata; dedicated access/usage log persistence remains follow-up. |
| `POST /driver/events` with `LOCATION_UPDATED` | Yes | `COLLECT` | Driver GPS collection. |
| Retention cleanup execution | Yes | `INTERNAL_LIFECYCLE` via `RetentionJobRun` | Proof-media cleanup records sanitized scanned/deleted/missing counts, cutoff, retention days, batch limit, and optional private evidence reference; future cleanup jobs should follow the same no-raw-location/no-proof-bytes rule. |
| rawPayload sanitizer/backfill execution | Yes | `INTERNAL_LIFECYCLE` via `RetentionJobRun` | Record dry-run/apply counts and evidence artifact path. |
| Permission grant/change/revoke operation, once implemented | Yes | Not normally usage | Always create `LocationPermissionAudit`. |

## Proposed internal retention policy

These are maximum engineering defaults for the next implementation. They intentionally separate raw location data from legally required confirmation/audit records.

Retention days are maximum engineering defaults, not guaranteed holding periods. If the collection/use/provision purpose is completed earlier and no lawful retention basis remains, raw personal location data should be deleted or anonymized earlier than the configured maximum.

| Record class | Proposed default | Reason | Deletion/anonymization behavior |
| --- | ---: | --- | --- |
| `LocationPermissionAudit` | 5 years / 1,825 days | Access-right grant/change/revoke records need long-term accountability. | Delete after retention only if no legal/incident hold exists. |
| `LocationAccessLog` | 400 days | Access fact logs should be available for at least 1 year plus operational buffer. | Delete after retention unless litigation/incident hold is active. |
| `LocationUsageRecord` | 215 days | Location collection/use/provision confirmation data should be available for at least 6 months plus buffer. | Delete after retention unless legal/incident hold is active. |
| `DriverEvent` with `LOCATION_UPDATED` and raw coordinates | 90 days after occurrence | High-volume live driver GPS is rarely needed after delivery operations settle. | Null `latitude`, `longitude`, and coordinate fields inside `payload`; keep non-location event metadata if still operationally useful. |
| Other `DriverEvent` rows tied to proof of delivery/failure | 180 days after occurrence | Needed for customer support and delivery dispute handling. | Remove embedded coordinate fields from `payload` after 90 days; keep event type/timestamps longer if needed. |
| `DriverProofMedia` rows and stored proof files | 180 days after occurrence/upload by default | Needed for customer support and delivery dispute handling. | Delete stored file bytes through the configured proof-media storage backend and mark/delete metadata after retention unless legal/incident hold exists; stored JPEG bytes have EXIF APP1 metadata stripped before hash/size recording and accepted media can pass through a scanner hook before persistence. |
| `DeliveryStop.latitude/longitude` | 180 days after `deliveryDate` by default | Needed for active routing, route review, and short-term support. | Null coordinates and mark retained address data separately if order history must remain. |
| `Order.rawPayload` location/customer extras | Sanitize at write time and backfill existing rows | Raw source snapshots duplicate sensitive values and are hard to govern. | Store only normalized operational fields; omit email and raw latitude/longitude. |
| PostgreSQL backups | 35 days rolling, unless incident hold | Backups can contain location and customer data. | Encrypt at rest; expire backup files; document restore access. |

Retention values should be environment-configurable before production hardening:

```env
LOCATION_PERMISSION_AUDIT_RETENTION_DAYS=1825
LOCATION_ACCESS_LOG_RETENTION_DAYS=400
LOCATION_USAGE_RECORD_RETENTION_DAYS=215
DRIVER_LOCATION_EVENT_RETENTION_DAYS=90
DELIVERY_STOP_COORDINATE_RETENTION_DAYS=180
POSTGRES_BACKUP_RETENTION_DAYS=35
```

## Processing rules for future code changes

1. **Minimize duplicate coordinates**: canonical GPS belongs in `DeliveryStop` or `DriverEvent`; do not also keep it in `Order.rawPayload` unless a test documents why.
2. **Split new-write sanitizing and existing-data backfill**: stop writing new `rawPayload` coordinates/email first, then run a dry-run/apply backfill against existing `Order.rawPayload` rows and store evidence.
3. **Log reads, not just writes**: returning admin orders, route plan details, driver route/stop details, or driver location events should emit access/usage records.
4. **Do not put sensitive values in compliance logs**: metadata should store IDs, counts, action names, routeScopeKey, and evidence artifact references; omit addresses, phones, emails, recipient names, and coordinates.
5. **Tenant boundary first**: every query touching location data must include `shopId`/`shopDomain` scoping.
6. **Driver boundary second**: driver APIs must only expose route/stop data assigned to that driver or active session context.
7. **Use immutable-ish logs**: application code should insert audit rows, not update them. Retention cleanup is the only planned deleter.
8. **Classify `USE` / `PROVIDE` consistently**: server-side/admin processing is `USE`; returning location data to a separate principal/client/driver/partner is `PROVIDE` until legal review decides otherwise.
9. **Evidence must match reality**: do not claim DRF, Traefik, MQTT, AES-256 field encryption, 8-level RBAC, or GuardDuty unless the deployed system actually has it.

## Evidence folder shape

When implemented, store screenshots/log exports/run outputs under:

```text
docs/compliance/evidence/location-protection/
  00-location-data-inventory.md
  01-access-authentication.md
  02-network-encryption-firewall.md
  03-access-log-and-usage-records.md
  04-security-programs-monitoring.md
  05-retention-and-deletion-runs.md
  06-permission-grant-change-revoke-audit.md
  07-annual-self-inspection.md
  08-training-and-handler-guideline.md
```

Each evidence file should include date, environment, command/source, captured output summary, owner, and known gaps. Do not paste raw coordinates, full addresses, phone numbers, or emails into evidence files.

## Management safeguard documents to prepare

The codebase can support technical controls, but the service plan also needs management evidence:

- Location information manager/responsible person designation.
- Location information handler guideline covering allowed use, prohibited copying/export, incident escalation, and retention.
- Handler onboarding/training record and recurring training evidence.
- Annual self-inspection checklist and result evidence.
- Access-right review evidence for grant/change/revoke records.

## Known current gaps

- `DriverConsentRecord` exists for notice acceptance evidence and `DriverProofMedia` exists for scoped proof upload metadata; no dedicated `LocationAccessLog` / `LocationUsageRecord` / `LocationPermissionAudit` models yet.
- Proof-media read access is scoped through the bearer-token shop/driver boundary and a short-lived storage backend read-access contract; the default local backend does not expose public file URLs, while the S3-compatible backend can issue SigV4 presigned read URLs when explicitly configured. Production bucket/IAM approval and signed-access evidence remain open.
- Proof-media retention cleanup support exists for local stored bytes and `deletedAt` metadata marking through the driver proof-media repository. `npm run driver:proof-media:cleanup` is available for manual or cron-style execution and persists a sanitized `RetentionJobRun` row for private scheduler evidence; no deployed scheduler evidence exists yet.
- Proof-media scanner rejection and scan-outcome monitor hooks exist before byte/metadata persistence, and optional HTTP scanner/monitor adapters can be selected by runtime env. Production scanner endpoint deployment, alert routing, private evidence storage, and monitoring/alerting evidence are not complete yet.
- No 5-year access-right grant/change/revoke audit table yet.
- Raw payloads can still duplicate coordinates from Shopify/app snapshots.
- Existing `Order.rawPayload` rows require a backfill sanitizer pass.
- Admin order search still includes `Order.email` at repository level even though Shopify query no longer requests email.
- API-level read logging coverage is not yet mapped endpoint-by-endpoint in code.
- Route plan scope validation is implemented, but top-level route-scope fields on order inputs should be accepted to reduce app coupling to `rawPayload`.
- Route-plan time-window conversion should reuse the same Toronto timezone helper as order sync.
- Management evidence is not complete yet: location information manager, handler guideline, training record, and annual self-inspection evidence must be added.
