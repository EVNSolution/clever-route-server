import { Prisma } from '@prisma/client';

/**
 * One delivery place is one customer name at one address core: the road
 * address up to the building number (시도 시군구 도로명 건물번호), or for a
 * jibun-only address the 동/리 and lot number. Everything after that — floor,
 * unit, building name, the (동, 건물) reference note — is free text each
 * dispatch file spells differently, so it is not part of the identity.
 * Addresses with neither core fall back to the full text with the detail
 * appended once.
 * Whitespace and commas never count, the leading province is spelled the short
 * way (경기도 → 경기), 읍/면 is dropped so a 면 promoted to 읍 stays one place,
 * and corporate markers ((주), 주식회사) are dropped from the name.
 * Keep the SQL variants below in lockstep.
 */
export function dsvDestinationIdentity(input: {
  address: string;
  detailAddress?: string | null | undefined;
  destinationName: string;
}): { address: string; name: string } {
  const core = dsvDestinationAddressCore(input.address);
  return {
    address: core !== undefined ? normalizeIdentityAddress(core) : fallbackAddress(input.address, input.detailAddress),
    name: normalizeDestinationIdentityText(input.destinationName).replace(corporateMarkerPattern, ''),
  };
}

// Road name ends in 로/길, an optional N번길/N길 branch, then the building number.
// The lookahead keeps the number whole and rejects 번길/길/가 continuations.
const roadAddressCoreSource = String.raw`^(.*?(로|길)\s*([0-9]+\s*번?\s*길)?\s*[0-9]+(\s*-\s*[0-9]+)?)(?![0-9]|\s*-\s*[0-9]|\s*번|\s*길|\s*가)`;
const roadAddressCorePattern = new RegExp(roadAddressCoreSource, 'u');
// 동/리 (optionally N가), optional 산, lot number. Used only when no road core exists.
const parcelAddressCoreSource = String.raw`^(.*?(동|리|가)\s*(산\s*)?[0-9]+(\s*-\s*[0-9]+)?)(?![0-9]|\s*-\s*[0-9]|\s*가|\s*번길|\s*길|\s*로)`;
const parcelAddressCorePattern = new RegExp(parcelAddressCoreSource, 'u');
const townshipSource = String.raw`(시|군|구)([가-힣]{1,4}?)(읍|면)`;
const townshipPattern = new RegExp(townshipSource, 'u');

export function hasDsvRoadAddress(address: string): boolean {
  return dsvRoadAddressBase(address) !== null;
}

/** The road address up to the building number, as written (e.g. "서울 광진구 자양로38길 10"). */
export function dsvRoadAddressBase(address: string): string | null {
  return roadAddressCorePattern.exec(address.normalize('NFKC'))?.[1]?.trim() ?? null;
}

function dsvDestinationAddressCore(address: string): string | undefined {
  const text = address.normalize('NFKC').toLowerCase();
  return roadAddressCorePattern.exec(text)?.[1] ?? parcelAddressCorePattern.exec(text)?.[1];
}
const corporateMarkerSource = String.raw`\(주\)|주식회사|\(유\)|유한회사`;
const corporateMarkerPattern = new RegExp(corporateMarkerSource, 'gu');

export function dsvDestinationIdentitySqlText(value: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`LOWER(REGEXP_REPLACE(NORMALIZE(COALESCE(${value}, ''), NFKC), '[\\s,]+', '', 'g'))`;
}

export function dsvDestinationIdentitySqlName(value: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`REGEXP_REPLACE(${dsvDestinationIdentitySqlText(value)}, ${corporateMarkerSource}, '', 'g')`;
}

export function dsvDestinationIdentitySqlAddress(baseAddress: Prisma.Sql, detailAddress: Prisma.Sql): Prisma.Sql {
  const text = Prisma.sql`LOWER(NORMALIZE(COALESCE(${baseAddress}, ''), NFKC))`;
  const core = Prisma.sql`COALESCE((REGEXP_MATCH(${text}, ${roadAddressCoreSource}))[1], (REGEXP_MATCH(${text}, ${parcelAddressCoreSource}))[1])`;
  const base = sqlProvince(dsvDestinationIdentitySqlText(baseAddress));
  const detail = dsvDestinationIdentitySqlText(detailAddress);
  return Prisma.sql`CASE
    WHEN ${core} IS NOT NULL THEN ${sqlProvince(dsvDestinationIdentitySqlText(core))}
    WHEN ${detail} = '' OR RIGHT(${base}, LENGTH(${detail})) = ${detail} THEN ${base}
    ELSE ${base} || ${detail}
  END`;
}

function sqlProvince(value: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(${value},
    '^(충|전|경)(청|라|상)(북|남)도', '\\1\\3'), '^(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)(특별시|광역시|특별자치시|특별자치도|도)', '\\1'),
    ${townshipSource}, '\\1\\2')`;
}

function fallbackAddress(address: string, detailAddress: string | null | undefined): string {
  const base = normalizeIdentityAddress(address);
  const detail = normalizeDestinationIdentityText(detailAddress ?? '');
  return detail === '' || base.endsWith(detail) ? base : `${base}${detail}`;
}

function normalizeIdentityAddress(address: string): string {
  return normalizeIdentityProvince(normalizeDestinationIdentityText(address));
}

function normalizeDestinationIdentityText(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[\s,]+/gu, '');
}

function normalizeIdentityProvince(address: string): string {
  return address
    .replace(/^(충|전|경)(?:청|라|상)(북|남)도/u, '$1$2')
    .replace(/^(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)(?:특별시|광역시|특별자치시|특별자치도|도)/u, '$1')
    .replace(townshipPattern, '$1$2');
}
