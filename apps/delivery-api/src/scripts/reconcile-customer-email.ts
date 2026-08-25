import { readFile } from 'node:fs/promises';

import { PrismaClient } from '@prisma/client';

import {
  CUSTOMER_EMAIL_RECONCILIATION_DISPOSITION,
  CustomerEmailReconciliationRefusalError,
  CustomerEmailReconciliationService,
  parseCustomerEmailReconciliationManifest,
  PrismaCustomerEmailReconciliationStore,
  type CustomerEmailReconciliationSelection
} from '../modules/customer-email/customer-email-reconciliation.js';

const prisma = new PrismaClient();

try {
  const flags = parseFlags(process.argv.slice(2));
  const service = new CustomerEmailReconciliationService(new PrismaCustomerEmailReconciliationStore(prisma));
  if (flags.apply) {
    const manifestDocument = JSON.parse(await readFile(required(flags.manifestPath, 'manifest'), 'utf8')) as unknown;
    const manifest = parseCustomerEmailReconciliationManifest(readManifestPayload(manifestDocument));
    const result = await service.apply({
      operatorEvidence: {
        actor: required(process.env.CUSTOMER_EMAIL_OPERATOR_ACTOR, 'operator execution evidence'),
        approvalRef: required(process.env.CUSTOMER_EMAIL_APPROVAL_REF, 'approval execution evidence'),
        approvalSnapshotSha256: required(process.env.CUSTOMER_EMAIL_APPROVAL_SNAPSHOT_SHA256, 'approval snapshot evidence'),
        releaseImageDigest: required(process.env.CUSTOMER_EMAIL_RELEASE_IMAGE_DIGEST, 'release execution evidence'),
        ssmCommandId: required(process.env.CUSTOMER_EMAIL_SSM_COMMAND_ID, 'SSM execution evidence')
      },
      changeControlRef: required(flags.changeControlRef, 'change-control-ref'),
      disposition: readDisposition(required(flags.disposition, 'disposition')),
      expectedScope: {
        appId: required(flags.appId, 'app-id'),
        shopId: required(flags.shopId, 'shop-id')
      },
      manifest,
      reasonCode: required(flags.reasonCode, 'reason-code'),
      reviewedManifestSha256: required(flags.reviewedManifestSha256, 'reviewed-manifest-sha256')
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    const selections: CustomerEmailReconciliationSelection[] = [
      ...flags.factIds.map((id) => ({ id, kind: 'FACT' as const }))
    ];
    const result = await service.dryRun({
      changeControlRef: required(flags.changeControlRef, 'change-control-ref'),
      disposition: readDisposition(required(flags.disposition, 'disposition')),
      reasonCode: required(flags.reasonCode, 'reason-code'),
      scope: {
        appId: required(flags.appId, 'app-id'),
        shopId: required(flags.shopId, 'shop-id')
      },
      selections
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
} catch (error) {
  const errorCode = error instanceof CustomerEmailReconciliationRefusalError
    ? error.code
    : 'CUSTOMER_EMAIL_RECONCILIATION_FAILED';
  process.stderr.write(`${JSON.stringify({ errorCode })}\n`);
  process.exitCode = 2;
} finally {
  await prisma.$disconnect();
}

type ParsedFlags = {
  appId?: string;
  apply: boolean;
  changeControlRef?: string;
  disposition?: string;
  factIds: string[];
  manifestPath?: string;
  reasonCode?: string;
  reviewedManifestSha256?: string;
  shopId?: string;
};

function parseFlags(args: string[]): ParsedFlags {
  const flags: ParsedFlags = { apply: false, factIds: [] };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--apply') {
      flags.apply = true;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${flag ?? 'flag'}`);
    index += 1;
    switch (flag) {
      case '--app-id': flags.appId = value; break;
      case '--change-control-ref': flags.changeControlRef = value; break;
      case '--disposition': flags.disposition = value; break;
      case '--fact-id': flags.factIds.push(value); break;
      case '--manifest': flags.manifestPath = value; break;
      case '--reason-code': flags.reasonCode = value; break;
      case '--reviewed-manifest-sha256': flags.reviewedManifestSha256 = value; break;
      case '--shop-id': flags.shopId = value; break;
      default: throw new Error(`Unknown flag: ${flag ?? ''}`);
    }
  }
  if (flags.apply && flags.factIds.length > 0) {
    throw new Error('Apply selections must come from the reviewed manifest only.');
  }
  if (!flags.apply && (flags.manifestPath !== undefined || flags.reviewedManifestSha256 !== undefined)) {
    throw new Error('Apply-only flags require --apply.');
  }
  return flags;
}

function readDisposition(value: string): typeof CUSTOMER_EMAIL_RECONCILIATION_DISPOSITION {
  if (value !== 'do-not-send') throw new CustomerEmailReconciliationRefusalError('DISPOSITION_UNSUPPORTED');
  return CUSTOMER_EMAIL_RECONCILIATION_DISPOSITION;
}

function readManifestPayload(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && 'manifest' in value) {
    return value.manifest;
  }
  return value;
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === '') throw new Error(`--${name} is required`);
  return value.trim();
}
