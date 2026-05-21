# Runtime log inspection

Use the **Inspect CLEVER route server runtime** GitHub Actions workflow when
direct SSH is not available. It is intended for a self-hosted runner on the EC2
host and prints only safe operational diagnostics:

- Docker Compose service status.
- recent `delivery-api` container logs.
- recent `caddy` container logs.
- optional non-secret route plan DB summary.

Recommended inputs:

```text
log_since=2h
LOG_TAIL=300
INCLUDE_DB_COUNTS=true
```

The inspection script intentionally does not print `.env`, process environment
variables, Shopify secrets, Woo secrets, JWT secrets, or database passwords.

## Caddy access logs

The delivery-only runtime Caddyfile is expected at
`infra/caddy/Caddyfile` and serves `clever-route.cleversystem.ai`. If access logs
are needed, add a sanitized Caddy log block in the host-managed runtime config
and verify no tokens, credentials, request bodies, or private evidence are
printed.
