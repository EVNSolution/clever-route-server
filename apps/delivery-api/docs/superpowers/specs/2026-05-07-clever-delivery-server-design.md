# Historical design note — delivery server source

This file records the original 2026-05-07 design direction that created the
server later imported into `EVNSolution/clever-route-server`.

Original direction: build a separate Shopify companion delivery data server with
EC2 + PostgreSQL, order sync, webhook ingestion, route planning, driver/vehicle
APIs, and backup/restore readiness.

Current direction after the WordPress migration decision: keep the server and
mobile contracts, but treat Shopify order/admin integration as a legacy
compatibility seam while WordPress/WooCommerce ingestion is added additively.
