import { createHash } from 'node:crypto';

const SENSITIVE_KEY_PATTERN =
  /(?:authorization|cookie|hmac|id[_-]?token|access[_-]?token|refresh[_-]?token|session[_-]?token|token|secret|password|private[_-]?key|api[_-]?key|api[_-]?token|email|phone|address|name|note|payload|variables|raw)/iu;

const ALLOWED_KEYS = new Set([
  'attempt',
  'attemptCount',
  'code',
  'correlationId',
  'count',
  'countPrecision',
  'created',
  'createdCount',
  'cursorVersion',
  'durationMs',
  'elapsedMs',
  'event',
  'filterHash',
  'failed',
  'failedCount',
  'finalCanonicalCount',
  'hasNextPage',
  'highWatermark',
  'jobId',
  'message',
  'mode',
  'noOpCount',
  'nextRunAt',
  'pageCursor',
  'pointCount',
  'queueDepth',
  'requestId',
  'resolvedCount',
  'rowCount',
  'selectedCount',
  'scanned',
  'scannedCount',
  'shopHash',
  'staleSkipped',
  'staleSkippedCount',
  'status',
  'statusCode',
  'skippedCount',
  'topic',
  'totalCount',
  'unchanged',
  'unchangedCount',
  'updated',
  'updatedCount',
  'webhookId',
  'workerId'
]);

export function redactTelemetry(value: unknown, path = ''): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value, path);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      code: safeErrorCode(value.name),
      message: redactString(value.message, `${path}.message`)
    };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item, index) => redactTelemetry(item, `${path}[${index}]`));
  }
  if (typeof value !== 'object') return '[redacted]';

  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const nestedPath = path === '' ? key : `${path}.${key}`;
    if (!ALLOWED_KEYS.has(key) || SENSITIVE_KEY_PATTERN.test(key)) {
      output[redactTelemetryKey(key)] = '[redacted]';
      continue;
    }
    output[key] = redactTelemetry(nested, nestedPath);
  }
  return output;
}

export function redactTelemetryMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactString(message, 'message');
}

export function safeErrorCode(value: unknown): string {
  const raw = typeof value === 'string' && value.trim() !== '' ? value.trim() : 'UNKNOWN';
  const normalized = raw.toUpperCase().replace(/[^A-Z0-9_:-]/gu, '_').slice(0, 80);
  return normalized === '' ? 'UNKNOWN' : normalized;
}

export function hashTelemetryShop(value: string): string {
  return createHash('sha256').update(value.trim().toLowerCase()).digest('hex').slice(0, 16);
}

function redactTelemetryKey(key: string): string {
  return ALLOWED_KEYS.has(key) ? key : '[redacted-sensitive-path]';
}

function redactString(value: string, path: string): string {
  if (SENSITIVE_KEY_PATTERN.test(path)) return '[redacted]';
  let redacted = value;
  redacted = redacted.replace(/https?:\/\/[^\s)]+/giu, (urlValue) => redactUrl(urlValue));
  redacted = redacted.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, '[redacted-email]');
  redacted = redacted.replace(/\+?\d[\d\s().-]{7,}\d/gu, '[redacted-phone]');
  redacted = redacted.replace(
    /\b(?:authorization|cookie|hmac|id[_-]?token|access[_-]?token|refresh[_-]?token|session[_-]?token|token|secret|password|api[_-]?key|api[_-]?token)\s*[:=]\s*(?:Bearer\s+)?[^\s,;]+/giu,
    '[redacted-secret]'
  );
  redacted = redacted.replace(
    /\b\d{1,6}\s+[A-Za-z0-9][A-Za-z0-9\s.'-]{1,80}\s(?:Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Terrace|Way|Lane|Ln|Court|Ct|Boulevard|Blvd|Place|Pl)\b(?:\s+(?:North|South|East|West|N|S|E|W))?(?:\s*(?:,|Unit|Suite|Apt|#)\s*[A-Za-z0-9\s#,-]{0,80})?/giu,
    '[redacted-address]'
  );
  return redacted.length > 180 ? `${redacted.slice(0, 177)}...` : redacted;
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '[redacted-url]';
  }
}
