import { Prisma } from '@prisma/client';

export function dsvDestinationIdentity(input: {
  address: string;
  detailAddress?: string | null | undefined;
  destinationName: string;
}): { address: string; name: string } {
  return {
    address: normalizeDestinationIdentityText([input.address, input.detailAddress]
      .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
      .join(' ')),
    name: normalizeDestinationIdentityText(input.destinationName),
  };
}

export function dsvDestinationIdentitySqlText(value: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`LOWER(REGEXP_REPLACE(NORMALIZE(BTRIM(${value}), NFKC), '\\s+', ' ', 'g'))`;
}

export function dsvDestinationIdentitySqlAddress(baseAddress: Prisma.Sql, detailAddress: Prisma.Sql): Prisma.Sql {
  return dsvDestinationIdentitySqlText(Prisma.sql`CONCAT_WS(' ', NULLIF(BTRIM(${baseAddress}), ''), NULLIF(BTRIM(${detailAddress}), ''))`);
}

function normalizeDestinationIdentityText(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}
