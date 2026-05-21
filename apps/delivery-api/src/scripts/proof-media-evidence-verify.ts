import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { verifyDriverProofMediaEvidenceManifest } from '../modules/driver/driver-proof-media-evidence-verifier.js';

const manifestPath = process.argv[2];

if (manifestPath === undefined || manifestPath.trim() === '') {
  console.log(JSON.stringify({
    ok: false,
    failures: ['driver proof-media production evidence manifest path argument is required.'],
    warnings: []
  }, null, 2));
  process.exitCode = 1;
} else {
  const manifest = readFileSync(resolve(process.cwd(), manifestPath), 'utf8');
  const result = verifyDriverProofMediaEvidenceManifest(manifest);

  console.log(JSON.stringify(result, null, 2));

  if (!result.ok) {
    process.exitCode = 1;
  }
}
