import { lstat, readFile } from 'node:fs/promises';

import { PrismaClient } from '@prisma/client';

import {
  CUSTOMER_EMAIL_RECONCILIATION_DISPOSITION,
  CustomerEmailReconciliationRefusalError,
  CustomerEmailReconciliationService,
  parseCustomerEmailReconciliationManifest,
  PrismaCustomerEmailReconciliationStore,
  type CustomerEmailOperatorEvidence,
  type CustomerEmailReconciliationSelection
} from '../modules/customer-email/customer-email-reconciliation.js';

const prisma = new PrismaClient();
const OPERATOR_EVIDENCE_PATH = '/run/reconciliation/operator-evidence.json';
const OPERATOR_MANIFEST_PATH = '/run/reconciliation/manifest.json';

try {
  const flags = parseFlags(process.argv.slice(2));
  const service = new CustomerEmailReconciliationService(new PrismaCustomerEmailReconciliationStore(prisma));
  if (flags.apply) {
    const manifestDocument = JSON.parse(await readFile(required(flags.manifestPath, 'manifest'), 'utf8')) as unknown;
    const manifest = parseCustomerEmailReconciliationManifest(readManifestPayload(manifestDocument));
    if (manifest.items.length !== Number(flags.expectedItemCount)) throw new Error('Reviewed manifest item count mismatch.');
    const operatorEvidence = await readOperatorEvidence(flags);
    const result = await service.apply({
      operatorEvidence,
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
  expectedItemCount?: string;
  factIds: string[];
  manifestPath?: string;
  reasonCode?: string;
  reviewedManifestSha256?: string;
  shopId?: string;
};

function parseFlags(args: string[]): ParsedFlags {
  const flags: ParsedFlags = { apply: false, factIds: [] };
  const singletonFlags = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--apply') {
      if (flags.apply) throw new Error('Duplicate --apply flag.');
      flags.apply = true;
      continue;
    }
    if (flag !== '--fact-id') {
      if (singletonFlags.has(flag ?? '')) throw new Error(`Duplicate singleton flag: ${flag ?? ''}`);
      singletonFlags.add(flag ?? '');
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${flag ?? 'flag'}`);
    index += 1;
    switch (flag) {
      case '--app-id': flags.appId = value; break;
      case '--change-control-ref': flags.changeControlRef = value; break;
      case '--disposition': flags.disposition = value; break;
      case '--expected-item-count': flags.expectedItemCount = value; break;
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
  if (flags.apply && flags.manifestPath !== OPERATOR_MANIFEST_PATH) {
    throw new Error(`Apply manifest must be ${OPERATOR_MANIFEST_PATH}.`);
  }
  if (flags.apply && !/^(?:[1-9]|[1-9][0-9]|100)$/u.test(flags.expectedItemCount ?? '')) {
    throw new Error('Apply expected-item-count must be between 1 and 100.');
  }
  if (!flags.apply && (flags.manifestPath !== undefined || flags.reviewedManifestSha256 !== undefined)) {
    throw new Error('Apply-only flags require --apply.');
  }
  if (!flags.apply && flags.expectedItemCount !== undefined) throw new Error('Apply-only flags require --apply.');
  return flags;
}

type OperatorEvidenceEnvelope = CustomerEmailOperatorEvidence & {
  changeControlRef: string;
  disposition: 'DO_NOT_SEND';
  manifestSha256: string;
  scope: { appId: string; shopId: string };
};

async function readOperatorEvidence(flags: ParsedFlags): Promise<CustomerEmailOperatorEvidence> {
  const evidenceStat = await lstat(OPERATOR_EVIDENCE_PATH);
  if (!evidenceStat.isFile() || evidenceStat.uid !== 0 || (evidenceStat.mode & 0o777) !== 0o444) {
    throw new Error('Operator evidence envelope is not a root-owned read-only file.');
  }
  const value = JSON.parse(await readFile(OPERATOR_EVIDENCE_PATH, 'utf8')) as unknown;
  if (!isRecord(value) || !isRecord(value.scope)) throw new Error('Operator evidence envelope is invalid.');
  const envelope = value as OperatorEvidenceEnvelope;
  if (envelope.changeControlRef !== flags.changeControlRef
    || envelope.disposition !== 'DO_NOT_SEND'
    || envelope.manifestSha256 !== flags.reviewedManifestSha256
    || envelope.scope.appId !== flags.appId
    || envelope.scope.shopId !== flags.shopId) {
    throw new Error('Operator evidence envelope binding mismatch.');
  }
  return {
    actor: required(envelope.actor, 'operator execution evidence'),
    approvalRef: required(envelope.approvalRef, 'approval execution evidence'),
    approvalSnapshotSha256: required(envelope.approvalSnapshotSha256, 'approval snapshot evidence'),
    releaseImageDigest: required(envelope.releaseImageDigest, 'release execution evidence'),
    ssmCommandId: required(envelope.ssmCommandId, 'SSM execution evidence')
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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
