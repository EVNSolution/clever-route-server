import { open } from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';
import { teardownPrivateDriverDemo } from '../modules/driver/private-driver-demo-routes.js';

// Removes every synthetic route row of the private KFood driver demo shop (routes, orders, stops, groupings, events,
// receipts, leases ...). The demo shop row, the demo driver row, accounts and sessions stay.
//   dry-run  performs the deletes in a transaction and rolls it back, so the result proves the deletion works
//   apply    commits the deletes
// --evidence PATH is required: a private JSON snapshot (counts and small tables) is written before any delete.
const USAGE = 'Usage: teardown-private-driver-demo --mode dry-run|apply --evidence PRIVATE_NEW_FILE_PATH';
const args = process.argv.slice(2);
const read = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const mode = read('--mode');
const evidencePath = read('--evidence');
if ((mode !== 'dry-run' && mode !== 'apply') || evidencePath === undefined || evidencePath.startsWith('--')
  || args.length !== 4) {
  throw new Error(USAGE);
}
const prisma = new PrismaClient();
try {
  const result = await teardownPrivateDriverDemo(prisma, {
    dryRun: mode === 'dry-run',
    // 'wx' refuses an existing file so an earlier snapshot is never overwritten.
    writeEvidence: async (snapshot) => {
      const file = await open(evidencePath, 'wx', 0o600);
      try {
        await file.writeFile(`${JSON.stringify(snapshot)}\n`);
      } finally {
        await file.close();
      }
    }
  });
  process.stdout.write(`${JSON.stringify({ mode, ok: true, ...result })}\n`);
} catch (error) {
  const message = error instanceof Error && error.constructor === Error ? error.message : 'Private demo teardown failed. Inspect the runtime privately.';
  process.stdout.write(`${JSON.stringify({ mode, ok: false, error: message })}\n`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
