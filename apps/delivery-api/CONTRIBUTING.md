# Contributing to delivery-api

This package is the CLEVER route server delivery API. Product scope and
migration constraints live in `docs/project-brief.md`; agent workflow rules live
in the nearest `AGENTS.md` files.

## Branch and issue flow

Work on branches and PRs. Do not push implementation work directly to `main`.
Link non-trivial work to the relevant `EVNSolution/clever-change-control` issue
or target repo issue when available.

## Local setup

Recommended Node version: 22 LTS.

```bash
nvm use
npm ci
cp .env.example .env
npm run dev
```

Do not commit `.env*` files other than `.env.example`.

## Required checks before PR

```bash
npm run prisma:generate
npm run lint
npm run typecheck
npm run test
npm run build
git diff --check
```

## Privacy and safety review points

- Do not expose stop, customer, address, coordinate, event, or proof-media data
  before server-side tenant/company and assigned-driver scope checks pass.
- Keep Shopify tokens, Woo credentials, webhook secrets, DB passwords, driver JWT
  secrets, and private evidence out of logs, responses, fixtures, and committed
  files.
- Treat proof-media bytes as private operational evidence.
- Keep Shopify-named compatibility fields additive until WordPress/Woo migration
  evidence proves a safe replacement path.
