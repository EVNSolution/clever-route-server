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
  | 'GEOCODER_PROVIDER_ERROR'
  | 'GEOCODER_NO_RESULT'
  | 'GEOCODER_INVALID_RESULT';

export type GeocodingResult =
  | { ok: true; cached: boolean; result: GeocodingLookupResult }
  | { ok: false; code: GeocodingFailureCode; message: string };

export type GeocodingProvider = {
  geocodeAddress(query: string): Promise<GeocodingLookupResult | null>;
  readonly providerName: string;
};
