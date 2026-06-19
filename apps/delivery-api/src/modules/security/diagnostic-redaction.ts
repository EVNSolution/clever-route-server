const STREET_ADDRESS_DIAGNOSTIC_PATTERN =
  /\b\d{1,6}\s+[A-Za-z0-9][A-Za-z0-9\s.'-]{1,80}\s(?:Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Terrace|Way|Lane|Ln|Court|Ct|Boulevard|Blvd|Place|Pl)\b(?:\s+(?:North|South|East|West|N|S|E|W))?(?:\s*(?:,|Unit|Suite|Apt|#)\s*[A-Za-z0-9\s#,-]{0,80})?/giu;

export function redactDiagnosticValue(
  value: string | null,
  path?: string | null,
): string | null {
  if (value === null) return null;
  if (isSensitiveDiagnosticPath(path)) return '[redacted-secret]';
  const redacted = value
    .replace(STREET_ADDRESS_DIAGNOSTIC_PATTERN, '[redacted-address]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, '[redacted-email]')
    .replace(/\+?\d[\d\s().-]{7,}\d/gu, '[redacted-phone]')
    .replace(
      /\bauthorization\s*[:=]\s*(?:[A-Za-z]+\s+)?[^\s,;]+/giu,
      '[redacted-secret]',
    )
    .replace(
      /\b(?:access[_-]?token|api[_-]?key|api[_-]?token|auth[_-]?token|consumer[_-]?secret|consumer[_-]?key|cookie|password|private[_-]?key|refresh[_-]?token|secret|token|webhook[_-]?secret)\s*[:=]\s*\S+/giu,
      '[redacted-secret]',
    );
  return redacted.length > 96 ? `${redacted.slice(0, 93)}...` : redacted;
}

export function redactDiagnosticPath(value: string): string {
  return isSensitiveDiagnosticPath(value) ? '[redacted-sensitive-path]' : value;
}

export function isSensitiveDiagnosticPath(
  value: string | null | undefined,
): boolean {
  const normalized = value?.trim().toLowerCase() ?? '';
  return /(?:consumer[_-]?secret|consumer[_-]?key|webhook[_-]?secret|access[_-]?token|refresh[_-]?token|api[_-]?key|api[_-]?token|private[_-]?key|secret|password|cookie|authorization|auth[_-]?token)/u.test(
    normalized,
  );
}
