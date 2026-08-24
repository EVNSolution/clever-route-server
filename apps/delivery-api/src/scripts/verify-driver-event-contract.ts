import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

type ContractManifest = {
  files: Array<{ path: string; sha256: string }>;
  schemaVersion: 'clever.route-operations.v1';
};

const packageRoot = process.cwd();
const contractRoot = resolve(packageRoot, process.argv[2] ?? 'tests/contract-fixtures/route-operations/v1');
const manifestPath = resolve(contractRoot, 'sha256-manifest.json');
const manifest = parseManifest(JSON.parse(await readFile(manifestPath, 'utf8')) as unknown);

for (const entry of manifest.files) {
  const path = resolve(contractRoot, entry.path);
  if (!path.startsWith(`${contractRoot}/`)) throw new Error(`Unsafe manifest path: ${entry.path}`);
  const bytes = await readFile(path);
  JSON.parse(bytes.toString('utf8')) as unknown;
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== entry.sha256) throw new Error(`SHA-256 mismatch: ${entry.path}`);
}
process.stdout.write(`verified ${manifest.files.length} canonical driver-event fixtures\n`);

function parseManifest(value: unknown): ContractManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid driver event contract manifest');
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 'clever.route-operations.v1' || !Array.isArray(record.files)) {
    throw new Error('Invalid driver event contract manifest');
  }
  const files = record.files.map((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error('Invalid manifest file entry');
    const file = entry as Record<string, unknown>;
    if (typeof file.path !== 'string' || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(file.sha256)) {
      throw new Error('Invalid manifest file entry');
    }
    return { path: file.path, sha256: file.sha256 };
  });
  return { files, schemaVersion: 'clever.route-operations.v1' };
}
