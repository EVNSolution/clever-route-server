import type {
  DriverProofMediaScanInput,
  DriverProofMediaScanMonitor,
  DriverProofMediaScanMonitorInput,
  DriverProofMediaScanResult,
  DriverProofMediaScanner
} from './driver-proof-media.types.js';

export type HttpDriverProofMediaScannerOptions = {
  bearerToken?: string | undefined;
  fetch?: HttpFetch | undefined;
  url: string;
};

type HttpFetch = (url: string, init?: RequestInit) => Promise<Response>;

type NormalizedHttpOptions = {
  bearerToken: string | undefined;
  fetch: HttpFetch;
  url: string;
};

export function createHttpDriverProofMediaScanner(options: HttpDriverProofMediaScannerOptions): DriverProofMediaScanner {
  const normalized = normalizeOptions(options, 'scanner');

  return {
    scanProofMedia: (input) => scanProofMedia(normalized, input)
  };
}

export function createHttpDriverProofMediaScanMonitor(options: HttpDriverProofMediaScannerOptions): DriverProofMediaScanMonitor {
  const normalized = normalizeOptions(options, 'scan monitor');

  return {
    recordProofMediaScan: (input) => recordProofMediaScan(normalized, input)
  };
}

async function scanProofMedia(options: NormalizedHttpOptions, input: DriverProofMediaScanInput): Promise<DriverProofMediaScanResult> {
  const response = await options.fetch(options.url, {
    body: input.fileBytes,
    headers: withAuthorization(options, {
      'content-type': input.contentType,
      'x-clever-proof-media-sha256': input.sha256,
      'x-clever-proof-media-storage-key': input.storageKey
    }),
    method: 'POST'
  });
  if (!response.ok) {
    throw new Error(`HTTP proof media scanner failed with HTTP ${response.status}`);
  }
  if (response.status === 204) {
    return { status: 'clean' };
  }

  return parseScannerResponse(await response.text());
}

async function recordProofMediaScan(options: NormalizedHttpOptions, input: DriverProofMediaScanMonitorInput): Promise<void> {
  const response = await options.fetch(options.url, {
    body: JSON.stringify({
      contentType: input.contentType,
      mediaId: input.mediaId,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      scannedAt: input.scannedAt.toISOString(),
      sha256: input.sha256,
      status: input.status,
      storageKey: input.storageKey
    }),
    headers: withAuthorization(options, {
      'content-type': 'application/json'
    }),
    method: 'POST'
  });
  if (!response.ok) {
    throw new Error(`HTTP proof media scan monitor failed with HTTP ${response.status}`);
  }
}

function parseScannerResponse(responseBody: string): DriverProofMediaScanResult {
  let payload: unknown;
  try {
    payload = responseBody.trim() === '' ? { status: 'clean' } : JSON.parse(responseBody);
  } catch {
    throw new Error('HTTP proof media scanner returned invalid JSON');
  }

  if (!isRecord(payload)) {
    throw new Error('HTTP proof media scanner returned an invalid payload');
  }
  if (payload.status === 'clean') {
    return { status: 'clean' };
  }
  if (payload.status === 'rejected') {
    return {
      reason: typeof payload.reason === 'string' && payload.reason.trim() !== '' ? payload.reason.trim() : 'scanner-rejected',
      status: 'rejected'
    };
  }

  throw new Error('HTTP proof media scanner returned an unsupported status');
}

function withAuthorization(options: NormalizedHttpOptions, headers: Record<string, string>): Record<string, string> {
  if (options.bearerToken === undefined) {
    return headers;
  }

  return {
    ...headers,
    authorization: `Bearer ${options.bearerToken}`
  };
}

function normalizeOptions(options: HttpDriverProofMediaScannerOptions, adapterName: string): NormalizedHttpOptions {
  const fetchImplementation = options.fetch ?? globalThis.fetch?.bind(globalThis);
  if (fetchImplementation === undefined) {
    throw new Error(`HTTP proof media ${adapterName} requires a fetch implementation`);
  }

  return {
    bearerToken: readOptional(options.bearerToken),
    fetch: fetchImplementation,
    url: readRequiredUrl(options.url, adapterName)
  };
}

function readRequiredUrl(value: string, adapterName: string): string {
  const normalized = readOptional(value);
  if (normalized === undefined) {
    throw new Error(`HTTP proof media ${adapterName} requires a URL`);
  }

  const parsed = new URL(normalized);
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
    throw new Error(`HTTP proof media ${adapterName} URL must use https except localhost smoke targets`);
  }

  return parsed.href;
}

function readOptional(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }

  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
