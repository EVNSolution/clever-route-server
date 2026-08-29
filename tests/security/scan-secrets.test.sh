#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
TEST_REPO="$(mktemp -d "${TMPDIR:-/tmp}/route-secret-scan-test.XXXXXX")"
trap 'rm -rf "$TEST_REPO"' EXIT

git -C "$TEST_REPO" init --quiet
mkdir -p "$TEST_REPO/scripts"
cp "$ROOT/scripts/scan-secrets.sh" "$TEST_REPO/scripts/scan-secrets.sh"
printf "password: 'test-password-01'\nJWT_SECRET='test-jwt-secret'\n" > "$TEST_REPO/fixtures.ts"
git -C "$TEST_REPO" add scripts/scan-secrets.sh fixtures.ts

(cd "$TEST_REPO" && scripts/scan-secrets.sh --worktree >/dev/null)

credential='ProdPassword9854!'
printf 'PASSWORD=%s\n' "$credential" > "$TEST_REPO/leaked.txt"
if output="$(cd "$TEST_REPO" && scripts/scan-secrets.sh --worktree 2>&1)"; then
  echo 'Expected the generic password fixture to fail secret scanning' >&2
  exit 1
fi
grep -F 'generic_password_assignment: <redacted>' <<<"$output" >/dev/null
if grep -F "$credential" <<<"$output" >/dev/null; then
  echo 'Secret scanner output exposed the matched value' >&2
  exit 1
fi
