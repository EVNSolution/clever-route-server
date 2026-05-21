#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_FILE:?BACKUP_FILE is required}"

if [ ! -f "$BACKUP_FILE" ]; then
  echo "BACKUP_FILE not found: $BACKUP_FILE" >&2
  exit 1
fi

pg_restore --clean --if-exists --no-owner --no-acl --dbname "$DATABASE_URL" "$BACKUP_FILE"
printf 'restored=%s\n' "$BACKUP_FILE"
