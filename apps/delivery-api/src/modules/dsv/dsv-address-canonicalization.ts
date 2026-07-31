import type { GeocodingService } from '../geocoding/geocoding.service.js';
import type {
  GeocodingFailureCode,
  GeocodingPlaceCandidate,
} from '../geocoding/geocoding.types.js';

const postalCodePattern = /(?:^|\s|\()(\d{5})(?:$|\s|\))/u;
const roadAddressBasePattern =
  /^(.*?(?:(?:대로|로|길)\s*\d+(?:-\d+)?번길|(?:대로|로|길)\s*\d+길|(?:대로|로|길))\s*\d+(?:-\d+)?)(.*)$/u;
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
  suggestions?: DsvAddressSuggestion[];
};

export type DsvAddressSuggestion = {
  address: string;
  detailAddress: string | null;
  jibunAddress: string | null;
  latitude: number;
  longitude: number;
  providerPlaceId: string | null;
  recommended: boolean;
  score: number;
  title: string;
};

export type DsvAddressCanonicalizer = {
  resolve(input: {
    address: string;
    destinationName?: string;
    shopDomain: string;
  }): Promise<DsvCanonicalAddress>;
};

type DsvGeocodingService =
  Pick<GeocodingService, 'geocode'>
  & Partial<Pick<GeocodingService, 'searchPlaces'>>;

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

  resolve(input: {
    address: string;
    destinationName?: string;
    shopDomain: string;
  }): Promise<DsvCanonicalAddress> {
    const parsed = parseKoreanDeliveryAddress(input.address);
    const cacheKey = [
      input.shopDomain.trim().toLowerCase(),
      normalizeAddress(parsed.rawAddress),
      normalizePlaceName(input.destinationName ?? ''),
    ].join('|');
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) return cached;
    const pending = this.resolveUncached(parsed, input.shopDomain, input.destinationName);
    this.cache.set(cacheKey, pending);
    return pending;
  }

  private async resolveUncached(
    parsed: ReturnType<typeof parseKoreanDeliveryAddress>,
    shopDomain: string,
    destinationName?: string,
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
      const status = failureStatus(geocode.code);
      return this.withSuggestions(
        unresolvedAddress(parsed, status),
        parsed,
        destinationName,
        status,
      );
    }

    const postalCode = cleanPostalCode(geocode.result.postalCode) ?? parsed.postalCode;
    if (postalCode === null) {
      return this.withSuggestions(
        unresolvedAddress(parsed, 'NOT_FOUND'),
        parsed,
        destinationName,
        'NOT_FOUND',
      );
    }

    return {
      address:
        clean(geocode.result.roadAddress) ??
        clean(geocode.result.rawLabel) ??
        parsed.searchAddress,
      detailAddress: parsed.detailAddress,
      jibunAddress: clean(geocode.result.jibunAddress),
      latitude: geocode.result.latitude,
      longitude: geocode.result.longitude,
      postalCode,
      rawAddress: parsed.rawAddress,
      status: 'RESOLVED',
    };
  }

  private async withSuggestions(
    unresolved: DsvCanonicalAddress,
    parsed: ReturnType<typeof parseKoreanDeliveryAddress>,
    destinationName: string | undefined,
    status: DsvAddressResolutionStatus,
  ): Promise<DsvCanonicalAddress> {
    const placeName = clean(destinationName);
    if (
      status !== 'NOT_FOUND'
      || placeName === null
      || this.geocodingService.searchPlaces === undefined
    ) return unresolved;

    try {
      const candidates = await this.geocodingService.searchPlaces({
        limit: 10,
        text: placeName,
      });
      const suggestions = rankDsvAddressSuggestions({
        candidates,
        detailAddress: parsed.detailAddress,
        destinationName: placeName,
        sourceAddress: parsed.searchAddress,
      });
      return suggestions.length === 0 ? unresolved : { ...unresolved, suggestions };
    } catch {
      return unresolved;
    }
  }
}

export function rankDsvAddressSuggestions(input: {
  candidates: GeocodingPlaceCandidate[];
  detailAddress: string | null;
  destinationName: string;
  sourceAddress: string;
}): DsvAddressSuggestion[] {
  const sourceHasRoadAddress = addressPartsForSuggestion(input.sourceAddress).road !== null;
  const ranked = input.candidates.flatMap((candidate) => {
    const roadAddress = clean(candidate.roadAddress);
    if (sourceHasRoadAddress && roadAddress === null) return [];
    const address = roadAddress ?? clean(candidate.jibunAddress);
    if (address === null) return [];
    const score = addressSuggestionScore({
      candidateAddress: address,
      candidateTitle: candidate.title,
      destinationName: input.destinationName,
      sourceAddress: input.sourceAddress,
    });
    if (score < 65) return [];
    return [{
      address,
      detailAddress: input.detailAddress,
      jibunAddress: candidate.jibunAddress,
      latitude: candidate.latitude,
      longitude: candidate.longitude,
      providerPlaceId: candidate.providerPlaceId,
      recommended: false,
      score,
      title: candidate.title,
    }];
  });
  const deduplicated = new Map<string, DsvAddressSuggestion>();
  for (const suggestion of ranked) {
    const key = normalizeAddress(suggestion.address);
    const existing = deduplicated.get(key);
    if (existing === undefined || suggestion.score > existing.score) {
      deduplicated.set(key, suggestion);
    }
  }
  const suggestions = [...deduplicated.values()]
    .sort((left, right) => right.score - left.score || left.address.localeCompare(right.address))
    .slice(0, 3);
  const first = suggestions[0];
  const second = suggestions[1];
  if (
    first !== undefined
    && first.score >= 82
    && (second === undefined || first.score - second.score >= 8)
  ) {
    suggestions[0] = { ...first, recommended: true };
  }
  return suggestions;
}

export function addressSuggestionScore(input: {
  candidateAddress: string;
  candidateTitle: string;
  destinationName: string;
  sourceAddress: string;
}): number {
  const source = addressPartsForSuggestion(input.sourceAddress);
  const candidate = addressPartsForSuggestion(input.candidateAddress);
  if (
    source.province !== null
    && candidate.province !== null
    && source.province !== candidate.province
  ) return 0;
  if (
    source.locality !== null
    && candidate.locality !== null
    && source.locality !== candidate.locality
  ) return 0;

  const destinationName = normalizePlaceName(input.destinationName);
  const candidateTitle = normalizePlaceName(input.candidateTitle);
  const containedPlaceName =
    Math.min(destinationName.length, candidateTitle.length) >= 3
    && (
      destinationName.includes(candidateTitle)
      || candidateTitle.includes(destinationName)
    );
  let score = Math.max(
    bigramJaccard(destinationName, candidateTitle) * 55,
    containedPlaceName ? 45 : 0,
  );
  if (source.province !== null && source.province === candidate.province) score += 12;
  if (source.locality !== null && source.locality === candidate.locality) score += 13;
  if (source.road !== null && candidate.road !== null) {
    if (source.road === candidate.road) score += 15;
    else if (withinOneCharacterEdit(source.road, candidate.road)) score += 12;
  }
  if (source.number !== null && candidate.number !== null) {
    const distance = Math.abs(source.number - candidate.number);
    if (distance === 0) score += 5;
    else if (distance <= 20) score += 3;
    else if (distance <= 50) score += 1;
  }
  return Math.round(score);
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
  const parts = withoutPostal.match(roadAddressBasePattern) ?? withoutPostal.match(parcelAddressBasePattern);
  const detailCandidate = clean(parts?.[2]?.replace(/^,\s*/u, ''));
  if (parts !== null && detailCandidate !== null) {
    return {
      detailAddress: detailCandidate,
      postalCode,
      rawAddress,
      searchAddress: normalizeKoreanRoadSpacing(
        normalizeAddress(parts[1] ?? withoutPostal),
      ),
    };
  }
  const commaIndex = topLevelCommaIndex(withoutPostal);
  if (commaIndex >= 0) {
    return {
      detailAddress: clean(withoutPostal.slice(commaIndex + 1)),
      postalCode,
      rawAddress,
      searchAddress: normalizeKoreanRoadSpacing(
        normalizeAddress(withoutPostal.slice(0, commaIndex)),
      ),
    };
  }
  return {
    detailAddress: null,
    postalCode,
    rawAddress,
    searchAddress: normalizeKoreanRoadSpacing(withoutPostal),
  };
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

function normalizePlaceName(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^0-9a-z가-힣]/gu, '');
}

function bigramJaccard(left: string, right: string): number {
  if (left === '' || right === '') return 0;
  if (left === right) return 1;
  const leftBigrams = bigrams(left);
  const rightBigrams = bigrams(right);
  const union = new Set([...leftBigrams, ...rightBigrams]);
  let intersection = 0;
  for (const value of leftBigrams) {
    if (rightBigrams.has(value)) intersection += 1;
  }
  return union.size === 0 ? 0 : intersection / union.size;
}

function bigrams(value: string): Set<string> {
  if (value.length < 2) return new Set([value]);
  return new Set(Array.from({ length: value.length - 1 }, (_, index) =>
    value.slice(index, index + 2)));
}

function withinOneCharacterEdit(left: string, right: string): boolean {
  const leftCharacters = [...left];
  const rightCharacters = [...right];
  if (Math.abs(leftCharacters.length - rightCharacters.length) > 1) return false;
  if (leftCharacters.length === rightCharacters.length) {
    return leftCharacters.reduce(
      (differences, character, index) =>
        differences + (character === rightCharacters[index] ? 0 : 1),
      0,
    ) <= 1;
  }
  const [shorter, longer] = leftCharacters.length < rightCharacters.length
    ? [leftCharacters, rightCharacters]
    : [rightCharacters, leftCharacters];
  let shorterIndex = 0;
  let longerIndex = 0;
  let skipped = false;
  while (shorterIndex < shorter.length && longerIndex < longer.length) {
    if (shorter[shorterIndex] === longer[longerIndex]) {
      shorterIndex += 1;
      longerIndex += 1;
      continue;
    }
    if (skipped) return false;
    skipped = true;
    longerIndex += 1;
  }
  return true;
}

function addressPartsForSuggestion(value: string): {
  locality: string | null;
  number: number | null;
  province: string | null;
  road: string | null;
} {
  const normalized = normalizeAddress(value);
  const province = normalized.match(
    /^(서울(?:특별시)?|부산(?:광역시)?|대구(?:광역시)?|인천(?:광역시)?|광주(?:광역시)?|대전(?:광역시)?|울산(?:광역시)?|세종(?:특별자치시)?|경기(?:도)?|강원(?:특별자치도|도)?|충청북도|충북|충청남도|충남|전북특별자치도|전라북도|전북|전라남도|전남|경상북도|경북|경상남도|경남|제주특별자치도|제주도|제주)(?=\s|$)/u,
  )?.[1] ?? null;
  const normalizedProvince = province === null ? null : normalizeProvince(province);
  const administrativeTokens = normalized.match(/[가-힣]+(?:시|군|구)(?=\s|$)/gu) ?? [];
  const locality = administrativeTokens.find((token) =>
    normalizeProvince(token) !== normalizedProvince) ?? null;
  const roadMatch = normalized.match(/([가-힣0-9]+(?:대로|로|길)(?:\d+번길)?)\s*(\d+(?:-\d+)?)/u);
  return {
    locality,
    number: roadMatch?.[2] === undefined ? null : Number.parseInt(roadMatch[2], 10),
    province: normalizedProvince,
    road: roadMatch?.[1] ?? null,
  };
}

function normalizeProvince(value: string): string {
  if (value.startsWith('서울')) return '서울';
  if (value.startsWith('부산')) return '부산';
  if (value.startsWith('대구')) return '대구';
  if (value.startsWith('인천')) return '인천';
  if (value.startsWith('광주')) return '광주';
  if (value.startsWith('대전')) return '대전';
  if (value.startsWith('울산')) return '울산';
  if (value.startsWith('세종')) return '세종';
  if (value.startsWith('경기')) return '경기';
  if (value.startsWith('강원')) return '강원';
  if (value === '충청북도' || value === '충북') return '충북';
  if (value === '충청남도' || value === '충남') return '충남';
  if (value === '전북특별자치도' || value === '전라북도' || value === '전북') return '전북';
  if (value === '전라남도' || value === '전남') return '전남';
  if (value === '경상북도' || value === '경북') return '경북';
  if (value === '경상남도' || value === '경남') return '경남';
  if (value.startsWith('제주')) return '제주';
  return value;
}

function normalizeKoreanRoadSpacing(value: string): string {
  return value
    .replace(/(대로|로|길)\s+(\d+(?:-\d+)?)번길/gu, '$1$2번길')
    .replace(/(\d+(?:-\d+)?번길|대로|로|길)\s*(\d+(?:-\d+)?)(?=$|\s|\()/gu, '$1 $2');
}

function clean(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function cleanPostalCode(value: unknown): string | null {
  const normalized = clean(value)?.replace(/\D/gu, '') ?? '';
  return /^\d{5}$/u.test(normalized) ? normalized : null;
}
