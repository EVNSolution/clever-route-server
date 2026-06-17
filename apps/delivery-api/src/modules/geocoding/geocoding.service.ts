import {
  GeocodingProviderError,
  type GeocodingAddress,
  type GeocodingFailureCode,
  type GeocodingLookupResult,
  type GeocodingProvider,
  type GeocodingQuery,
  type GeocodingQueryShape,
  type GeocodingResult,
} from './geocoding.types.js';

export type GeocodingProviderPolicy = 'disabled' | 'private_nominatim_compatible' | 'public_nominatim';

export type GeocodingServiceOptions = {
  maxRetries?: number;
  minIntervalMs?: number;
  mode: 'disabled' | 'nominatim_compatible';
  persistentCacheEnabled?: boolean;
  provider?: GeocodingProvider;
  providerPolicy?: GeocodingProviderPolicy;
  rateLimiter?: GeocodingRateLimiter;
  requirePersistentCache?: boolean;
};

type CachedGeocode = {
  cachedAt: number;
  result: GeocodingResult;
};

type ProviderCallState = {
  attemptCount: number;
  queryShapes: GeocodingQueryShape[];
};

export type GeocodingServiceStatus = {
  mode: GeocodingServiceOptions['mode'];
  persistentCacheEnabled: boolean;
  providerPolicy?: GeocodingProviderPolicy;
};

export type GeocodingRateLimiter = {
  wait(minIntervalMs: number): Promise<void>;
};

export class SerializedGeocodingRateLimiter implements GeocodingRateLimiter {
  private queue: Promise<void> = Promise.resolve();
  private lastRequestAt = 0;

  async wait(minIntervalMs: number): Promise<void> {
    const run = this.queue.then(async () => {
      const now = Date.now();
      const waitMs = Math.max(0, minIntervalMs - (now - this.lastRequestAt));
      if (waitMs > 0) await sleep(waitMs);
      this.lastRequestAt = Date.now();
    });
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }
}

export class GeocodingService {
  private readonly cache = new Map<string, CachedGeocode>();
  private readonly maxRetries: number;
  private readonly minIntervalMs: number;
  private readonly mode: GeocodingServiceOptions['mode'];
  private readonly persistentCacheEnabled: boolean;
  private readonly provider: GeocodingProvider | undefined;
  private readonly providerPolicy: GeocodingProviderPolicy;
  private readonly rateLimiter: GeocodingRateLimiter;
  private readonly requirePersistentCache: boolean;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: GeocodingServiceOptions) {
    this.maxRetries =
      typeof options.maxRetries === 'number' && Number.isFinite(options.maxRetries)
        ? Math.max(0, Math.floor(options.maxRetries))
        : 1;
    this.minIntervalMs = options.minIntervalMs ?? 1000;
    this.mode = options.mode;
    this.persistentCacheEnabled = options.persistentCacheEnabled === true;
    this.provider = options.provider;
    this.providerPolicy =
      options.providerPolicy ??
      (options.mode === 'disabled' ? 'disabled' : 'private_nominatim_compatible');
    this.rateLimiter = options.rateLimiter ?? new SerializedGeocodingRateLimiter();
    this.requirePersistentCache = options.requirePersistentCache === true;
  }

  get status(): GeocodingServiceStatus {
    return {
      mode: this.mode,
      persistentCacheEnabled: this.persistentCacheEnabled,
      providerPolicy: this.providerPolicy,
    };
  }

  async geocode(input: { address: GeocodingAddress; shopDomain: string }): Promise<GeocodingResult> {
    const queries = buildGeocodingQueries(input.address);
    const primaryQuery = queries[0] ?? null;
    if (primaryQuery === null) {
      return { ok: false, code: 'BLANK_ADDRESS', message: 'Address is blank.' };
    }
    if (this.mode === 'disabled') {
      return { ok: false, code: 'GEOCODER_DISABLED', message: 'Geocoding is disabled for this runtime.' };
    }
    if (this.provider === undefined) {
      return { ok: false, code: 'GEOCODER_NOT_CONFIGURED', message: 'Geocoding provider is not configured.' };
    }
    if (this.requirePersistentCache && !this.persistentCacheEnabled) {
      return {
        ok: false,
        code: 'GEOCODER_NOT_CONFIGURED',
        message: 'Public geocoding requires durable per-order metadata or persistent cache.'
      };
    }

    const key = `${input.shopDomain.trim().toLowerCase()}|${primaryQuery.cacheKey}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached.result.ok ? { ...cached.result, cached: true } : cached.result;
    }

    const provider = this.provider;
    const result = await this.runSerialized(async () => {
      const state: ProviderCallState = { attemptCount: 0, queryShapes: [] };
      let sawInvalidResult = false;
      for (const lookupQuery of queries) {
        state.queryShapes.push(lookupQuery.shape);
        const lookup = await this.geocodeQuery(provider, lookupQuery, state);
        if (lookup.kind === 'provider_error') {
          return buildFailureFromProviderError(lookup.error, state);
        }
        if (lookup.kind === 'invalid_result') {
          sawInvalidResult = true;
          continue;
        }
        if (lookup.kind === 'no_result') continue;
        return {
          attemptCount: state.attemptCount,
          cached: false,
          ok: true,
          queryShapes: [...new Set(state.queryShapes)],
          result: lookup.result,
        } satisfies GeocodingResult;
      }
      const queryShapes = [...new Set(state.queryShapes)];
      if (sawInvalidResult) {
        return {
          attemptCount: state.attemptCount,
          code: 'GEOCODER_INVALID_RESULT',
          message: 'Geocoding provider returned invalid coordinates.',
          ok: false,
          queryShapes,
        } satisfies GeocodingResult;
      }
      return {
        attemptCount: state.attemptCount,
        code: 'GEOCODER_NO_RESULT',
        message: 'No geocoding result was found.',
        ok: false,
        queryShapes,
      } satisfies GeocodingResult;
    });
    if (result.ok || result.transient !== true) {
      this.cache.set(key, { cachedAt: Date.now(), result });
    }
    return result;
  }

  private async geocodeQuery(
    provider: GeocodingProvider,
    query: GeocodingQuery,
    state: ProviderCallState,
  ): Promise<
    | { kind: 'found'; result: GeocodingLookupResult }
    | { kind: 'invalid_result' }
    | { error: GeocodingProviderError; kind: 'provider_error' }
    | { kind: 'no_result' }
  > {
    let attempt = 0;
    while (true) {
      attempt += 1;
      state.attemptCount += 1;
      try {
        await this.waitForProviderRateLimit();
        const lookup = await provider.geocodeAddress(query);
        if (lookup === null) return { kind: 'no_result' };
        if (!isValidCoordinate(lookup.latitude, 'latitude') || !isValidCoordinate(lookup.longitude, 'longitude')) {
          return { kind: 'invalid_result' };
        }
        return { kind: 'found', result: lookup };
      } catch (error) {
        const providerError = normalizeProviderError(error);
        if (!this.shouldRetryProviderError(providerError, attempt)) {
          return { error: providerError, kind: 'provider_error' };
        }
        await sleep(Math.max(this.minIntervalMs, 250 * attempt));
      }
    }
  }

  private shouldRetryProviderError(error: GeocodingProviderError, attempt: number): boolean {
    if (error.kind === 'RATE_LIMITED') return false;
    if (!error.transient) return false;
    if (this.providerPolicy === 'public_nominatim') return attempt <= Math.min(this.maxRetries, 1);
    return attempt <= this.maxRetries;
  }

  private async runSerialized<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async waitForProviderRateLimit(): Promise<void> {
    await this.rateLimiter.wait(this.minIntervalMs);
  }
}

export function normalizeAddress(address: GeocodingAddress): string | null {
  return normalizeAddressParts(addressParts(address));
}

export function normalizeAddressQueries(address: GeocodingAddress): string[] {
  return buildGeocodingQueries(address).flatMap((query) =>
    query.kind === 'freeform' ? [query.q] : [],
  );
}

export function buildGeocodingQueries(address: GeocodingAddress): GeocodingQuery[] {
  const full = normalizeAddress(address);
  if (full === null) return [];

  const withoutUnitAddress: GeocodingAddress = { ...address, address2: null };
  const withoutUnit = normalizeAddress(withoutUnitAddress);
  const structuredWithoutUnit = buildStructuredQuery(withoutUnitAddress, 'structured_without_unit');
  const structuredFull =
    address.address2 === null || address.address2.trim() === ''
      ? null
      : buildStructuredQuery(address, 'structured');
  const hasCity = clean(address.city) !== null;
  const hasPostalCode = clean(address.postalCode) !== null;

  const withoutCityAddress: GeocodingAddress = { ...address, city: null };
  const withoutUnitAndCityAddress: GeocodingAddress = {
    ...address,
    address2: null,
    city: null,
  };
  const withoutUnitAndCity = normalizeAddress(withoutUnitAndCityAddress);
  const fullWithoutCity = normalizeAddress(withoutCityAddress);
  const structuredWithoutUnitNoCity = hasCity
    ? buildStructuredQuery(withoutUnitAndCityAddress, 'structured_without_unit_no_city')
    : null;
  const structuredFullNoCity =
    hasCity && address.address2 !== null && address.address2.trim() !== ''
      ? buildStructuredQuery(withoutCityAddress, 'structured_no_city')
      : null;

  const withoutPostalAddress: GeocodingAddress = { ...address, postalCode: null };
  const postalOnlyAddress: GeocodingAddress = {
    ...address,
    address1: null,
    address2: null,
    city: null,
    province: null,
  };
  const withoutUnitAndPostalAddress: GeocodingAddress = {
    ...address,
    address2: null,
    postalCode: null,
  };
  const postalOnly = normalizeAddress(postalOnlyAddress);
  const structuredPostalOnly = hasPostalCode
    ? buildStructuredQuery(postalOnlyAddress, 'structured_postal_only')
    : null;
  const withoutUnitAndPostal = normalizeAddress(withoutUnitAndPostalAddress);
  const fullWithoutPostal = normalizeAddress(withoutPostalAddress);
  const structuredWithoutUnitNoPostal = hasPostalCode
    ? buildStructuredQuery(withoutUnitAndPostalAddress, 'structured_without_unit_no_postal')
    : null;
  const structuredFullNoPostal =
    hasPostalCode && address.address2 !== null && address.address2.trim() !== ''
      ? buildStructuredQuery(withoutPostalAddress, 'structured_no_postal')
      : null;

  const withoutCityAndPostalAddress: GeocodingAddress = {
    ...address,
    city: null,
    postalCode: null,
  };
  const withoutUnitCityAndPostalAddress: GeocodingAddress = {
    ...address,
    address2: null,
    city: null,
    postalCode: null,
  };
  const withoutUnitCityAndPostal = normalizeAddress(withoutUnitCityAndPostalAddress);
  const fullWithoutCityAndPostal = normalizeAddress(withoutCityAndPostalAddress);
  const shouldTryNoCityNoPostal = hasCity && hasPostalCode;
  const structuredWithoutUnitNoCityNoPostal = shouldTryNoCityNoPostal
    ? buildStructuredQuery(
        withoutUnitCityAndPostalAddress,
        'structured_without_unit_no_city_no_postal',
      )
    : null;
  const structuredFullNoCityNoPostal =
    shouldTryNoCityNoPostal && address.address2 !== null && address.address2.trim() !== ''
      ? buildStructuredQuery(withoutCityAndPostalAddress, 'structured_no_city_no_postal')
      : null;

  return uniqueGeocodingQueries([
    hasPostalCode && postalOnly !== null
      ? buildFreeformQuery(postalOnly, 'freeform_postal_only')
      : null,
    structuredPostalOnly,
    structuredWithoutUnit,
    structuredFull,
    withoutUnit === null ? null : buildFreeformQuery(withoutUnit, 'freeform_without_unit'),
    full === null ? null : buildFreeformQuery(full, 'freeform'),
    structuredWithoutUnitNoCity,
    structuredFullNoCity,
    hasCity && withoutUnitAndCity !== null
      ? buildFreeformQuery(withoutUnitAndCity, 'freeform_without_unit_no_city')
      : null,
    hasCity && fullWithoutCity !== null
      ? buildFreeformQuery(fullWithoutCity, 'freeform_no_city')
      : null,
    structuredWithoutUnitNoPostal,
    structuredFullNoPostal,
    hasPostalCode && withoutUnitAndPostal !== null
      ? buildFreeformQuery(withoutUnitAndPostal, 'freeform_without_unit_no_postal')
      : null,
    hasPostalCode && fullWithoutPostal !== null
      ? buildFreeformQuery(fullWithoutPostal, 'freeform_no_postal')
      : null,
    structuredWithoutUnitNoCityNoPostal,
    structuredFullNoCityNoPostal,
    shouldTryNoCityNoPostal && withoutUnitCityAndPostal !== null
      ? buildFreeformQuery(withoutUnitCityAndPostal, 'freeform_without_unit_no_city_no_postal')
      : null,
    shouldTryNoCityNoPostal && fullWithoutCityAndPostal !== null
      ? buildFreeformQuery(fullWithoutCityAndPostal, 'freeform_no_city_no_postal')
      : null,
  ]);
}

function buildStructuredQuery(
  address: GeocodingAddress,
  shape: Extract<
    GeocodingQueryShape,
    | 'structured'
    | 'structured_no_city'
    | 'structured_no_city_no_postal'
    | 'structured_no_postal'
    | 'structured_postal_only'
    | 'structured_without_unit'
    | 'structured_without_unit_no_city'
    | 'structured_without_unit_no_city_no_postal'
    | 'structured_without_unit_no_postal'
  >,
): GeocodingQuery | null {
  const street = normalizeAddressParts([
    address.address1,
    keepsUnitInStructuredShape(shape) ? address.address2 : null
  ]);
  const city = clean(address.city);
  const state = clean(address.province);
  const postalcode = cleanPostalCode(address.postalCode);
  const country = countryName(address.countryCode);
  const countrycodes = countryCodeFilter(address.countryCode);
  if (street === null && city === null && state === null && postalcode === null && country === null) return null;
  if (street === null && postalcode === null) return null;
  const params = {
    ...(street === null ? {} : { street }),
    ...(city === null ? {} : { city }),
    ...(state === null ? {} : { state }),
    ...(postalcode === null ? {} : { postalcode }),
    ...(country === null ? {} : { country }),
    ...(countrycodes === null ? {} : { countrycodes }),
  };
  return {
    cacheKey: `structured:${Object.entries(params)
      .map(([key, value]) => `${key}=${String(value).toLowerCase()}`)
      .join('&')}`,
    kind: 'structured',
    params,
    shape,
  };
}

function buildFreeformQuery(
  q: string,
  shape: Extract<
    GeocodingQueryShape,
    | 'freeform'
    | 'freeform_no_city'
    | 'freeform_no_city_no_postal'
    | 'freeform_no_postal'
    | 'freeform_postal_only'
    | 'freeform_without_unit'
    | 'freeform_without_unit_no_city'
    | 'freeform_without_unit_no_city_no_postal'
    | 'freeform_without_unit_no_postal'
  >,
): GeocodingQuery {
  return {
    cacheKey: `freeform:${q.toLowerCase()}`,
    kind: 'freeform',
    q,
    shape,
  };
}

function keepsUnitInStructuredShape(shape: GeocodingQuery['shape']): boolean {
  return (
    shape === 'structured' ||
    shape === 'structured_no_city' ||
    shape === 'structured_no_city_no_postal' ||
    shape === 'structured_no_postal'
  );
}

function addressParts(address: GeocodingAddress): Array<string | null> {
  return [cleanPostalCode(address.postalCode), address.address1, address.address2, address.city, address.province, address.countryCode];
}

function normalizeAddressParts(parts: Array<string | null>): string | null {
  const normalized = parts
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter((part) => part !== '');
  if (normalized.length === 0) return null;
  return [...new Set(normalized)].join(', ');
}

function uniqueGeocodingQueries(queries: Array<GeocodingQuery | null>): GeocodingQuery[] {
  const unique = new Map<string, GeocodingQuery>();
  for (const query of queries) {
    if (query === null) continue;
    unique.set(query.cacheKey, query);
  }
  return [...unique.values()];
}

function clean(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function cleanPostalCode(value: string | null): string | null {
  const trimmed = clean(value);
  if (trimmed === null) return null;
  const compact = trimmed.replace(/\s+/gu, '').toUpperCase();
  return /^[A-Z][0-9][A-Z][0-9][A-Z][0-9]$/u.test(compact)
    ? `${compact.slice(0, 3)} ${compact.slice(3)}`
    : trimmed;
}

function countryName(value: string | null): string | null {
  const countryCode = clean(value)?.toUpperCase() ?? null;
  if (countryCode === null) return null;
  if (countryCode === 'CA' || countryCode === 'CAN') return 'Canada';
  if (countryCode === 'US' || countryCode === 'USA') return 'United States';
  return countryCode;
}

function countryCodeFilter(value: string | null): string | null {
  const countryCode = clean(value)?.toLowerCase() ?? null;
  if (countryCode === null) return null;
  if (countryCode === 'ca' || countryCode === 'can') return 'ca';
  if (countryCode === 'us' || countryCode === 'usa') return 'us';
  return /^[a-z]{2}$/u.test(countryCode) ? countryCode : null;
}

function buildFailureFromProviderError(error: GeocodingProviderError, state: ProviderCallState): GeocodingResult {
  const code = geocodingFailureCodeForProviderError(error);
  return {
    attemptCount: state.attemptCount,
    code,
    message: geocodingFailureMessage(code),
    ok: false,
    queryShapes: [...new Set(state.queryShapes)],
    transient: error.transient,
  };
}

function normalizeProviderError(error: unknown): GeocodingProviderError {
  if (error instanceof GeocodingProviderError) return error;
  return new GeocodingProviderError('NETWORK_ERROR', 'Geocoding provider failed.', { transient: true });
}

function geocodingFailureCodeForProviderError(error: GeocodingProviderError): GeocodingFailureCode {
  if (error.kind === 'RATE_LIMITED') return 'GEOCODER_PROVIDER_RATE_LIMITED';
  if (error.kind === 'TIMEOUT') return 'GEOCODER_PROVIDER_TIMEOUT';
  if (error.kind === 'HTTP_ERROR') return 'GEOCODER_PROVIDER_HTTP_ERROR';
  if (error.kind === 'INVALID_RESPONSE') return 'GEOCODER_INVALID_RESULT';
  return 'GEOCODER_PROVIDER_ERROR';
}

function geocodingFailureMessage(code: GeocodingFailureCode): string {
  switch (code) {
    case 'GEOCODER_PROVIDER_RATE_LIMITED':
      return 'Geocoding provider rate limit was reached. Try again later or use a private provider.';
    case 'GEOCODER_PROVIDER_TIMEOUT':
      return 'Geocoding provider timed out.';
    case 'GEOCODER_PROVIDER_HTTP_ERROR':
      return 'Geocoding provider returned an HTTP error.';
    case 'GEOCODER_INVALID_RESULT':
      return 'Geocoding provider returned invalid coordinates.';
    case 'GEOCODER_PROVIDER_ERROR':
      return 'Geocoding provider failed.';
    case 'BLANK_ADDRESS':
      return 'Address is blank.';
    case 'GEOCODER_DISABLED':
      return 'Geocoding is disabled for this runtime.';
    case 'GEOCODER_NOT_CONFIGURED':
      return 'Geocoding provider is not configured.';
    case 'GEOCODER_NO_RESULT':
      return 'No geocoding result was found.';
  }
}

export function isValidCoordinate(value: number, kind: 'latitude' | 'longitude'): boolean {
  const min = kind === 'latitude' ? -90 : -180;
  const max = kind === 'latitude' ? 90 : 180;
  return Number.isFinite(value) && value >= min && value <= max;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
