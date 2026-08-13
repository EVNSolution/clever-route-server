const accountSubjectPrefix = 'dsv-admin-account:';
const legacySubjectPrefix = 'dsv-shop:';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type DsvAdminSessionSubject =
  | {
      accountId: string;
      activeSessionId: string;
      kind: 'account';
      shopDomain: string;
    }
  | {
      kind: 'legacy';
      shopDomain: string;
    };

export function createDsvAdminSessionSubject(input: {
  accountId: string;
  activeSessionId: string;
  shopDomain: string;
}): string {
  const accountId = input.accountId.trim().toLowerCase();
  const activeSessionId = input.activeSessionId.trim().toLowerCase();
  const shopDomain = normalizeShopDomain(input.shopDomain);
  if (!uuidPattern.test(accountId) || !uuidPattern.test(activeSessionId) || shopDomain === null) {
    throw new Error('Invalid DSV admin session subject');
  }
  return `${accountSubjectPrefix}${accountId}:${activeSessionId}:${shopDomain}`;
}

export function parseDsvAdminSessionSubject(subject: string): DsvAdminSessionSubject | null {
  if (subject.startsWith(accountSubjectPrefix)) {
    const parts = subject.slice(accountSubjectPrefix.length).split(':');
    if (parts.length !== 3) return null;
    const [accountId, activeSessionId, rawShopDomain] = parts;
    const shopDomain = normalizeShopDomain(rawShopDomain);
    if (!uuidPattern.test(accountId ?? '') || !uuidPattern.test(activeSessionId ?? '') || shopDomain === null) {
      return null;
    }
    return { accountId: accountId!, activeSessionId: activeSessionId!, kind: 'account', shopDomain };
  }
  if (!subject.startsWith(legacySubjectPrefix)) return null;
  const shopDomain = normalizeShopDomain(subject.slice(legacySubjectPrefix.length));
  return shopDomain === null ? null : { kind: 'legacy', shopDomain };
}

function normalizeShopDomain(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized === undefined || normalized === '' || normalized.includes(':') ? null : normalized;
}
