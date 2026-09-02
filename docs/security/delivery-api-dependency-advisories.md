# Delivery API dependency advisory boundary

Issue: `EVNSolution/clever-route-server#359`

Change control: `EVNSolution/clever-change-control#277`

## Enforced production boundary

The Delivery API runtime image excludes development and optional dependencies.
CI audits the same boundary with:

```bash
npm --prefix apps/delivery-api run audit:production
```

The 2026-09-02 baseline changed from 14 moderate/high dependency-tree findings
to 9 after supported patch and minor updates. The production boundary reports
zero moderate, high, or critical findings when both omitted dependency classes
are excluded.

## Remaining non-runtime findings

- Prisma CLI and `@prisma/config` resolve `deepmerge-ts@7.1.5`. These packages
  are needed for trusted build and migration tooling but are pruned from the
  runtime image. Prisma 7 remains a breaking migration and currently resolves
  the same `deepmerge-ts` release, so neither a forced downgrade nor a major
  upgrade is an advisory fix.
- Firebase Admin declares optional Google Cloud packages that include the
  remaining `uuid`, `gaxios`, `teeny-request`, and `retry-request` findings.
  The service uses only `firebase-admin/app` and `firebase-admin/messaging`.
  Optional packages are pruned from the runtime image, and the image build
  verifies those two imports after pruning.

Reopen the risk decision if the service begins using Firebase Storage or
Firestore, if Prisma exposes untrusted configuration input, or if the
production audit becomes non-zero.
