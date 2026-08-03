import {
  GeocodingProviderError,
  type GeocodingLookupResult,
  type GeocodingPlaceCandidate,
  type GeocodingProvider,
  type GeocodingQuery,
} from './geocoding.types.js';

export type VWorldGeocodingClientOptions = {
  apiKey: string;
  fetchImpl?: typeof fetch;
  searchUrl?: string;
  timeoutMs?: number;
};

type VWorldAddressType = 'PARCEL' | 'ROAD';

type VWorldResponse = {
  error?: {
    code?: unknown;
    text?: unknown;
  };
  result?: {
    items?: unknown;
  };
  status?: unknown;
};

type VWorldSearchItem = {
  address?: {
    parcel?: unknown;
    road?: unknown;
    zipcode?: unknown;
  };
  id?: unknown;
  point?: {
    x?: unknown;
    y?: unknown;
  };
  title?: unknown;
};

const DEFAULT_SEARCH_URL = 'https://api.vworld.kr/req/search';
const ROAD_ADDRESS_PATTERN = /(?:대로|로|길)\s*\d/iu;
const RATE_LIMIT_ERROR_CODES = new Set([
  'OVER_REQUEST_LIMIT',
  'REQUEST_LIMIT_EXCEEDED',
  'TOO_MANY_REQUESTS',
]);

export class VWorldGeocodingClient implements GeocodingProvider {
  readonly providerName = 'vworld';
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly searchUrl: string;
  private readonly timeoutMs: number;

  constructor(options: VWorldGeocodingClientOptions) {
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.searchUrl = options.searchUrl ?? DEFAULT_SEARCH_URL;
    this.timeoutMs =
      typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
        ? Math.max(1000, Math.floor(options.timeoutMs))
        : 10000;
  }

  lookupKey(query: GeocodingQuery): string | null {
    return readAddress(query)?.toLocaleLowerCase('ko-KR') ?? null;
  }

  async geocodeAddress(query: GeocodingQuery): Promise<GeocodingLookupResult | null> {
    if (!isKoreanQuery(query)) return null;
    const address = readAddress(query);
    if (address === null) return null;

    for (const addressType of preferredAddressTypes(address)) {
      const result = await this.requestAddress(address, addressType, query);
      if (result !== null) return result;
    }
    return null;
  }

  async searchPlaces(query: { limit: number; text: string }): Promise<GeocodingPlaceCandidate[]> {
    const text = cleanAddress(query.text);
    if (text === null) return [];

    const url = new URL(this.searchUrl);
    url.searchParams.set('service', 'search');
    url.searchParams.set('request', 'search');
    url.searchParams.set('version', '2.0');
    url.searchParams.set('crs', 'EPSG:4326');
    url.searchParams.set('size', String(Math.max(1, Math.min(10, Math.floor(query.limit)))));
    url.searchParams.set('page', '1');
    url.searchParams.set('query', text);
    url.searchParams.set('type', 'place');
    url.searchParams.set('format', 'json');
    url.searchParams.set('errorformat', 'json');
    url.searchParams.set('key', this.apiKey);

    const body = await this.request(url);
    const status = readString(body.status)?.toUpperCase();
    if (status === 'NOT_FOUND') return [];
    if (status === 'ERROR') throw readProviderError(body);
    if (status !== 'OK') {
      throw new GeocodingProviderError(
        'INVALID_RESPONSE',
        'Geocoding provider returned invalid JSON shape.',
        { transient: false },
      );
    }

    return readItems(body.result?.items).flatMap((item) => {
      const latitude = readCoordinate(item.point?.y, 'latitude');
      const longitude = readCoordinate(item.point?.x, 'longitude');
      const title = cleanPlaceTitle(item.title);
      if (latitude === null || longitude === null || title === null) return [];
      return [{
        jibunAddress: readString(item.address?.parcel),
        latitude,
        longitude,
        providerPlaceId: readPlaceId(item.id),
        roadAddress: readString(item.address?.road),
        title,
      }];
    });
  }

  private async requestAddress(
    address: string,
    addressType: VWorldAddressType,
    query: GeocodingQuery,
  ): Promise<GeocodingLookupResult | null> {
    const url = new URL(this.searchUrl);
    url.searchParams.set('service', 'search');
    url.searchParams.set('request', 'search');
    url.searchParams.set('version', '2.0');
    url.searchParams.set('crs', 'EPSG:4326');
    url.searchParams.set('size', '1');
    url.searchParams.set('page', '1');
    url.searchParams.set('query', address);
    url.searchParams.set('type', 'address');
    url.searchParams.set('category', addressType);
    url.searchParams.set('format', 'json');
    url.searchParams.set('errorformat', 'json');
    url.searchParams.set('key', this.apiKey);

    const body = await this.request(url);
    const status = readString(body.status)?.toUpperCase();
    if (status === 'NOT_FOUND') return null;
    if (status === 'ERROR') throw readProviderError(body);
    if (status !== 'OK') {
      throw new GeocodingProviderError(
        'INVALID_RESPONSE',
        'Geocoding provider returned invalid JSON shape.',
        { transient: false },
      );
    }

    const item = readFirstItem(body.result?.items);
    if (item === null) return null;
    const latitude = readCoordinate(item.point?.y, 'latitude');
    const longitude = readCoordinate(item.point?.x, 'longitude');
    if (latitude === null || longitude === null) {
      throw new GeocodingProviderError(
        'INVALID_RESPONSE',
        'Geocoding provider returned invalid result.',
        { transient: false },
      );
    }

    const rawLabel =
      addressType === 'ROAD'
        ? readString(item.address?.road) ?? readString(item.address?.parcel)
        : readString(item.address?.parcel) ?? readString(item.address?.road);
    if (rawLabel !== null && !hasCompatibleProvince(address, rawLabel)) return null;
    return {
      addressLabel: query.shape,
      jibunAddress: readString(item.address?.parcel),
      latitude,
      longitude,
      postalCode: readPostalCode(item.address?.zipcode),
      provider: 'vworld',
      providerPlaceId: readPlaceId(item.id),
      rawLabel,
      roadAddress: readString(item.address?.road),
    };
  }

  private async request(url: URL): Promise<VWorldResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new GeocodingProviderError('TIMEOUT', 'Geocoding provider timed out.', {
          transient: true,
        });
      }
      throw new GeocodingProviderError('NETWORK_ERROR', 'Geocoding provider network error.', {
        transient: true,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      if (response.status === 429) {
        throw new GeocodingProviderError(
          'RATE_LIMITED',
          'Geocoding provider rate limit reached.',
          { status: response.status, transient: true },
        );
      }
      throw new GeocodingProviderError('HTTP_ERROR', 'Geocoding provider HTTP error.', {
        status: response.status,
        transient: response.status >= 500,
      });
    }

    return readResponse(await readPayload(response));
  }
}

function hasCompatibleProvince(query: string, result: string): boolean {
  const queryProvince = readKoreanProvince(query);
  const resultProvince = readKoreanProvince(result);
  return queryProvince === null || resultProvince === null || queryProvince === resultProvince;
}

function readKoreanProvince(value: string): string | null {
  const normalized = value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  const match = normalized.match(
    /^(서울(?:특별시)?|부산(?:광역시)?|대구(?:광역시)?|인천(?:광역시)?|광주(?:광역시)?|대전(?:광역시)?|울산(?:광역시)?|세종(?:특별자치시)?|경기(?:도)?|강원(?:특별자치도|도)?|충청북도|충북|충청남도|충남|전북특별자치도|전라북도|전북|전라남도|전남|경상북도|경북|경상남도|경남|제주특별자치도|제주도|제주)(?=\s|$)/u,
  )?.[1];
  if (match === undefined) return null;

  if (match.startsWith('서울')) return '서울';
  if (match.startsWith('부산')) return '부산';
  if (match.startsWith('대구')) return '대구';
  if (match.startsWith('인천')) return '인천';
  if (match.startsWith('광주')) return '광주';
  if (match.startsWith('대전')) return '대전';
  if (match.startsWith('울산')) return '울산';
  if (match.startsWith('세종')) return '세종';
  if (match.startsWith('경기')) return '경기';
  if (match.startsWith('강원')) return '강원';
  if (match === '충청북도' || match === '충북') return '충북';
  if (match === '충청남도' || match === '충남') return '충남';
  if (match === '전북특별자치도' || match === '전라북도' || match === '전북') return '전북';
  if (match === '전라남도' || match === '전남') return '전남';
  if (match === '경상북도' || match === '경북') return '경북';
  if (match === '경상남도' || match === '경남') return '경남';
  return '제주';
}

function isKoreanQuery(query: GeocodingQuery): boolean {
  const countryCodes =
    query.kind === 'freeform' ? query.countrycodes : query.params.countrycodes;
  if (countryCodes === undefined || countryCodes.trim() === '') return true;
  return countryCodes
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .includes('kr');
}

function readAddress(query: GeocodingQuery): string | null {
  if (query.shape === 'freeform_postal_only' || query.shape === 'structured_postal_only') {
    return null;
  }
  if (query.kind === 'freeform') {
    return cleanAddress(query.q.replace(/,\s*(?:KR|South Korea)\s*$/iu, ''));
  }
  return cleanAddress(
    [query.params.state, query.params.city, query.params.street]
      .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
      .join(' '),
  );
}

function cleanAddress(value: string): string | null {
  const normalized = value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  return normalized === '' || /^\d{5}$/u.test(normalized) ? null : normalized;
}

function preferredAddressTypes(address: string): VWorldAddressType[] {
  return ROAD_ADDRESS_PATTERN.test(address) ? ['ROAD', 'PARCEL'] : ['PARCEL', 'ROAD'];
}

async function readPayload(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new GeocodingProviderError(
      'INVALID_RESPONSE',
      'Geocoding provider returned invalid JSON.',
      { transient: false },
    );
  }
}

function readResponse(value: unknown): VWorldResponse {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new GeocodingProviderError(
      'INVALID_RESPONSE',
      'Geocoding provider returned invalid JSON shape.',
      { transient: false },
    );
  }
  const response = (value as Record<string, unknown>).response;
  if (response === null || typeof response !== 'object' || Array.isArray(response)) {
    throw new GeocodingProviderError(
      'INVALID_RESPONSE',
      'Geocoding provider returned invalid JSON shape.',
      { transient: false },
    );
  }
  return response;
}

function readProviderError(response: VWorldResponse): GeocodingProviderError {
  const code = readString(response.error?.code)?.toUpperCase() ?? 'UNKNOWN';
  if (RATE_LIMIT_ERROR_CODES.has(code)) {
    return new GeocodingProviderError(
      'RATE_LIMITED',
      'Geocoding provider rate limit reached.',
      { transient: true },
    );
  }
  return new GeocodingProviderError(
    'HTTP_ERROR',
    `Geocoding provider rejected the request (${code}).`,
    { transient: false },
  );
}

function readFirstItem(value: unknown): VWorldSearchItem | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const items: unknown[] = value;
  const item = items[0];
  return item !== null && typeof item === 'object' && !Array.isArray(item)
    ? item
    : null;
}

function readItems(value: unknown): VWorldSearchItem[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is VWorldSearchItem =>
    item !== null && typeof item === 'object' && !Array.isArray(item));
}

function readCoordinate(value: unknown, kind: 'latitude' | 'longitude'): number | null {
  const parsed =
    typeof value === 'string' || typeof value === 'number' ? Number(value) : Number.NaN;
  const min = kind === 'latitude' ? -90 : -180;
  const max = kind === 'latitude' ? 90 : 180;
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function readPostalCode(value: unknown): string | null {
  const normalized = readString(value)?.replace(/\D/gu, '') ?? '';
  return /^\d{5}$/u.test(normalized) ? normalized : null;
}

function readPlaceId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return readString(value);
}

function cleanPlaceTitle(value: unknown): string | null {
  const title = readString(value)?.replace(/<[^>]+>/gu, '').replace(/\s+/gu, ' ').trim() ?? '';
  return title === '' ? null : title;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}
