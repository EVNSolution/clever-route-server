const MAX_HOSTNAME_LENGTH = 255;

export function normalizeDriverCommerceDomain(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const withoutProtocol = trimmed.replace(/^https?:\/\//u, '');
  const separatorIndex = findFirstSeparatorIndex(withoutProtocol);
  const host = separatorIndex === -1 ? withoutProtocol : withoutProtocol.slice(0, separatorIndex);
  const suffix = separatorIndex === -1 ? '' : withoutProtocol.slice(separatorIndex);

  if (suffix.includes('..') || suffix.includes('\\')) {
    throw new Error('Commerce domain is not a valid customer domain');
  }

  if (!isValidCommerceHostname(host)) {
    throw new Error('Commerce domain is not a valid customer domain');
  }

  return host;
}

function findFirstSeparatorIndex(value: string): number {
  const indexes = ['/', '?', '#']
    .map((separator) => value.indexOf(separator))
    .filter((index) => index >= 0);

  return indexes.length === 0 ? -1 : Math.min(...indexes);
}

function isValidCommerceHostname(host: string): boolean {
  if (
    host.length === 0 ||
    host.length > MAX_HOSTNAME_LENGTH ||
    host.startsWith('.') ||
    host.endsWith('.') ||
    !host.includes('.') ||
    host.includes('..') ||
    !/^[a-z0-9.-]+$/u.test(host)
  ) {
    return false;
  }

  return host.split('.').every((label) =>
    label.length > 0 &&
    label.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)
  );
}
