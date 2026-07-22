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
for (const code of preview.conditionCandidates) {
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

const duplicate = await fetch(`${baseUrl}/dispatch-imports`, requestInit(payload, cookie, login.csrfToken));
if (duplicate.status !== 422) throw new Error(`Duplicate SellerOrderKey protection returned ${duplicate.status}`);
const duplicateBody = await duplicate.json() as { error?: { code?: string } };
if (duplicateBody.error?.code !== 'DISPATCH_IMPORT_INVALID') throw new Error('Duplicate SellerOrderKey protection returned an unexpected error');

process.stdout.write(`${JSON.stringify({
  duplicateProtected: true,
  importId: imported.dispatchImport.id,
  rowCount: imported.dispatchImport.rowCount,
  status: imported.dispatchImport.status,
})}\n`);

type Preview = {
  canCommit: boolean;
  conditionCandidates: string[];
  summary: { errorRows: number; readyRows: number; reviewRows: number; totalRows: number };
};

type ImportView = {
  id: string;
  rowCount: number;
  rows: unknown[];
  status: string;
};

async function getJson<T>(url: string, cookie: string): Promise<T> {
  return responseData<T>(await fetch(url, { headers: { cookie } }));
}

async function jsonRequest<T = unknown>(url: string, body: unknown, cookie: string, csrfToken?: string): Promise<T> {
  return responseData<T>(await fetch(url, requestInit(body, cookie, csrfToken)));
}

function requestInit(body: unknown, cookie: string, csrfToken?: string): RequestInit {
  return {
    body: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      cookie,
      ...(csrfToken === undefined ? {} : { 'x-csrf-token': csrfToken }),
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
