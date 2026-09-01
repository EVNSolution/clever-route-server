import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { PrismaClient } from '@prisma/client';

import { PrismaDriverAccountDeletionService } from '../modules/driver/driver-account-deletion.service.js';

type CliAction = 'fulfill' | 'inspect' | 'reject' | 'request';

export type DriverAccountDeletionCliArguments = {
  accountId?: string;
  action: CliAction;
  actor?: string;
  confirmAccountId?: string;
  confirmRequestId?: string;
  execute: boolean;
  reasonCode?: string;
  requestId?: string;
};

export function readDriverAccountDeletionCliArguments(values: string[]): DriverAccountDeletionCliArguments {
  const flags = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (key === undefined || !key.startsWith('--') || value === undefined) {
      throw new Error('Arguments must be provided as --name value pairs');
    }
    const name = key.slice(2);
    if (!ALLOWED_FLAGS.has(name)) throw new Error(`Unsupported argument: --${name}`);
    flags.set(name, value);
  }

  const action = required(flags, 'action');
  if (!ACTIONS.has(action)) throw new Error('action must be request, inspect, fulfill, or reject');
  const execute = readBoolean(flags.get('execute'));
  const parsed: DriverAccountDeletionCliArguments = { action: action as CliAction, execute };

  if (action === 'request') {
    parsed.accountId = requiredUuid(flags, 'account-id');
    parsed.actor = requiredActor(flags);
    if (execute) {
      parsed.confirmAccountId = requiredUuid(flags, 'confirm-account-id');
      if (parsed.confirmAccountId !== parsed.accountId) throw new Error('confirm-account-id must match account-id');
    }
  } else {
    parsed.requestId = requiredUuid(flags, 'request-id');
    if (action !== 'inspect') parsed.actor = requiredActor(flags);
    if (execute && action !== 'inspect') {
      parsed.confirmRequestId = requiredUuid(flags, 'confirm-request-id');
      if (parsed.confirmRequestId !== parsed.requestId) throw new Error('confirm-request-id must match request-id');
    }
    if (action === 'reject') parsed.reasonCode = required(flags, 'reason-code');
  }

  return parsed;
}

export async function runDriverAccountDeletionCli(
  args: DriverAccountDeletionCliArguments,
  service: PrismaDriverAccountDeletionService,
): Promise<Record<string, unknown>> {
  if (args.action === 'request') {
    if (!args.execute) {
      return { action: args.action, dryRun: true, wouldCreateVerifiedAccountRequest: true };
    }
    return service.requestVerifiedExternal({
      accountId: requiredValue(args.accountId, 'accountId'),
      processedBy: requiredValue(args.actor, 'actor'),
      verificationMethod: 'OPERATOR_VERIFIED_CONTACT',
    });
  }

  const requestId = requiredValue(args.requestId, 'requestId');
  if (args.action === 'inspect' || !args.execute) {
    const inspection = await service.inspect(requestId);
    return { ...inspection, action: args.action, dryRun: args.action !== 'inspect' };
  }
  if (args.action === 'fulfill') {
    return service.fulfill({ processedBy: requiredValue(args.actor, 'actor'), requestId });
  }
  return service.reject({
    processedBy: requiredValue(args.actor, 'actor'),
    reasonCode: requiredValue(args.reasonCode, 'reasonCode'),
    requestId,
  });
}

const ALLOWED_FLAGS = new Set([
  'account-id',
  'action',
  'actor',
  'confirm-account-id',
  'confirm-request-id',
  'execute',
  'reason-code',
  'request-id',
]);
const ACTIONS = new Set(['fulfill', 'inspect', 'reject', 'request']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ACTOR_PATTERN = /^[a-z0-9][a-z0-9._-]{2,79}$/u;

function required(flags: Map<string, string>, name: string): string {
  const value = flags.get(name)?.trim();
  if (value === undefined || value === '') throw new Error(`--${name} is required`);
  return value;
}

function requiredUuid(flags: Map<string, string>, name: string): string {
  const value = required(flags, name);
  if (!UUID_PATTERN.test(value)) throw new Error(`--${name} must be a UUID`);
  return value;
}

function requiredActor(flags: Map<string, string>): string {
  const value = required(flags, 'actor');
  if (!ACTOR_PATTERN.test(value)) throw new Error('--actor must be a non-PII operator label');
  return value;
}

function readBoolean(value: string | undefined): boolean {
  if (value === undefined || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error('--execute must be true or false');
}

function requiredValue(value: string | undefined, name: string): string {
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const args = readDriverAccountDeletionCliArguments(process.argv.slice(2));
  const prisma = new PrismaClient();
  try {
    const service = new PrismaDriverAccountDeletionService(prisma);
    const result = await runDriverAccountDeletionCli(args, service);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1]);
if (invokedPath !== null && invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
