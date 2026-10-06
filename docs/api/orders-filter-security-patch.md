# Filter followup: inherited dependency audit remediation

This is an explicit dependency-only followup to filter commit `7af844ab569992c0da0d89675015a92a35cf9c1f` in draft PR468. It does not alter original PR467, web PR311, application source, schema or runtime deployment. The existing `audit:production` command remains `npm audit --omit=dev --omit=optional --audit-level=moderate`.

| Installed before | Minimum selected | Reason |
|---|---|---|
| Fastify 5.12.1 | 5.12.5 | Latest applicable advisory minimum; remains Fastify 5. |
| fast-uri 3.1.6 | 3.1.8 | Existing AJV/compiler/stringify-6 chain; remains major 3. |
| nested fast-uri 4.1.3 | 4.1.5 | Existing stringify-7 chain; remains major 4. |

Fastify's dependency ranges are identical between these patch versions. Exact Fastify and version-scoped fast-uri overrides select only these minimum safe patches, avoiding an unrelated fast-uri 4.2.x update and avoiding a major change in either chain. The lockfile changes only the three package entries plus the root Fastify constraint. No exceptions, lowered thresholds or advisory ignores are added. Node >=22 and Fastify plugins retain their existing versions/ranges. Future dependency updates should revisit the exact pins alongside their upstream minimum requirements.

## Official advisory evidence (checked 2026-10-01)

- Fastify HTTP/2 trailer crash: [GHSA-4mh8-r7rc-xpvc](https://github.com/advisories/GHSA-4mh8-r7rc-xpvc), patched in 5.12.5.
- Fastify async validation collision, malformed-URL not-found authentication, false schemas and header normalization: [GHSA-667r-xxjv-c9mm](https://github.com/advisories/GHSA-667r-xxjv-c9mm), [GHSA-p68q-wchp-6fh7](https://github.com/advisories/GHSA-p68q-wchp-6fh7), [GHSA-hwr6-493r-vm6h](https://github.com/advisories/GHSA-hwr6-493r-vm6h), [GHSA-9q9j-q6p8-xq58](https://github.com/advisories/GHSA-9q9j-q6p8-xq58): patched in 5.12.2; covered by 5.12.5.
- fast-uri authority port/bracket issues: [GHSA-qw65-cvwx-89v3](https://github.com/advisories/GHSA-qw65-cvwx-89v3), [GHSA-58mr-gqgx-xq4g](https://github.com/advisories/GHSA-58mr-gqgx-xq4g): patched in 3.1.7/4.1.4.
- fast-uri percent-encoded host normalization: [GHSA-hrr3-gc8f-f4qj](https://github.com/advisories/GHSA-hrr3-gc8f-f4qj), patched in 3.1.8/4.1.5; mailto field handling: [GHSA-jvvf-x445-j334](https://github.com/advisories/GHSA-jvvf-x445-j334), patched in 4.1.5. The earlier high-only patch versions are insufficient for the unchanged moderate audit threshold.

## Selective recovery

Pre-patch commit: `7af844ab569992c0da0d89675015a92a35cf9c1f`. package.json SHA256 `a0a20e62d2685e8f1edd99651859a885fecd0e00c4ae0c38645ab3418d84262b`; package-lock.json SHA256 `3a94e2b72c68f491ca063779ff4a70004078caf4ff5f729835ef9ac984f884d5`. Both were byte-identical to dependency PR467. Local copies and baseline metadata are preserved in task evidence before editing.

If this patch needs selective reversal, revert only its separate dependency commit while retaining filter commit 7af844a and PR467. That recovery restores known vulnerable dependency versions and will re-block audit; it is not a safe release target. No DB restore is needed. Runtime deployment/rollback remains separately approved. No merge or deploy is performed by this change.

## Validation

Production audit passed with zero vulnerabilities under the unchanged moderate threshold. A fresh lockfile install resolved exactly Fastify 5.12.5, fast-uri 3.1.8 and nested 4.1.5. Prisma generation/validation, typed ESLint, typecheck and all 2,775 ordinary API tests passed (197 guarded tests skipped); the separate task-owned PostgreSQL filter suite passed all 18 unit/auth/API/database checks. API build passed. Full remote CI, including its existing disposable PostgreSQL profile, will validate the exact published followup head. The temporary local DB was stopped after testing; no production DB or runtime was accessed.
