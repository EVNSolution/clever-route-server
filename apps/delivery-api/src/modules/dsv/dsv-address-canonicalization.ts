import type { GeocodingFailureCode } from '../geocoding/geocoding.types.js';
import type { GeocodingService } from '../geocoding/geocoding.service.js';

const postalCodePattern = /(?:^|\s|\()(\d{5})(?:$|\s|\))/u;
const roadAddressBasePattern = /^(.*(?:대로|로|길)\s*\d+(?:-\d+)?)(.*)$/u;
const parcelAddressBasePattern = /^(.*(?:읍|면|동|리)\s*(?:산\s*)?\d+(?:-\d+)?)(?:\s+(.+))$/u;

export type DsvAddressResolutionStatus =
  | 'ADDRESS_ONLY'
  | 'AMBIGUOUS'
  | 'NOT_FOUND'
  | 'RESOLVED'
  | 'UNAVAILABLE';

export type DsvCanonicalAddress = {
  address: string;
  detailAddress: string | null;
  jibunAddress: string | null;
  latitude: number | null;
  longitude: number | null;
  postalCode: string | null;
  rawAddress: string;
  status: DsvAddressResolutionStatus;
};

export type DsvAddressCanonicalizer = {
  resolve(input: { address: string; shopDomain: string }): Promise<DsvCanonicalAddress>;
};

type DsvGeocodingService = Pick<GeocodingService, 'geocode'>;

export function loadDsvAddressCanonicalizer(input: {
  geocodingService?: DsvGeocodingService;
}): DsvAddressCanonicalizer {
  if (input.geocodingService === undefined) {
    return {
      resolve: ({ address }) => Promise.resolve(unresolvedAddress(
        parseKoreanDeliveryAddress(address),
        'UNAVAILABLE',
      )),
    };
  }
  return new GeocodingDsvAddressCanonicalizer(input.geocodingService);
}

export class GeocodingDsvAddressCanonicalizer implements DsvAddressCanonicalizer {
  private readonly cache = new Map<string, Promise<DsvCanonicalAddress>>();

  constructor(private readonly geocodingService: DsvGeocodingService) {}

  resolve(input: { address: string; shopDomain: string }): Promise<DsvCanonicalAddress> {
    const parsed = parseKoreanDeliveryAddress(input.address);
    const cacheKey = `${input.shopDomain.trim().toLowerCase()}|${normalizeAddress(parsed.rawAddress)}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) return cached;
    const pending = this.resolveUncached(parsed, input.shopDomain);
    this.cache.set(cacheKey, pending);
    return pending;
  }

  private async resolveUncached(
    parsed: ReturnType<typeof parseKoreanDeliveryAddress>,
    shopDomain: string,
  ): Promise<DsvCanonicalAddress> {
    const geocode = await this.geocodingService.geocode({
      address: {
        address1: parsed.searchAddress,
        address2: null,
        city: null,
        countryCode: 'KR',
        postalCode: parsed.postalCode,
        province: null,
      },
      shopDomain,
    });

    if (!geocode.ok) {
      return unresolvedAddress(parsed, failureStatus(geocode.code));
    }

    const postalCode = cleanPostalCode(geocode.result.postalCode) ?? parsed.postalCode;
    if (postalCode === null) return unresolvedAddress(parsed, 'NOT_FOUND');

    return {
      address: parsed.searchAddress,
      detailAddress: parsed.detailAddress,
      jibunAddress: null,
      latitude: geocode.result.latitude,
      longitude: geocode.result.longitude,
      postalCode,
      rawAddress: parsed.rawAddress,
      status: 'RESOLVED',
    };
  }
}

export function parseKoreanDeliveryAddress(value: string): {
  detailAddress: string | null;
  postalCode: string | null;
  rawAddress: string;
  searchAddress: string;
} {
  const rawAddress = normalizeAddress(value);
  const postalMatch = rawAddress.match(postalCodePattern);
  const postalCode = postalMatch?.[1] ?? null;
  const withoutPostal = postalCode === null
    ? rawAddress
    : normalizeAddress(rawAddress.replace(postalMatch?.[0] ?? '', ' '));
  const commaIndex = topLevelCommaIndex(withoutPostal);
  if (commaIndex >= 0) {
    return {
      detailAddress: clean(withoutPostal.slice(commaIndex + 1)),
      postalCode,
      rawAddress,
      searchAddress: normalizeAddress(withoutPostal.slice(0, commaIndex)),
    };
  }
  const parts = withoutPostal.match(roadAddressBasePattern) ?? withoutPostal.match(parcelAddressBasePattern);
  const detailCandidate = clean(parts?.[2]?.replace(/^,\s*/u, ''));
  if (parts !== null && detailCandidate !== null) {
    return {
      detailAddress: detailCandidate,
      postalCode,
      rawAddress,
      searchAddress: normalizeAddress(parts[1] ?? withoutPostal),
    };
  }
  return { detailAddress: null, postalCode, rawAddress, searchAddress: withoutPostal };
}

function failureStatus(
  code: GeocodingFailureCode,
): Extract<DsvAddressResolutionStatus, 'NOT_FOUND' | 'UNAVAILABLE'> {
  return code === 'BLANK_ADDRESS' ||
    code === 'GEOCODER_INVALID_RESULT' ||
    code === 'GEOCODER_NO_RESULT'
    ? 'NOT_FOUND'
    : 'UNAVAILABLE';
}

function topLevelCommaIndex(value: string): number {
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '(') depth += 1;
    else if (character === ')') depth = Math.max(0, depth - 1);
    else if (character === ',' && depth === 0) return index;
  }
  return -1;
}

function unresolvedAddress(
  parsed: ReturnType<typeof parseKoreanDeliveryAddress>,
  status: Extract<DsvAddressResolutionStatus, 'AMBIGUOUS' | 'NOT_FOUND' | 'UNAVAILABLE'>,
): DsvCanonicalAddress {
  return {
    address: parsed.searchAddress,
    detailAddress: parsed.detailAddress,
    jibunAddress: null,
    latitude: null,
    longitude: null,
    postalCode: parsed.postalCode,
    rawAddress: parsed.rawAddress,
    status,
  };
}

function normalizeAddress(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').replace(/\s*,\s*/gu, ', ').trim();
}

function clean(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function cleanPostalCode(value: unknown): string | null {
  const normalized = clean(value)?.replace(/\D/gu, '') ?? '';
  return /^\d{5}$/u.test(normalized) ? normalized : null;
}
