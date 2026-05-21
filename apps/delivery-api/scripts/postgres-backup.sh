#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUTPUT="${BACKUP_DIR}/clever_route_${STAMP}.dump"

mkdir -p "$BACKUP_DIR"
pg_dump --format=custom --no-owner --no-acl --file "$OUTPUT" "$DATABASE_URL"
printf 'backup=%s\n' "$OUTPUT"
