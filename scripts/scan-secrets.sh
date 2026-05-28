#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

if [ "$#" -eq 0 ]; then
  set -- --staged --worktree
fi

HISTORY=false
WORKTREE=false
STAGED=false
LOCAL_FULL=false
for arg in "$@"; do
  case "$arg" in
    --history) HISTORY=true ;;
    --worktree) WORKTREE=true ;;
    --staged) STAGED=true ;;
    --local-full) LOCAL_FULL=true ;;
    --help|-h)
      cat <<'HELP'
Usage: scripts/scan-secrets.sh [--staged] [--worktree] [--history] [--local-full]

Redacted secret scan wrapper. It prints rule/file/line only, never matched values.
--staged scans staged paths. --worktree scans tracked + untracked non-ignored files.
--history uses gitleaks when installed. Set SECRET_SCAN_REQUIRE_GITLEAKS=1 to fail if missing.
--local-full also scans ignored local files and should never upload raw output.
HELP
      exit 0 ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

scan_paths() {
  local label="$1"
  local path_file="$2"
  node - "$label" "$path_file" <<'NODE'
const fs = require('node:fs');
const label = process.argv[2];
const pathFile = process.argv[3];
const paths = fs.existsSync(pathFile) ? fs.readFileSync(pathFile, 'utf8').split(/\r?\n/).filter(Boolean) : [];
const rules = [
  { name: 'private_key_block', re: /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'github_token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { name: 'slack_token', re: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
  { name: 'stripe_live_key', re: /\bsk_live_[A-Za-z0-9]{16,}\b/ },
  { name: 'aws_access_key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
];
const allow = [
  /AKIA_TEST\b/,
  /AKIA_TEST_VALUE\b/,
  /AKIAIOSFODNN7EXAMPLE\b/,
  /wJalrXUtnFEMI\/K7MDENG\/bPxRfiCYEXAMPLEKEY/,
  /sk_live_\[A-Za-z0-9\]\+/,
];
let findings = 0;
let scanned = 0;
for (const file of paths) {
  if (!file || file.includes('\0')) continue;
  if (!fs.existsSync(file)) continue;
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 2_000_000) continue;
  const buf = fs.readFileSync(file);
  if (buf.includes(0)) continue;
  const text = buf.toString('utf8');
  scanned += 1;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (allow.some((re) => re.test(line))) continue;
    for (const rule of rules) {
      if (rule.re.test(line)) {
        findings += 1;
        console.error(`${label}: ${file}:${i + 1}: ${rule.name}: <redacted>`);
      }
    }
  }
}
console.log(JSON.stringify({ ok: findings === 0, label, scannedFiles: scanned, findings }, null, 2));
process.exit(findings === 0 ? 0 : 1);
NODE
}

make_temp_paths() {
  mktemp "${TMPDIR:-/tmp}/route-ops-secret-paths.XXXXXX"
}

if [ "$STAGED" = true ]; then
  tmp="$(make_temp_paths)"
  git diff --cached --name-only --diff-filter=ACMR > "$tmp"
  scan_paths staged "$tmp"
  rm -f "$tmp"
fi

if [ "$WORKTREE" = true ]; then
  tmp="$(make_temp_paths)"
  git ls-files -co --exclude-standard > "$tmp"
  scan_paths worktree "$tmp"
  rm -f "$tmp"
fi

if [ "$LOCAL_FULL" = true ]; then
  tmp="$(make_temp_paths)"
  find . \
    -path ./.git -prune -o \
    -path ./node_modules -prune -o \
    -path './apps/*/node_modules' -prune -o \
    -path ./.omx -prune -o \
    -type f -print | sed 's#^./##' > "$tmp"
  scan_paths local-full "$tmp"
  rm -f "$tmp"
fi

if [ "$HISTORY" = true ]; then
  if command -v gitleaks >/dev/null 2>&1; then
    gitleaks detect --source . --redact --no-banner --config .gitleaks.toml
  elif [ "${SECRET_SCAN_REQUIRE_GITLEAKS:-}" = "1" ]; then
    echo "gitleaks is required for --history but is not installed" >&2
    exit 127
  else
    node <<'NODE'
const { execFileSync } = require('node:child_process');
const patterns = [
  { name: 'private_key_block', pattern: '-----BEGIN (RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----' },
  { name: 'github_token', pattern: String.raw`\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b` },
  { name: 'slack_token', pattern: String.raw`\bxox[baprs]-[A-Za-z0-9-]{20,}\b` },
  { name: 'stripe_live_key', pattern: String.raw`\bsk_live_[A-Za-z0-9]{16,}\b` },
  { name: 'aws_access_key', pattern: String.raw`\b(AKIA|ASIA)[0-9A-Z]{16}\b` },
];
const allow = [/AKIA_TEST\b/, /AKIA_TEST_VALUE\b/, /AKIAIOSFODNN7EXAMPLE\b/, /wJalrXUtnFEMI\/K7MDENG\/bPxRfiCYEXAMPLEKEY/, /sk_live_\[A-Za-z0-9\]\+/];
const commits = execFileSync('git', ['rev-list', '--all'], { encoding: 'utf8' }).split('\n').filter(Boolean);
let findings = 0;
for (const commit of commits) {
  for (const rule of patterns) {
    let out = '';
    try {
      out = execFileSync('git', ['grep', '-I', '-n', '-E', '-e', rule.pattern, commit], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 20 * 1024 * 1024 });
    } catch (error) {
      if (error.status === 1) continue;
      throw error;
    }
    for (const line of out.split('\n').filter(Boolean)) {
      if (allow.some((re) => re.test(line))) continue;
      const first = line.indexOf(':');
      const second = line.indexOf(':', first + 1);
      const third = line.indexOf(':', second + 1);
      const file = second >= 0 && third >= 0 ? line.slice(first + 1, third) : '<unknown>';
      findings += 1;
      console.error(`history: ${commit.slice(0, 12)}:${file}: ${rule.name}: <redacted>`);
    }
  }
}
console.log(JSON.stringify({ ok: findings === 0, label: 'history-fallback', commits: commits.length, findings }, null, 2));
process.exit(findings === 0 ? 0 : 1);
NODE
  fi
fi
