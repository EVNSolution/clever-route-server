import { readFile } from 'node:fs/promises';

const baseUrl = (process.env.DSV_DEMO_API_URL ?? 'http://127.0.0.1:3001/api/dsv').replace(/\/$/u, '');
const runId = Date.now().toString(36).toUpperCase();
const source = await readFile(new URL('../../docs/examples/dsv-fixed-dispatch-10.csv', import.meta.url), 'utf8');
const [header = [], ...sourceRows] = parseCsv(source);
const index = new Map(header.map((name, column) => [name, column]));
const rows = sourceRows.filter((row) => row.some(Boolean)).map((row, offset) => ({
  address: cell(row, index, '주소'),
  conditionCode: cell(row, index, 'condition'),
  customerCode: cell(row, index, 'customer'),
  destinationName: cell(row, index, '배송처'),
  driverName: cell(row, index, 'driver'),
  latitude: Number(cell(row, index, 'latitude')),
  longitude: Number(cell(row, index, 'longitude')),
  notes: cell(row, index, '특이사항') || null,
  rowNumber: offset + 2,
  sellerOrderKey: `${cell(row, index, 'SellerOrderKey')}-${runId}`,
  shippedBoxes: Number(cell(row, index, 'shippedbox')),
  vehiclePlate: cell(row, index, 'vehicle'),
}));
const payload = { fileName: `dsv-fixed-dispatch-10-${runId}.csv`, planDate: '2026-07-23', rows };

const loginResponse = await fetch(`${baseUrl}/auth/login`, {
  body: JSON.stringify({ id: 'operator', password: 'local-demo-password-2026', shopDomain: 'dsv-demo.local' }),
  headers: { 'content-type': 'application/json' },
  method: 'POST',
});
const login = await responseData<{ csrfToken: string }>(loginResponse);
const cookie = loginResponse.headers.get('set-cookie')?.split(';')[0];
if (cookie === undefined) throw new Error('DSV login did not issue a session cookie');

let preview = await jsonRequest<Preview>(`${baseUrl}/dispatch-imports/preview`, payload, cookie);
for (const candidate of preview.conditionCandidates) {
  const code = conditionCandidateCode(candidate);
  await jsonRequest(`${baseUrl}/conditions`, {
    code,
    description: `${code} 원문 운송조건의 로컬 통합검증 등록값`,
    name: code,
  }, cookie, login.csrfToken);
}
preview = await jsonRequest<Preview>(`${baseUrl}/dispatch-imports/preview`, payload, cookie);
if (!preview.canCommit || preview.summary.totalRows !== 10) throw new Error(`Preview failed: ${JSON.stringify(preview.summary)}`);

const created = await jsonRequest<{ dispatchImport: ImportView }>(`${baseUrl}/dispatch-imports`, payload, cookie, login.csrfToken);
const imported = await getJson<{ dispatchImport: ImportView }>(`${baseUrl}/dispatch-imports/${created.dispatchImport.id}`, cookie);
if (imported.dispatchImport.rowCount !== 10 || imported.dispatchImport.rows.length !== 10) throw new Error('Committed import does not contain ten rows');
assertNoCanonicalLinks('stage', imported.dispatchImport);

const stagedAgain = await jsonRequest<{ dispatchImport: ImportView }>(`${baseUrl}/dispatch-imports`, {
  ...payload,
  fileName: `dsv-fixed-dispatch-10-${runId}-reimport.csv`,
}, cookie, login.csrfToken);
if (stagedAgain.dispatchImport.id === imported.dispatchImport.id) throw new Error('Repeated import collapsed staging history');
if (stagedAgain.dispatchImport.rowCount !== 10 || stagedAgain.dispatchImport.rows.length !== 10) {
  throw new Error('Repeated import did not preserve all staging rows');
}
assertNoCanonicalLinks('repeated stage', stagedAgain.dispatchImport);

const afterStagePreview = await jsonRequest<Preview>(`${baseUrl}/dispatch-imports/preview`, {
  ...payload,
  fileName: `dsv-fixed-dispatch-10-${runId}-after-stage-preview.csv`,
}, cookie);
if ((afterStagePreview.summary.noOpRows ?? 0) !== 0 || afterStagePreview.rows.some((row) => row.diffKind === 'NO_OP')) {
  throw new Error('Stage created canonical rows before explicit apply');
}

const firstApply = await tryApply(imported.dispatchImport, `smoke-${runId}-apply`, cookie, login.csrfToken);
if (firstApply.status === 'missing') {
  process.stdout.write(`${JSON.stringify({
    applyAvailable: false,
    applyBlocker: firstApply.blocker,
    firstImportId: imported.dispatchImport.id,
    repeatedImportId: stagedAgain.dispatchImport.id,
    stageCanonicalLinks: 0,
    stageHistoryPreserved: true,
    status: imported.dispatchImport.status,
  })}\n`);
  process.exit(0);
}

assertApplyLinks(firstApply.result, 10);
if (firstApply.result.summary.newRows !== 10 || firstApply.result.summary.noOpRows !== 0) {
  throw new Error(`Initial apply did not create exactly ten canonical links: ${JSON.stringify(firstApply.result.summary)}`);
}
const replay = await tryApply(imported.dispatchImport, `smoke-${runId}-apply`, cookie, login.csrfToken);
if (replay.status !== 'applied') throw new Error(`Apply replay failed: ${JSON.stringify(replay)}`);
assertSameCanonicalLinks(firstApply.result, replay.result, 'same-command replay');

const afterApplyPreview = await jsonRequest<Preview>(`${baseUrl}/dispatch-imports/preview`, {
  ...payload,
  fileName: `dsv-fixed-dispatch-10-${runId}-after-apply-preview.csv`,
}, cookie);
if ((afterApplyPreview.summary.noOpRows ?? 0) !== 10 || !afterApplyPreview.rows.every((row) => row.diffKind === 'NO_OP')) {
  throw new Error(`Repeated sellerOrderKey did not become NO_OP history after apply: ${JSON.stringify(afterApplyPreview.summary)}`);
}
const noOpStage = await jsonRequest<{ dispatchImport: ImportView }>(`${baseUrl}/dispatch-imports`, {
  ...payload,
  fileName: `dsv-fixed-dispatch-10-${runId}-noop-reimport.csv`,
}, cookie, login.csrfToken);
const noOpApply = await tryApply(noOpStage.dispatchImport, `smoke-${runId}-noop-apply`, cookie, login.csrfToken);
if (noOpApply.status !== 'applied') throw new Error(`NO_OP apply failed: ${JSON.stringify(noOpApply)}`);
if (noOpApply.result.summary.newRows !== 0 || noOpApply.result.summary.noOpRows !== 10) {
  throw new Error(`NO_OP apply created canonical rows: ${JSON.stringify(noOpApply.result.summary)}`);
}
assertSameCanonicalLinks(firstApply.result, noOpApply.result, 'later NO_OP import');

process.stdout.write(`${JSON.stringify({
  applyAvailable: true,
  canonicalLinks: firstApply.result.rows.length,
  importId: imported.dispatchImport.id,
  noOpImportId: noOpStage.dispatchImport.id,
  replayCanonicalLinksStable: true,
  repeatedImportId: stagedAgain.dispatchImport.id,
  rowCount: imported.dispatchImport.rowCount,
  stageCanonicalLinks: 0,
  stageHistoryPreserved: true,
  status: imported.dispatchImport.status,
})}\n`);

type Preview = {
  canCommit: boolean;
  conditionCandidates: Array<string | { comparisonKey: string; rawValue: string; rowNumbers: number[] }>;
  rows: Array<{ diffKind?: string; sellerOrderKey: string }>;
  summary: { errorRows: number; noOpRows?: number; readyRows: number; reviewRows: number; totalRows: number };
};

type ImportView = {
  id: string;
  rowCount: number;
  rows: Array<{
    customerId?: string | null;
    deliveryStopId?: string | null;
    destinationId?: string | null;
    sellerOrderId?: string | null;
    sellerOrderKey: string;
  }>;
  sourceHash?: string;
  status: string;
};

type ApplyResult = {
  commandId: string;
  importId: string;
  rows: Array<{
    customerId: string;
    deliveryStopId: string;
    destinationId: string;
    outcome: 'NEW' | 'NO_OP';
    sellerOrderId: string;
    sellerOrderKey: string;
  }>;
  summary: { appliedRows: number; newRows: number; noOpRows: number };
};

type ApplyAttempt = { result: ApplyResult; status: 'applied' } | { blocker: string; status: 'missing' };

async function getJson<T>(url: string, cookie: string): Promise<T> {
  return responseData<T>(await fetch(url, { headers: { cookie } }));
}

async function jsonRequest<T = unknown>(url: string, body: unknown, cookie: string, csrfToken?: string): Promise<T> {
  return responseData<T>(await fetch(url, requestInit(body, cookie, csrfToken)));
}

async function tryApply(importView: ImportView, commandId: string, cookie: string, csrfToken: string): Promise<ApplyAttempt> {
  if (importView.sourceHash === undefined) throw new Error('Dispatch import response is missing sourceHash required for apply');
  const response = await fetch(`${baseUrl}/dispatch-imports/${importView.id}/apply`, requestInit({
    commandId,
    expectedSourceHash: importView.sourceHash,
  }, cookie, csrfToken, { 'idempotency-key': commandId }));
  const body = await response.json() as { data?: { applyResult?: ApplyResult }; error?: { code?: string; message?: string } };
  if (response.status === 404 || response.status === 405) {
    return { blocker: `apply route unavailable: ${response.status} ${body.error?.code ?? 'NOT_FOUND'}`, status: 'missing' };
  }
  if (!response.ok || body.data?.applyResult === undefined) {
    throw new Error(`${response.status} ${body.error?.code ?? ''} ${body.error?.message ?? ''}`.trim());
  }
  return { result: body.data.applyResult, status: 'applied' };
}

function requestInit(body: unknown, cookie: string, csrfToken?: string, extraHeaders: Record<string, string> = {}): RequestInit {
  return {
    body: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      cookie,
      ...(csrfToken === undefined ? {} : { 'x-csrf-token': csrfToken }),
      ...extraHeaders,
    },
    method: 'POST',
  };
}

async function responseData<T>(response: Response): Promise<T> {
  const body = await response.json() as { data?: T; error?: { code?: string; message?: string } };
  if (!response.ok || body.data === undefined) throw new Error(`${response.status} ${body.error?.code ?? ''} ${body.error?.message ?? ''}`.trim());
  return body.data;
}

function cell(row: string[], index: Map<string, number>, name: string): string {
  const column = index.get(name);
  if (column === undefined) throw new Error(`Missing CSV header: ${name}`);
  return (row[column] ?? '').trim();
}

function assertNoCanonicalLinks(stageName: string, importView: ImportView): void {
  const linkedRows = importView.rows.filter((row) =>
    row.customerId !== null && row.customerId !== undefined
    || row.destinationId !== null && row.destinationId !== undefined
    || row.sellerOrderId !== null && row.sellerOrderId !== undefined
    || row.deliveryStopId !== null && row.deliveryStopId !== undefined);
  if (linkedRows.length > 0) throw new Error(`${stageName} wrote canonical links before explicit apply`);
}

function assertApplyLinks(result: ApplyResult, rowCount: number): void {
  if (result.rows.length !== rowCount || result.summary.appliedRows !== rowCount) {
    throw new Error(`Apply did not link ${rowCount} rows: ${JSON.stringify(result.summary)}`);
  }
  for (const row of result.rows) {
    if (row.customerId === '' || row.destinationId === '' || row.sellerOrderId === '' || row.deliveryStopId === '') {
      throw new Error(`Apply returned an incomplete canonical link for ${row.sellerOrderKey}`);
    }
  }
}

function assertSameCanonicalLinks(expected: ApplyResult, actual: ApplyResult, label: string): void {
  const expectedLinks = new Map(expected.rows.map((row) => [row.sellerOrderKey, row]));
  for (const row of actual.rows) {
    const expectedRow = expectedLinks.get(row.sellerOrderKey);
    if (
      expectedRow === undefined
      || expectedRow.customerId !== row.customerId
      || expectedRow.destinationId !== row.destinationId
      || expectedRow.sellerOrderId !== row.sellerOrderId
      || expectedRow.deliveryStopId !== row.deliveryStopId
    ) {
      throw new Error(`${label} changed canonical links for ${row.sellerOrderKey}`);
    }
  }
}

function conditionCandidateCode(candidate: string | { comparisonKey: string; rawValue: string }): string {
  return typeof candidate === 'string' ? candidate : candidate.rawValue;
}

function parseCsv(source: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cellValue = '';
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        cellValue += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else cellValue += char;
    } else if (char === '"' && cellValue === '') quoted = true;
    else if (char === ',') {
      row.push(cellValue);
      cellValue = '';
    } else if (char === '\n') {
      row.push(cellValue.replace(/\r$/u, ''));
      rows.push(row);
      row = [];
      cellValue = '';
    } else cellValue += char;
  }
  if (quoted) throw new Error('Unclosed CSV quote');
  if (cellValue !== '' || row.length > 0) rows.push([...row, cellValue.replace(/\r$/u, '')]);
  return rows;
}
