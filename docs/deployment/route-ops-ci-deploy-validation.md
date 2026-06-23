# Route Ops CI and deploy validation lanes

This project keeps code validation and production rollout validation separate to avoid duplicate GitHub Actions usage.

## Lanes

- **Pull request CI is disabled** to avoid paying for branch checks that will be superseded by main/deploy validation. Run local targeted checks before opening a PR.
- **Main push CI** is the automatic code validation lane. It runs hygiene checks, cancels stale runs, and escalates API/shared/critical paths through the classifier.
- **Manual full verify** is available from the `CI` workflow through `workflow_dispatch` with `full_verify=true`.
- **Route Ops simple deploy** is deployment/runtime validation only: image build/push as needed, SSM deploy, migration, health/smoke, and rollback evidence. It must not grow broad lint/typecheck/test suites.

## Critical path policy

The classifier marks shared package changes, Prisma/migrations, deploy scripts/workflows/compose, driver/auth/proof-media paths, and Route Ops optimization/geocoding/route-plan paths as critical. Ambiguous shared changes should prefer `full_required=true` over under-testing.

## Web artifact dependency

Some delivery API admin tests need `apps/route-ops-web/dist`. The classifier exposes `web_artifact_required` so CI can build/upload the web artifact for API validation without implying that all web lint/typecheck/tests must run.

## Operator rule

Use local targeted checks before PRs. Use main push CI for automatic validation, manual full verify before risky deploys/large merges, and simple deploy to prove rollout health, not broad code correctness.
