export type GeocodingProviderMode = 'disabled' | 'nominatim_compatible';

export type GeocodingAddress = {
  address1: string | null;
  address2: string | null;
  city: string | null;
  countryCode: string | null;
  postalCode: string | null;
  province: string | null;
};

export type GeocodingLookupInput = {
  address: GeocodingAddress;
  shopDomain: string;
};

export type GeocodingQueryShape =
  | 'freeform'
  | 'freeform_no_city'
  | 'freeform_no_city_no_postal'
  | 'freeform_no_postal'
  | 'freeform_postal_only'
  | 'freeform_without_unit'
  | 'freeform_without_unit_no_city'
  | 'freeform_without_unit_no_city_no_postal'
  | 'freeform_without_unit_no_postal'
  | 'structured'
  | 'structured_no_city'
  | 'structured_no_city_no_postal'
  | 'structured_no_postal'
  | 'structured_postal_only'
  | 'structured_without_unit_no_city'
  | 'structured_without_unit_no_city_no_postal'
  | 'structured_without_unit_no_postal'
  | 'structured_without_unit';

export type StructuredGeocodingQuery = {
  cacheKey: string;
  kind: 'structured';
  params: {
    city?: string;
    country?: string;
    countrycodes?: string;
    postalcode?: string;
    state?: string;
    street?: string;
  };
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
  >;
};

export type FreeformGeocodingQuery = {
  cacheKey: string;
  kind: 'freeform';
  q: string;
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
  >;
};

export type GeocodingQuery = StructuredGeocodingQuery | FreeformGeocodingQuery;

export type GeocodingLookupResult = {
  addressLabel: string;
  latitude: number;
  longitude: number;
  provider: string;
  providerPlaceId: string | null;
  rawLabel: string | null;
};

export type GeocodingFailureCode =
  | 'BLANK_ADDRESS'
  | 'GEOCODER_DISABLED'
  | 'GEOCODER_NOT_CONFIGURED'
  | 'GEOCODER_PROVIDER_RATE_LIMITED'
  | 'GEOCODER_PROVIDER_TIMEOUT'
  | 'GEOCODER_PROVIDER_HTTP_ERROR'
  | 'GEOCODER_PROVIDER_ERROR'
  | 'GEOCODER_NO_RESULT'
  | 'GEOCODER_INVALID_RESULT';

export type GeocodingResult =
  | {
      attemptCount?: number;
      cached: boolean;
      ok: true;
      queryShapes?: GeocodingQueryShape[];
      result: GeocodingLookupResult;
    }
  | {
      attemptCount?: number;
      code: GeocodingFailureCode;
      message: string;
      ok: false;
      queryShapes?: GeocodingQueryShape[];
      transient?: boolean;
    };

export type GeocodingProvider = {
  geocodeAddress(query: GeocodingQuery): Promise<GeocodingLookupResult | null>;
  readonly providerName: string;
};

export type GeocodingProviderErrorKind =
  | 'HTTP_ERROR'
  | 'INVALID_RESPONSE'
  | 'NETWORK_ERROR'
  | 'RATE_LIMITED'
  | 'TIMEOUT';

export class GeocodingProviderError extends Error {
  readonly kind: GeocodingProviderErrorKind;
  readonly status: number | null;
  readonly transient: boolean;

  constructor(
    kind: GeocodingProviderErrorKind,
    message: string,
    options: { status?: number | null; transient?: boolean } = {},
  ) {
    super(message);
    this.name = 'GeocodingProviderError';
    this.kind = kind;
    this.status = options.status ?? null;
    this.transient =
      options.transient ??
      (kind === 'NETWORK_ERROR' ||
        kind === 'RATE_LIMITED' ||
        kind === 'TIMEOUT' ||
        (kind === 'HTTP_ERROR' &&
          typeof options.status === 'number' &&
          options.status >= 500));
  }
}
