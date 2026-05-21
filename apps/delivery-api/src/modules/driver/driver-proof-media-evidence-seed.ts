export type DriverProofMediaEvidenceSeedInput = {
  env: Record<string, string | undefined>;
  sourceCommitSha: string;
  sourceRef: string;
};

type Status = 'missing' | 'present';

type ConfigRow = {
  name: string;
  status: string;
  note: string;
};

const S3_REQUIRED_KEYS = [
  'DRIVER_PROOF_MEDIA_S3_BUCKET',
  'DRIVER_PROOF_MEDIA_S3_REGION',
  'DRIVER_PROOF_MEDIA_S3_ACCESS_KEY_ID',
  'DRIVER_PROOF_MEDIA_S3_SECRET_ACCESS_KEY'
] as const;

const S3_OPTIONAL_KEYS = [
  'DRIVER_PROOF_MEDIA_S3_ENDPOINT',
  'DRIVER_PROOF_MEDIA_S3_FORCE_PATH_STYLE',
  'DRIVER_PROOF_MEDIA_S3_SESSION_TOKEN'
] as const;

export function buildDriverProofMediaEvidenceSeed(input: DriverProofMediaEvidenceSeedInput): string {
  const storageBackend = normalizeBackend(input.env.DRIVER_PROOF_MEDIA_STORAGE_BACKEND, 'local');
  const scannerBackend = normalizeBackend(input.env.DRIVER_PROOF_MEDIA_SCANNER_BACKEND, 'none');
  const scanMonitorBackend = normalizeBackend(input.env.DRIVER_PROOF_MEDIA_SCAN_MONITOR_BACKEND, 'none');
  const rows: ConfigRow[] = [
    { name: 'Storage backend', status: code(storageBackend), note: storageBackend === 's3' ? 'production object storage selected' : 'local/dev storage; not production proof' },
    ...S3_REQUIRED_KEYS.map((key) => ({ name: code(key), status: presence(input.env[key]), note: 'required for s3 backend; value intentionally omitted' })),
    ...S3_OPTIONAL_KEYS.map((key) => ({ name: code(key), status: presence(input.env[key]), note: 'optional s3-compatible control; value intentionally omitted' })),
    { name: code('DRIVER_PROOF_MEDIA_READ_ACCESS_TTL_SECONDS'), status: statusOrDefault(input.env.DRIVER_PROOF_MEDIA_READ_ACCESS_TTL_SECONDS, '300 default'), note: 'signed/read access lifetime; value may be non-secret but verify privately' },
    { name: code('DRIVER_PROOF_MEDIA_RETENTION_DAYS'), status: statusOrDefault(input.env.DRIVER_PROOF_MEDIA_RETENTION_DAYS, '180 default'), note: 'cleanup retention window; value may be non-secret but verify privately' },
    { name: code('DRIVER_PROOF_MEDIA_SCANNER_BACKEND'), status: code(scannerBackend), note: scannerBackend === 'http' ? 'scanner adapter selected' : 'scanner disabled; production evidence missing' },
    { name: code('DRIVER_PROOF_MEDIA_SCANNER_URL'), status: presence(input.env.DRIVER_PROOF_MEDIA_SCANNER_URL), note: 'scanner endpoint value intentionally omitted' },
    { name: code('DRIVER_PROOF_MEDIA_SCANNER_BEARER_TOKEN'), status: presence(input.env.DRIVER_PROOF_MEDIA_SCANNER_BEARER_TOKEN), note: 'scanner credential value intentionally omitted' },
    { name: code('DRIVER_PROOF_MEDIA_SCAN_MONITOR_BACKEND'), status: code(scanMonitorBackend), note: scanMonitorBackend === 'http' ? 'scan monitor adapter selected' : 'scan monitoring disabled; production alert evidence missing' },
    { name: code('DRIVER_PROOF_MEDIA_SCAN_MONITOR_URL'), status: presence(input.env.DRIVER_PROOF_MEDIA_SCAN_MONITOR_URL), note: 'monitor endpoint value intentionally omitted' },
    { name: code('DRIVER_PROOF_MEDIA_SCAN_MONITOR_BEARER_TOKEN'), status: presence(input.env.DRIVER_PROOF_MEDIA_SCAN_MONITOR_BEARER_TOKEN), note: 'monitor credential value intentionally omitted' },
    { name: code('DRIVER_PROOF_MEDIA_CLEANUP_EVIDENCE_REF'), status: presence(input.env.DRIVER_PROOF_MEDIA_CLEANUP_EVIDENCE_REF), note: 'private evidence reference value intentionally omitted' }
  ];

  return [
    '# Driver proof media production evidence seed',
    '',
    'This seed is not proof that production storage, scanner, monitoring, or cleanup scheduler is deployed. Copy it into the approved private evidence workspace, then fill real bucket/IAM, signed URL, scanner, alerting, and scheduler evidence there.',
    '',
    '## Source revision',
    '',
    '| Field | Value |',
    '| --- | --- |',
    `| Source commit SHA | ${code(input.sourceCommitSha)} |`,
    `| Source ref | ${code(input.sourceRef)} |`,
    '',
    '## Runtime configuration presence audit',
    '',
    '| Item | Status | Note |',
    '| --- | --- | --- |',
    ...rows.map((row) => `| ${row.name} | ${row.status} | ${row.note} |`),
    '',
    '## Private evidence still required',
    '',
    '- Bucket ownership and IAM least-privilege approval',
    '- Credential custody and rotation owner approval',
    '- Signed read URL smoke evidence with synthetic proof media',
    '- Scanner deployment evidence plus clean/rejected scan smoke',
    '- Scanner monitor or alert routing evidence and incident response owner',
    '- Cleanup scheduler deployment evidence and sanitized cleanup run reference',
    '- Private evidence storage location for release sign-off',
    '',
    '## Commands to run from the selected source revision',
    '',
    '- `npm run check:workspace`',
    '- `npm run build`',
    '- `npm audit --audit-level=moderate`',
    '- `npm run driver:proof-media:evidence:seed`',
    '- `npm run driver:proof-media:cleanup` in the selected runtime when scheduler evidence is being captured',
    '',
    '## Tracking issues',
    '',
    '| Gate | Issue | Status to fill privately |',
    '| --- | --- | --- |',
    '| Delivery-server production proof-media evidence | EVNSolution/clever-route-server#71 | pending external evidence |',
    '| Driver-app native build/store/privacy evidence | EVNSolution/clever-driver-app#73 | pending external evidence |',
    '| Driver-app physical iOS/Android smoke evidence | EVNSolution/clever-driver-app#72 | pending external evidence |',
    ''
  ].join('\n');
}

function normalizeBackend(value: string | undefined, fallback: string): string {
  const normalized = value?.trim().toLowerCase();
  return normalized === undefined || normalized === '' ? fallback : normalized;
}

function presence(value: string | undefined): Status {
  return value === undefined || value.trim() === '' ? 'missing' : 'present';
}

function statusOrDefault(value: string | undefined, defaultLabel: string): string {
  return value === undefined || value.trim() === '' ? defaultLabel : 'present';
}

function code(value: string): string {
  return `\`${value}\``;
}
