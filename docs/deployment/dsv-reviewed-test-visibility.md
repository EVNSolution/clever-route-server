# Reviewed DSV test visibility

The versioned configuration in `apps/delivery-api/src/modules/dsv/dsv-reviewed-test-exclusions.ts` contains exactly 90 order IDs, 7 route IDs and 2 vehicle IDs for the reviewed DSV tenant. Names, accounts, upload names, current GPS reception and roles do not classify records. Other tenants retain their existing read behavior.

Presentation repositories apply shared predicates before pagination and counts. Direct route/order/proof reads use the same boundary; developer administrators have no bypass. Original imports remain persisted, while import responses omit only rows linked to reviewed orders. Mixed group responses retain formal orders and omit reviewed children, assignments and cached branch geometry. Internal grouping mutation authority reads retain the complete stored membership.

This change neither deletes nor deactivates data and adds no schema, migration, runtime setting or notification. It preserves source uploads, accounts, GPS devices, states, proof storage and foreign keys.

An authorized operator can restore presentation by removing reviewed IDs from this configuration through the normal reviewed PR and deployment process. There is no client include-hidden parameter or role-based override. For immediate image recovery, use the deployment rollback image manifest and procedure in `docs/deployment/route-ops-simple-ssm-deploy.md`. A selective revert of the visibility commit removes the policy. These procedures restore visibility/code; they do not restore previously deleted records.
