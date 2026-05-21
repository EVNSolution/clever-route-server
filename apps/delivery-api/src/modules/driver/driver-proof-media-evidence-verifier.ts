export type DriverProofMediaEvidenceVerificationResult = {
  ok: boolean;
  failures: string[];
  warnings: string[];
};

type MarkdownRow = {
  cells: string[];
  source: string;
};

const PENDING_PATTERN = /\bpending\b/i;
const COMPLETED_STATUS_VALUES = new Set(['approved', 'complete', 'pass']);

const SENSITIVE_OR_PRIVATE_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: 'bearer token', pattern: /\bBearer\s+(?!tokens?\b)[-._~+/=A-Za-z0-9]+/i },
  { label: 'AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'S3 secret key assignment', pattern: /\bDRIVER_PROOF_MEDIA_S3_SECRET_ACCESS_KEY\s*=/i },
  { label: 'scanner bearer token assignment', pattern: /\bDRIVER_PROOF_MEDIA_(SCANNER|SCAN_MONITOR)_BEARER_TOKEN\s*=/i },
  { label: 'private bucket value', pattern: /\b[a-z0-9][a-z0-9.-]*(private|prod)[a-z0-9.-]*bucket\b/i },
  { label: 'mobile or proof binary artifact', pattern: /\.(apk|apks|aab|ipa|png|jpe?g|heic|heif|mp4|mov|webm|pdf)(\b|\s|$)/i },
  { label: 'key or certificate artifact', pattern: /\.(keystore|jks|p8|p12|mobileprovision|cer|pem|key|crt)(\b|\s|$)/i }
];

export function verifyDriverProofMediaEvidenceManifest(markdown: string): DriverProofMediaEvidenceVerificationResult {
  const failures: string[] = [];
  const warnings: string[] = [];

  if (markdown.trim() === '') {
    failures.push('driver proof-media evidence manifest is empty.');
    return { ok: false, failures, warnings };
  }

  if (PENDING_PATTERN.test(markdown)) {
    failures.push('pending placeholder remains in manifest.');
  }

  const matchedSensitivePattern = SENSITIVE_OR_PRIVATE_PATTERNS.find(({ pattern }) => pattern.test(markdown));
  if (matchedSensitivePattern !== undefined) {
    failures.push(`sensitive or private artifact pattern found: ${matchedSensitivePattern.label}.`);
  }

  verifyRequiredSourceFields(markdown, failures);
  verifyGateRows(markdown, 'Storage and signed access evidence', 'storage/signed access row', failures);
  verifyGateRows(markdown, 'Scanner and monitoring evidence', 'scanner/monitor row', failures);
  verifyGateRows(markdown, 'Cleanup scheduler evidence', 'cleanup scheduler row', failures);
  verifyGateRows(markdown, 'Private evidence storage and approvals', 'private evidence storage row', failures);
  verifyCompletionDecision(markdown, failures);

  return {
    ok: failures.length === 0,
    failures,
    warnings
  };
}

function verifyRequiredSourceFields(markdown: string, failures: string[]): void {
  const rows = getTableRows(getSection(markdown, 'Source revision'));
  const requiredFields = [
    'Source commit SHA',
    'GitHub PR / merge reference',
    'Runtime environment',
    'Evidence owner',
    'Private evidence storage location',
    'Synthetic proof media only?'
  ];

  if (rows.length === 0) {
    failures.push('source revision table is missing.');
    return;
  }

  for (const field of requiredFields) {
    const row = findFieldRow(rows, field);
    if (row === undefined || isBlankOrPlaceholder(row.cells[1])) {
      failures.push(`source revision field "${field}" must be filled.`);
    }
  }
}

function verifyGateRows(markdown: string, heading: string, failurePrefix: string, failures: string[]): void {
  const rows = getDataRows(getSection(markdown, heading));

  if (rows.length === 0) {
    failures.push(`${failurePrefix} table is missing.`);
    return;
  }

  for (const row of rows) {
    const [gate, status, evidenceReference, owner] = row.cells;
    if (
      isBlankOrPlaceholder(gate) ||
      !COMPLETED_STATUS_VALUES.has(normalized(status)) ||
      isBlankOrPlaceholder(evidenceReference) ||
      isBlankOrPlaceholder(owner)
    ) {
      failures.push(`${failurePrefix} "${gate || row.source}" must be pass, approved, or complete with evidence reference and owner.`);
    }
  }
}

function verifyCompletionDecision(markdown: string, failures: string[]): void {
  const rows = getDataRows(getSection(markdown, 'Completion decision'));

  if (rows.length === 0) {
    failures.push('completion decision table is missing.');
  }

  for (const row of rows) {
    const [gate, status] = row.cells;
    if (isBlankOrPlaceholder(gate) || !COMPLETED_STATUS_VALUES.has(normalized(status))) {
      failures.push(`completion decision gate "${gate || row.source}" must have pass, approved, or complete status.`);
    }
  }

  const decision = getScalarValue(markdown, 'Production proof-media decision');
  if (normalized(decision) !== 'approved') {
    failures.push('production proof-media decision must be approved.');
  }

  for (const label of ['Decision owner', 'Decision timestamp']) {
    const value = getScalarValue(markdown, label);
    if (isBlankOrPlaceholder(value)) {
      failures.push(`${label.toLowerCase()} must be filled.`);
    }
  }
}

function getSection(markdown: string, heading: string): string {
  const headingPattern = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, 'im');
  const match = headingPattern.exec(markdown);
  if (match === null) {
    return '';
  }

  const startIndex = match.index + match[0].length;
  const nextHeading = /^##\s+/im.exec(markdown.slice(startIndex));
  if (nextHeading === null) {
    return markdown.slice(startIndex);
  }

  return markdown.slice(startIndex, startIndex + nextHeading.index);
}

function getTableRows(section: string): MarkdownRow[] {
  return section
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|') && line.endsWith('|'))
    .filter((line) => !/^\|\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(line))
    .map((line) => ({ cells: splitTableRow(line), source: line }))
    .filter((row) => row.cells.length > 0);
}

function getDataRows(section: string): MarkdownRow[] {
  return getTableRows(section).filter((row) => !isHeaderRow(row));
}

function splitTableRow(line: string): string[] {
  return line
    .slice(1, line.endsWith('|') ? -1 : undefined)
    .split(/(?<!\\)\|/)
    .map((cell) => cell.replace(/\\\|/g, '|').replace(/`/g, '').trim());
}

function isHeaderRow(row: MarkdownRow): boolean {
  const firstCell = normalized(row.cells[0]);
  return ['field', 'gate'].includes(firstCell);
}

function findFieldRow(rows: MarkdownRow[], field: string): MarkdownRow | undefined {
  const expected = normalized(field);
  return rows.find((row) => normalized(row.cells[0]) === expected);
}

function getScalarValue(markdown: string, label: string): string | undefined {
  const pattern = new RegExp(`^${escapeRegExp(label)}:\\s*(.*)$`, 'im');
  return pattern.exec(markdown)?.[1]?.replace(/`/g, '').trim();
}

function isBlankOrPlaceholder(value: string | undefined): boolean {
  if (value === undefined) {
    return true;
  }

  const cleanValue = value.replace(/`/g, '').trim();
  return cleanValue === '' || /^pending(\s*\/\s*n\/a)?$/i.test(cleanValue) || /^n\/a\s*\/\s*pending$/i.test(cleanValue);
}

function normalized(value: string | undefined): string {
  return value?.replace(/`/g, '').trim().toLowerCase() ?? '';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
