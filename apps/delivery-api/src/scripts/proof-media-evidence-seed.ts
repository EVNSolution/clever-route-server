import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildDriverProofMediaEvidenceSeed } from '../modules/driver/driver-proof-media-evidence-seed.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function git(args: string[], fallback: string): string {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
  } catch {
    return fallback;
  }
}

console.log(buildDriverProofMediaEvidenceSeed({
  env: process.env,
  sourceCommitSha: git(['rev-parse', 'HEAD'], 'unknown'),
  sourceRef: git(['rev-parse', '--abbrev-ref', 'HEAD'], 'unknown')
}));
