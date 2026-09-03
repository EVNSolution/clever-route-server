import { Prisma, PrismaClient } from '@prisma/client';

import {
  ROLLING_ETA_BACKFILL_CHANGE_CONTROL_REF,
  ROLLING_ETA_BACKFILL_APP_ID,
  RollingEtaBackfillRefusalError,
  RollingEtaBackfillService
} from '../modules/driver/rolling-eta-backfill.js';

type Flags = {
  appId?: string;
  apply: boolean;
  changeControlRef?: string;
  expectedChangeCount?: number;
  reviewedPlanSha256?: string;
  shopId?: string;
};

const prisma = new PrismaClient();

try {
  const flags = parseFlags(process.argv.slice(2));
  const service = new RollingEtaBackfillService(prisma);
  const scope = {
    appId: required(flags.appId, 'app-id') as typeof ROLLING_ETA_BACKFILL_APP_ID,
    shopId: required(flags.shopId, 'shop-id')
  };
  if (flags.apply) {
    const result = await service.apply({
      changeControlRef: required(flags.changeControlRef, 'change-control-ref'),
      expectedChangeCount: requiredNumber(flags.expectedChangeCount, 'expected-change-count'),
      reviewedPlanSha256: required(flags.reviewedPlanSha256, 'reviewed-plan-sha256'),
      scope
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    const inspection = await service.inspect(scope);
    process.stdout.write(`${JSON.stringify({
      ...inspection,
      mode: 'dry-run',
      mutationCount: 0
    }, null, 2)}\n`);
  }
} catch (error) {
  const errorCode = error instanceof RollingEtaBackfillRefusalError
    ? error.code
    : 'ROLLING_ETA_BACKFILL_FAILED';
  process.stderr.write(`${JSON.stringify({
    errorCode,
    errorName: error instanceof Error ? error.name : 'UnknownError',
    ...(error instanceof Prisma.PrismaClientKnownRequestError ? { prismaCode: error.code } : {})
  })}\n`);
  process.exitCode = 2;
} finally {
  await prisma.$disconnect();
}

export function parseFlags(args: string[]): Flags {
  const flags: Flags = { apply: false };
  const singletonFlags = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--apply') {
      if (flags.apply) throw new Error('Duplicate --apply flag.');
      flags.apply = true;
      continue;
    }
    if (singletonFlags.has(flag ?? '')) throw new Error(`Duplicate singleton flag: ${flag ?? ''}`);
    singletonFlags.add(flag ?? '');
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${flag ?? 'flag'}`);
    index += 1;
    switch (flag) {
      case '--app-id': flags.appId = value; break;
      case '--change-control-ref': flags.changeControlRef = value; break;
      case '--expected-change-count': flags.expectedChangeCount = readPositiveInteger(value); break;
      case '--reviewed-plan-sha256': flags.reviewedPlanSha256 = value; break;
      case '--shop-id': flags.shopId = value; break;
      default: throw new Error(`Unknown flag: ${flag ?? ''}`);
    }
  }
  if (flags.appId !== ROLLING_ETA_BACKFILL_APP_ID) {
    throw new Error(`--app-id must be ${ROLLING_ETA_BACKFILL_APP_ID}.`);
  }
  required(flags.shopId, 'shop-id');
  if (flags.apply) {
    if (flags.changeControlRef !== ROLLING_ETA_BACKFILL_CHANGE_CONTROL_REF) {
      throw new Error(`--change-control-ref must be ${ROLLING_ETA_BACKFILL_CHANGE_CONTROL_REF}.`);
    }
    requiredNumber(flags.expectedChangeCount, 'expected-change-count');
    required(flags.reviewedPlanSha256, 'reviewed-plan-sha256');
  } else if (flags.changeControlRef !== undefined
    || flags.expectedChangeCount !== undefined
    || flags.reviewedPlanSha256 !== undefined) {
    throw new Error('Apply-only flags require --apply.');
  }
  return flags;
}

function readPositiveInteger(value: string): number {
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error('Expected a positive integer.');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error('Expected a safe positive integer.');
  return parsed;
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === '') throw new Error(`--${name} is required`);
  return value.trim();
}

function requiredNumber(value: number | undefined, name: string): number {
  if (value === undefined) throw new Error(`--${name} is required`);
  return value;
}
