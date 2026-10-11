import { PrismaClient } from '@prisma/client';
import {
  createPrivateDriverDemoRoute,
  dispatchPrivateDriverDemoRoute,
  readPrivateDriverDemoRouteState
} from '../modules/driver/private-driver-demo-routes.js';
import { isPrivateDriverDemoTemplateName } from '../modules/driver/private-driver-demo-templates.js';
import { loadDriverPushProvider } from '../modules/route-grouping/driver-push.provider.js';

// Adds one extra synthetic route to the private KFood driver demo shop and Dispatches it with the route push.
//   check    read-only: does the route exist, is it published, which push provider is configured
//   create   writes the route unpublished (assigned, invisible to the driver app)
//   dispatch publishes it through the admin Dispatch services, sends the push and reads the route back like the app
const USAGE = 'Usage: private-driver-demo-route --mode check|create|dispatch --key KEY --name NAME [--template simple|cash|proof] [--plan-date YYYY-MM-DD] [--allow-disabled-push-provider]';
const args = process.argv.slice(2);
const read = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const mode = read('--mode');
const key = read('--key');
const name = read('--name');
const templateName = read('--template') ?? 'simple';
const planDate = read('--plan-date');
const allowDisabledProvider = args.includes('--allow-disabled-push-provider');
const known = new Set(['--mode', '--key', '--name', '--template', '--plan-date', '--allow-disabled-push-provider', mode, key, name, templateName, planDate]);
if ((mode !== 'check' && mode !== 'create' && mode !== 'dispatch') || key === undefined || name === undefined
  || !isPrivateDriverDemoTemplateName(templateName) || args.some((argument) => !known.has(argument))) {
  throw new Error(USAGE);
}
const input = { key, name, planDate, template: templateName };
const prisma = new PrismaClient();
try {
  if (mode === 'check') {
    const state = await readPrivateDriverDemoRouteState(prisma, input);
    const pushProvider = loadDriverPushProvider(process.env);
    process.stdout.write(`${JSON.stringify({ mode, ok: true, route: state, pushProvider: pushProvider.providerName })}\n`);
  } else if (mode === 'create') {
    const result = await createPrivateDriverDemoRoute(prisma, input);
    process.stdout.write(`${JSON.stringify({ mode, ok: true, ...result })}\n`);
  } else {
    const result = await dispatchPrivateDriverDemoRoute(prisma, loadDriverPushProvider(process.env), input, { allowDisabledProvider });
    process.stdout.write(`${JSON.stringify({ mode, ok: true, ...result })}\n`);
  }
} catch (error) {
  // Prisma error details can contain private rows and identifiers: print only our own messages.
  const message = error instanceof Error && error.constructor === Error ? error.message : 'Private demo route command failed. Inspect the runtime privately.';
  process.stdout.write(`${JSON.stringify({ mode, ok: false, error: message })}\n`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
