import { createHash, createHmac } from 'node:crypto';

import type {
  DriverProofMediaStorageBackend,
  DriverProofMediaStorageReadAccessInput,
  DriverProofMediaStorageWriteInput
} from './driver-proof-media.repository.js';

export type S3DriverProofMediaStorageOptions = {
  accessKeyId: string;
  bucket: string;
  endpoint?: string | undefined;
  fetch?: S3Fetch | undefined;
  forcePathStyle?: boolean | undefined;
  now?: (() => Date) | undefined;
  region: string;
  secretAccessKey: string;
  sessionToken?: string | undefined;
};

type S3Fetch = (url: string, init?: RequestInit) => Promise<Response>;

type NormalizedS3Options = {
  accessKeyId: string;
  bucket: string;
  endpoint: string;
  fetch: S3Fetch;
  forcePathStyle: boolean;
  now: () => Date;
  region: string;
  secretAccessKey: string;
  sessionToken: string | undefined;
};

const ALGORITHM = 'AWS4-HMAC-SHA256';
const MAX_PRESIGNED_URL_EXPIRES_SECONDS = 7 * 24 * 60 * 60;
const SERVICE = 's3';
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

export function createS3DriverProofMediaStorage(options: S3DriverProofMediaStorageOptions): DriverProofMediaStorageBackend {
  const normalized = normalizeOptions(options);

  return {
    createReadAccess: (input) => createReadAccess(normalized, input),
    remove: (storageKey) => removeObject(normalized, storageKey),
    write: (input) => writeObject(normalized, input)
  };
}

async function writeObject(options: NormalizedS3Options, input: DriverProofMediaStorageWriteInput): Promise<void> {
  const url = buildObjectUrl(options, input.storageKey);
  const payloadHash = sha256Hex(input.fileBytes);
  const signed = signHeaderRequest({
    method: 'PUT',
    options,
    payloadHash,
    url
  });

  const response = await options.fetch(url.href, {
    body: input.fileBytes,
    headers: signed.headers,
    method: 'PUT'
  });
  if (!response.ok) {
    throw new Error(`S3 proof media write failed with HTTP ${response.status}`);
  }
}

async function removeObject(options: NormalizedS3Options, storageKey: string): Promise<'missing' | 'removed'> {
  const url = buildObjectUrl(options, storageKey);
  const signed = signHeaderRequest({
    method: 'DELETE',
    options,
    payloadHash: sha256Hex(Buffer.alloc(0)),
    url
  });

  const response = await options.fetch(url.href, {
    headers: signed.headers,
    method: 'DELETE'
  });
  if (response.status === 404) {
    return 'missing';
  }
  if (!response.ok) {
    throw new Error(`S3 proof media delete failed with HTTP ${response.status}`);
  }

  return 'removed';
}

function createReadAccess(
  options: NormalizedS3Options,
  input: DriverProofMediaStorageReadAccessInput
): Promise<{ url: string }> {
  const url = buildObjectUrl(options, input.storageKey);
  const now = options.now();
  const expiresSeconds = Math.floor((input.expiresAt.getTime() - now.getTime()) / 1000);
  if (expiresSeconds < 1 || expiresSeconds > MAX_PRESIGNED_URL_EXPIRES_SECONDS) {
    throw new Error('S3 proof media read access expiry must be between 1 and 604800 seconds');
  }

  const { amzDate, dateStamp } = formatAmzTimestamp(now);
  const credentialScope = buildCredentialScope({ dateStamp, region: options.region });
  const credential = `${options.accessKeyId}/${credentialScope}`;
  const queryParameters: [string, string][] = [
    ['X-Amz-Algorithm', ALGORITHM],
    ['X-Amz-Credential', credential],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(expiresSeconds)],
    ['X-Amz-SignedHeaders', 'host']
  ];
  if (options.sessionToken !== undefined) {
    queryParameters.push(['X-Amz-Security-Token', options.sessionToken]);
  }

  const canonicalQuery = canonicalQueryString(queryParameters);
  const canonicalRequest = [
    'GET',
    url.pathname,
    canonicalQuery,
    `host:${url.host}\n`,
    'host',
    UNSIGNED_PAYLOAD
  ].join('\n');
  const signature = signString({
    canonicalRequest,
    dateStamp,
    options,
    region: options.region,
    timestamp: amzDate
  });

  return Promise.resolve({
    url: `${url.origin}${url.pathname}?${canonicalQuery}&X-Amz-Signature=${signature}`
  });
}

function signHeaderRequest(input: {
  method: 'DELETE' | 'PUT';
  options: NormalizedS3Options;
  payloadHash: string;
  url: URL;
}): { headers: Record<string, string> } {
  const { amzDate, dateStamp } = formatAmzTimestamp(input.options.now());
  const signingHeaders: Record<string, string> = {
    host: input.url.host,
    'x-amz-content-sha256': input.payloadHash,
    'x-amz-date': amzDate
  };
  if (input.options.sessionToken !== undefined) {
    signingHeaders['x-amz-security-token'] = input.options.sessionToken;
  }

  const canonicalHeaders = canonicalHeaderString(signingHeaders);
  const signedHeaders = signedHeaderNames(signingHeaders);
  const canonicalRequest = [
    input.method,
    input.url.pathname,
    '',
    canonicalHeaders,
    signedHeaders,
    input.payloadHash
  ].join('\n');
  const signature = signString({
    canonicalRequest,
    dateStamp,
    options: input.options,
    region: input.options.region,
    timestamp: amzDate
  });
  const credentialScope = buildCredentialScope({ dateStamp, region: input.options.region });
  const headers: Record<string, string> = {
    authorization: `${ALGORITHM} Credential=${input.options.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'x-amz-content-sha256': input.payloadHash,
    'x-amz-date': amzDate
  };
  if (input.options.sessionToken !== undefined) {
    headers['x-amz-security-token'] = input.options.sessionToken;
  }

  return { headers };
}

function signString(input: {
  canonicalRequest: string;
  dateStamp: string;
  options: NormalizedS3Options;
  region: string;
  timestamp: string;
}): string {
  const credentialScope = buildCredentialScope({ dateStamp: input.dateStamp, region: input.region });
  const stringToSign = [
    ALGORITHM,
    input.timestamp,
    credentialScope,
    sha256Hex(input.canonicalRequest)
  ].join('\n');
  return hmacSha256(signingKey(input.options.secretAccessKey, input.dateStamp, input.region), stringToSign).toString('hex');
}

function signingKey(secretAccessKey: string, dateStamp: string, region: string): Buffer {
  const dateKey = hmacSha256(`AWS4${secretAccessKey}`, dateStamp);
  const dateRegionKey = hmacSha256(dateKey, region);
  const dateRegionServiceKey = hmacSha256(dateRegionKey, SERVICE);
  return hmacSha256(dateRegionServiceKey, 'aws4_request');
}

function buildObjectUrl(options: NormalizedS3Options, storageKey: string): URL {
  const endpoint = new URL(options.endpoint);
  const encodedKey = uriEncode(storageKey, { encodeSlash: false });
  if (options.forcePathStyle) {
    endpoint.pathname = joinUrlPath(endpoint.pathname, uriEncode(options.bucket, { encodeSlash: true }), encodedKey);
    return endpoint;
  }

  endpoint.hostname = `${options.bucket}.${endpoint.hostname}`;
  endpoint.pathname = joinUrlPath(endpoint.pathname, encodedKey);
  return endpoint;
}

function canonicalHeaderString(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), normalizeHeaderValue(value)] as const)
    .sort(([leftName], [rightName]) => leftName.localeCompare(rightName))
    .map(([name, value]) => `${name}:${value}\n`)
    .join('');
}

function signedHeaderNames(headers: Record<string, string>): string {
  return Object.keys(headers)
    .map((name) => name.toLowerCase())
    .sort((left, right) => left.localeCompare(right))
    .join(';');
}

function canonicalQueryString(parameters: [string, string][]): string {
  return parameters
    .map(([name, value]) => [uriEncode(name, { encodeSlash: true }), uriEncode(value, { encodeSlash: true })] as const)
    .sort(([leftName, leftValue], [rightName, rightValue]) => {
      const nameCompare = leftName.localeCompare(rightName);
      return nameCompare === 0 ? leftValue.localeCompare(rightValue) : nameCompare;
    })
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
}

function buildCredentialScope(input: { dateStamp: string; region: string }): string {
  return `${input.dateStamp}/${input.region}/${SERVICE}/aws4_request`;
}

function formatAmzTimestamp(date: Date): { amzDate: string; dateStamp: string } {
  const iso = date.toISOString();
  const dateStamp = iso.slice(0, 10).replaceAll('-', '');
  const timeStamp = iso.slice(11, 19).replaceAll(':', '');
  return { amzDate: `${dateStamp}T${timeStamp}Z`, dateStamp };
}

function hmacSha256(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function normalizeHeaderValue(value: string): string {
  return value.trim().replace(/\s+/gu, ' ');
}

function joinUrlPath(basePath: string, ...parts: string[]): string {
  const prefix = basePath === '/' ? '' : basePath.replace(/\/+$/u, '');
  return `/${[prefix.replace(/^\/+|\/+$/gu, ''), ...parts]
    .filter((part) => part !== '')
    .join('/')}`;
}

function uriEncode(value: string, input: { encodeSlash: boolean }): string {
  let encoded = '';
  for (const byte of Buffer.from(value, 'utf8')) {
    if (isUnreserved(byte)) {
      encoded += String.fromCharCode(byte);
    } else if (byte === 0x2f && !input.encodeSlash) {
      encoded += '/';
    } else {
      encoded += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }

  return encoded;
}

function isUnreserved(byte: number): boolean {
  return (
    (byte >= 0x41 && byte <= 0x5a) ||
    (byte >= 0x61 && byte <= 0x7a) ||
    (byte >= 0x30 && byte <= 0x39) ||
    byte === 0x2d ||
    byte === 0x2e ||
    byte === 0x5f ||
    byte === 0x7e
  );
}

function normalizeOptions(options: S3DriverProofMediaStorageOptions): NormalizedS3Options {
  const fetchImplementation = options.fetch ?? globalThis.fetch?.bind(globalThis);
  if (fetchImplementation === undefined) {
    throw new Error('S3 proof media storage requires a fetch implementation');
  }

  const endpoint = readRequired(options.endpoint ?? `https://s3.${readRequired(options.region, 'region')}.amazonaws.com`, 'endpoint');
  return {
    accessKeyId: readRequired(options.accessKeyId, 'accessKeyId'),
    bucket: readRequired(options.bucket, 'bucket'),
    endpoint,
    fetch: fetchImplementation,
    forcePathStyle: options.forcePathStyle ?? false,
    now: options.now ?? (() => new Date()),
    region: readRequired(options.region, 'region'),
    secretAccessKey: readRequired(options.secretAccessKey, 'secretAccessKey'),
    sessionToken: readOptional(options.sessionToken)
  };
}

function readRequired(value: string, name: string): string {
  const normalized = readOptional(value);
  if (normalized === undefined) {
    throw new Error(`S3 proof media storage requires ${name}`);
  }

  return normalized;
}

function readOptional(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }

  return value.trim();
}
