import { open, type FileHandle } from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';
import { seedPrivateDriverDemo } from '../modules/driver/private-driver-demo-seed.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const manifestIndex = args.indexOf('--manifest-file');
const manifestPath = manifestIndex === -1 ? undefined : args[manifestIndex + 1];
const accepted = new Set(['--apply', '--manifest-file', ...(manifestPath === undefined ? [] : [manifestPath])]);
if (args.some(argument => !accepted.has(argument)) || (manifestIndex !== -1 && (!manifestPath || manifestPath.startsWith('--')))) {
  throw new Error('Usage: seed-private-driver-demo [--apply] [--manifest-file PRIVATE_PATH]. Default is read-only dry-run.');
}
const prisma = new PrismaClient();
let manifestFile: FileHandle | undefined;
let created = false;
try {
  // Refuse an existing/unwritable evidence path before making any database changes.
  if (manifestPath !== undefined) manifestFile = await open(manifestPath, 'wx', 0o600);
  const { manifest, ...summary } = await seedPrivateDriverDemo(prisma, { apply });
  created = summary.applied;
  if (manifestFile !== undefined) await manifestFile.writeFile(`${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ...summary, manifestWritten: manifestPath !== undefined })}\n`);
} catch {
  // Prisma error details may contain account IDs, database URLs, or credentials.
  process.stderr.write(created
    ? 'Private demo rows were created, but manifest output failed. Recover the manifest from the private shop settings before continuing.\n'
    : 'Private demo seed refused or failed. No existing records were overwritten. Inspect the bounded preconditions privately.\n');
  process.exitCode = 1;
} finally {
  await manifestFile?.close();
  await prisma.$disconnect();
}
