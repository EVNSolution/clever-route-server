import type { Prisma } from '@prisma/client';

export function normalizeOrderNumberPrefix(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const withoutLeadingHash = trimmed.startsWith('#') ? trimmed.slice(1).trimStart() : trimmed;
  if (withoutLeadingHash === '' || withoutLeadingHash.startsWith('#')) {
    throw new Error('invalid order number prefix');
  }
  return withoutLeadingHash;
}

/** Accepts only a boundary-normalized prefix. Public request parsers remove one optional leading #. */
export function orderNumberPrefixWhere(value: string | undefined): Prisma.OrderWhereInput | null {
  const prefix = value?.trim();
  if (!prefix) return null;
  const literalPrefix = escapePrismaLikePattern(prefix);
  return {
    OR: [
      { name: { mode: 'insensitive', startsWith: literalPrefix } },
      { name: { mode: 'insensitive', startsWith: `#${literalPrefix}` } },
    ],
  };
}

function escapePrismaLikePattern(value: string): string {
  return value.replace(/[\\%_]/gu, '\\$&');
}
