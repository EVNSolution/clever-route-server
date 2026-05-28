#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
process.chdir(repoRoot);

const riskyRules = [
  { name: 'private key/cert', re: /(^|\/)([^/]*(?:\.pem|\.key|\.crt|\.cer|\.p12|\.pfx|\.p8|\.pub|\.kubeconfig|\.mobileprovision|\.keystore|\.jks|\.asc|\.gpg)|[^/]*(?:_rsa|_ed25519))$/i },
  { name: 'env file', re: /(^|\/)(?:\.env|\.env\..+|.+\.env|.+\.env\..+)$/i },
  { name: 'database/dump', re: /(^|\/)[^/]*(?:\.sql|\.sql\.gz|\.dump|\.sqlite|\.sqlite3|\.db|\.db-shm|\.db-wal|\.bak)$/i },
  { name: 'playwright/browser artifact', re: /(^|\/)(?:output|playwright-report|test-results|blob-report|\.playwright|playwright\/\.auth)(?:\/|$)|(^|\/)(?:storageState[^/]*\.json|[^/]*cookies[^/]*\.txt|trace\.zip|[^/]*\.har)$/i },
  { name: 'secret scan output', re: /(^|\/)(?:\.gitleaks-report\..*|\.trufflehog-report\..*|\.secret-scan)(?:\/|$)/i },
];

function listGit(args) {
  return execFileSync('git', args, { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function normalize(file) {
  return file.split(path.sep).join('/');
}

function isAllowedTracked(file) {
  return (
    /(^|\/)\.env\.example$/i.test(file) ||
    /^infra\/env\/[^/]+\.env\.example$/i.test(file) ||
    /^apps\/delivery-api\/prisma\/migrations\/[^/]+\/migration\.sql$/i.test(file)
  );
}

function riskyMatches(file) {
  return riskyRules.filter((rule) => rule.re.test(file)).map((rule) => rule.name);
}

const trackedProblems = [];
for (const file of listGit(['ls-files']).map(normalize)) {
  const matches = riskyMatches(file);
  if (matches.length > 0 && !isAllowedTracked(file)) {
    trackedProblems.push({ file, matches });
  }
}

const unignoredProblems = [];
for (const file of listGit(['ls-files', '--others', '--exclude-standard']).map(normalize)) {
  const matches = riskyMatches(file);
  if (matches.length > 0 && !isAllowedTracked(file)) {
    unignoredProblems.push({ file, matches });
  }
}

if (trackedProblems.length || unignoredProblems.length) {
  console.error('Ignore hygiene failed: prohibited artifacts are tracked or unignored.');
  for (const problem of trackedProblems) {
    console.error(`tracked: ${problem.file} [${problem.matches.join(', ')}]`);
  }
  for (const problem of unignoredProblems) {
    console.error(`unignored: ${problem.file} [${problem.matches.join(', ')}]`);
  }
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, trackedProblems: 0, unignoredProblems: 0 }, null, 2));
