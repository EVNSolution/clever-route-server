import { createHash, createHmac } from 'node:crypto';

import type {
  DriverProofMediaStorageBackend,
  DriverProofMediaStorageReadAccessInput,
  DriverProofMediaStorageWriteInput
} from './driver-proof-media.repository.js';

export type S3DriverProofMediaStorageOptions = {
  bucket: string;
  credentials: S3Credentials | S3CredentialsProvider;
  endpoint?: string | undefined;
  fetch?: S3Fetch | undefined;
  forcePathStyle?: boolean | undefined;
  now?: (() => Date) | undefined;
  region: string;
};

export type S3Credentials = {
  accessKeyId: string;
  expiresAt?: Date | undefined;
  secretAccessKey: string;
  sessionToken?: string | undefined;
};

export type S3CredentialsProvider = () => Promise<S3Credentials>;

type S3Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export type Ec2IamRoleCredentialsProviderOptions = {
  fetch?: S3Fetch | undefined;
  now?: (() => Date) | undefined;
  requestTimeoutMs?: number | undefined;
};

type NormalizedS3Options = {
  bucket: string;
  credentials: S3CredentialsProvider;
  endpoint: string;
  fetch: S3Fetch;
  forcePathStyle: boolean;
  now: () => Date;
  region: string;
};

type SigningOptions = NormalizedS3Options & S3Credentials;

const ALGORITHM = 'AWS4-HMAC-SHA256';
const EC2_IMDS_BASE_URL = 'http://169.254.169.254/latest';
const EC2_IMDS_TOKEN_TTL_SECONDS = 6 * 60 * 60;
const EC2_CREDENTIAL_REFRESH_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_EC2_IMDS_REQUEST_TIMEOUT_MS = 2_000;
const MAX_PRESIGNED_URL_EXPIRES_SECONDS = 7 * 24 * 60 * 60;
const SERVICE = 's3';
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

export function createS3DriverProofMediaStorage(options: S3DriverProofMediaStorageOptions): DriverProofMediaStorageBackend {
  const normalized = normalizeOptions(options);

  return {
    createReadAccess: (input) => createReadAccess(normalized, input),
    remove: (storageKey, signal) => removeObject(normalized, storageKey, signal),
    write: (input, signal) => writeObject(normalized, input, signal)
  };
}

export function createEc2IamRoleCredentialsProvider(
  options: Ec2IamRoleCredentialsProviderOptions = {}
): S3CredentialsProvider {
  const fetchImplementation = options.fetch ?? globalThis.fetch?.bind(globalThis);
  if (fetchImplementation === undefined) {
    throw new Error('EC2 IAM role credentials require a fetch implementation');
  }
  const now = options.now ?? (() => new Date());
  const requestTimeoutMs = normalizePositiveInteger(
    options.requestTimeoutMs ?? DEFAULT_EC2_IMDS_REQUEST_TIMEOUT_MS,
    'requestTimeoutMs'
  );
  let cached: S3Credentials | undefined;
  let pending: Promise<S3Credentials> | undefined;

  return async () => {
    const current = now();
    if (
      cached?.expiresAt !== undefined
      && cached.expiresAt.getTime() - current.getTime() > EC2_CREDENTIAL_REFRESH_WINDOW_MS
    ) {
      return cached;
    }
    pending ??= loadEc2IamRoleCredentials({ fetch: fetchImplementation, now, requestTimeoutMs })
      .then((credentials) => {
        cached = credentials;
        return credentials;
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
}

async function loadEc2IamRoleCredentials(input: {
  fetch: S3Fetch;
  now: () => Date;
  requestTimeoutMs: number;
}): Promise<S3Credentials> {
  const token = await fetchImdsText(input, `${EC2_IMDS_BASE_URL}/api/token`, {
    headers: { 'X-aws-ec2-metadata-token-ttl-seconds': String(EC2_IMDS_TOKEN_TTL_SECONDS) },
    method: 'PUT'
  });
  const metadataHeaders = { 'X-aws-ec2-metadata-token': token };
  const roleName = await fetchImdsText(input, `${EC2_IMDS_BASE_URL}/meta-data/iam/security-credentials/`, {
    headers: metadataHeaders,
    method: 'GET'
  });
  if (!/^[A-Za-z0-9+=,.@_-]{1,128}$/u.test(roleName)) {
    throw new Error('EC2 IAM role credentials returned an invalid role name');
  }
  const responseText = await fetchImdsText(
    input,
    `${EC2_IMDS_BASE_URL}/meta-data/iam/security-credentials/${encodeURIComponent(roleName)}`,
    { headers: metadataHeaders, method: 'GET' }
  );
  let value: unknown;
  try {
    value = JSON.parse(responseText);
  } catch {
    throw new Error('EC2 IAM role credentials returned invalid JSON');
  }
  if (!isRecord(value) || value.Code !== 'Success') {
    throw new Error('EC2 IAM role credentials request was not successful');
  }
  const expiresAt = typeof value.Expiration === 'string' ? new Date(value.Expiration) : new Date(Number.NaN);
  const credentials = normalizeCredentials({
    accessKeyId: typeof value.AccessKeyId === 'string' ? value.AccessKeyId : '',
    expiresAt,
    secretAccessKey: typeof value.SecretAccessKey === 'string' ? value.SecretAccessKey : '',
    sessionToken: typeof value.Token === 'string' ? value.Token : ''
  });
  if (credentials.sessionToken === undefined || expiresAt.getTime() <= input.now().getTime()) {
    throw new Error('EC2 IAM role credentials are missing a valid temporary session');
  }
  return credentials;
}

async function fetchImdsText(
  input: { fetch: S3Fetch; requestTimeoutMs: number },
  url: string,
  init: RequestInit
): Promise<string> {
  const response = await input.fetch(url, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.timeout(input.requestTimeoutMs)
  });
  if (!response.ok) {
    throw new Error(`EC2 IAM role credentials request failed with HTTP ${response.status}`);
  }
  const text = (await response.text()).trim();
  if (text === '') throw new Error('EC2 IAM role credentials returned an empty response');
  return text;
}

async function writeObject(
  options: NormalizedS3Options,
  input: DriverProofMediaStorageWriteInput,
  signal: AbortSignal
): Promise<void> {
  const signingOptions = await signingOptionsFor(options);
  const url = buildObjectUrl(options, input.storageKey);
  const payloadHash = sha256Hex(input.fileBytes);
  const signed = signHeaderRequest({
    method: 'PUT',
    options: signingOptions,
    payloadHash,
    url
  });

  const response = await options.fetch(url.href, {
    body: input.fileBytes,
    headers: signed.headers,
    method: 'PUT',
    signal
  });
  if (!response.ok) {
    throw new Error(`S3 proof media write failed with HTTP ${response.status}`);
  }
}

async function removeObject(
  options: NormalizedS3Options,
  storageKey: string,
  signal: AbortSignal
): Promise<'missing' | 'removed'> {
  const signingOptions = await signingOptionsFor(options);
  const url = buildObjectUrl(options, storageKey);
  const signed = signHeaderRequest({
    method: 'DELETE',
    options: signingOptions,
    payloadHash: sha256Hex(Buffer.alloc(0)),
    url
  });

  const response = await options.fetch(url.href, {
    headers: signed.headers,
    method: 'DELETE',
    signal
  });
  if (response.status === 404) {
    return 'missing';
  }
  if (!response.ok) {
    throw new Error(`S3 proof media delete failed with HTTP ${response.status}`);
  }

  return 'removed';
}

async function createReadAccess(
  options: NormalizedS3Options,
  input: DriverProofMediaStorageReadAccessInput
): Promise<{ url: string }> {
  const signingOptions = await signingOptionsFor(options);
  const url = buildObjectUrl(options, input.storageKey);
  const now = options.now();
  const expiresSeconds = Math.floor((input.expiresAt.getTime() - now.getTime()) / 1000);
  if (expiresSeconds < 1 || expiresSeconds > MAX_PRESIGNED_URL_EXPIRES_SECONDS) {
    throw new Error('S3 proof media read access expiry must be between 1 and 604800 seconds');
  }

  const { amzDate, dateStamp } = formatAmzTimestamp(now);
  const credentialScope = buildCredentialScope({ dateStamp, region: options.region });
  const credential = `${signingOptions.accessKeyId}/${credentialScope}`;
  const queryParameters: [string, string][] = [
    ['X-Amz-Algorithm', ALGORITHM],
    ['X-Amz-Credential', credential],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(expiresSeconds)],
    ['X-Amz-SignedHeaders', 'host']
  ];
  if (signingOptions.sessionToken !== undefined) {
    queryParameters.push(['X-Amz-Security-Token', signingOptions.sessionToken]);
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
    options: signingOptions,
    region: options.region,
    timestamp: amzDate
  });

  return {
    url: `${url.origin}${url.pathname}?${canonicalQuery}&X-Amz-Signature=${signature}`
  };
}

function signHeaderRequest(input: {
  method: 'DELETE' | 'PUT';
  options: SigningOptions;
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
  options: SigningOptions;
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
  const credentials = options.credentials;
  return {
    bucket: readRequired(options.bucket, 'bucket'),
    credentials: typeof credentials === 'function'
      ? credentials
      : () => Promise.resolve(normalizeCredentials(credentials)),
    endpoint,
    fetch: fetchImplementation,
    forcePathStyle: options.forcePathStyle ?? false,
    now: options.now ?? (() => new Date()),
    region: readRequired(options.region, 'region')
  };
}

async function signingOptionsFor(options: NormalizedS3Options): Promise<SigningOptions> {
  return { ...options, ...normalizeCredentials(await options.credentials()) };
}

function normalizeCredentials(credentials: S3Credentials): S3Credentials {
  const expiresAt = credentials.expiresAt;
  if (expiresAt !== undefined && Number.isNaN(expiresAt.getTime())) {
    throw new Error('S3 proof media storage requires a valid credential expiry');
  }
  return {
    accessKeyId: readRequired(credentials.accessKeyId, 'accessKeyId'),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    secretAccessKey: readRequired(credentials.secretAccessKey, 'secretAccessKey'),
    ...(readOptional(credentials.sessionToken) === undefined
      ? {}
      : { sessionToken: readOptional(credentials.sessionToken) })
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

function normalizePositiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`EC2 IAM role credentials require a positive ${name}`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
