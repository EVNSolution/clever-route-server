import { Prisma } from '@prisma/client';

/**
 * Destination identity ignores whitespace and commas, spells the leading
 * province the short way (경기도 → 경기, 서울특별시 → 서울), and does not count
 * the detail address twice when the base address already ends with it.
 * Imported rows often carry the full raw cell as the base address
 * ("...번길30, 1층") next to a parsed detail ("1층"), and spacing differs
 * between dispatch files. Keep the SQL variants below in lockstep.
 */
export function dsvDestinationIdentity(input: {
  address: string;
  detailAddress?: string | null | undefined;
  destinationName: string;
}): { address: string; name: string } {
  const address = normalizeIdentityProvince(normalizeDestinationIdentityText(input.address));
  const detail = normalizeDestinationIdentityText(input.detailAddress ?? '');
  return {
    address: detail === '' || address.endsWith(detail) ? address : `${address}${detail}`,
    name: normalizeDestinationIdentityText(input.destinationName),
  };
}

export function dsvDestinationIdentitySqlText(value: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`LOWER(REGEXP_REPLACE(NORMALIZE(COALESCE(${value}, ''), NFKC), '[\\s,]+', '', 'g'))`;
}

export function dsvDestinationIdentitySqlAddress(baseAddress: Prisma.Sql, detailAddress: Prisma.Sql): Prisma.Sql {
  const base = Prisma.sql`REGEXP_REPLACE(REGEXP_REPLACE(${dsvDestinationIdentitySqlText(baseAddress)},
    '^(충|전|경)(청|라|상)(북|남)도', '\\1\\3'), '^(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)(특별시|광역시|특별자치시|특별자치도|도)', '\\1')`;
  const detail = dsvDestinationIdentitySqlText(detailAddress);
  return Prisma.sql`CASE
    WHEN ${detail} = '' OR RIGHT(${base}, LENGTH(${detail})) = ${detail} THEN ${base}
    ELSE ${base} || ${detail}
  END`;
}

function normalizeDestinationIdentityText(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[\s,]+/gu, '');
}

function normalizeIdentityProvince(address: string): string {
  return address
    .replace(/^(충|전|경)(?:청|라|상)(북|남)도/u, '$1$2')
    .replace(/^(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)(?:특별시|광역시|특별자치시|특별자치도|도)/u, '$1');
}
