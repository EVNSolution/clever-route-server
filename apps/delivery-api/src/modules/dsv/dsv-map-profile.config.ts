export type DsvMapProviderMode = 'public_allowlisted' | 'self_hosted';

export type DsvMapProfile = {
  attribution: string;
  bounds: [west: number, south: number, east: number, north: number];
  initialView: {
    center: [lng: number, lat: number];
    zoom: number;
  };
  profileId: string;
  providerMode: DsvMapProviderMode;
  regionCode: string;
  styleUrl: string;
  version: string;
};

export type DsvMapProfileEnv = Partial<Record<
  | 'DSV_MAP_ALLOWED_HOSTS'
  | 'DSV_MAP_ATTRIBUTION'
  | 'DSV_MAP_BOUNDS'
  | 'DSV_MAP_INITIAL_CENTER'
  | 'DSV_MAP_INITIAL_ZOOM'
  | 'DSV_MAP_PROFILE_ID'
  | 'DSV_MAP_PROVIDER_MODE'
  | 'DSV_MAP_REGION_CODE'
  | 'DSV_MAP_STYLE_URL'
  | 'DSV_MAP_VERSION',
  string
>>;

export function loadDsvMapProfileFromEnv(env: DsvMapProfileEnv): DsvMapProfile | undefined {
  const profileId = readNonEmptyString(env.DSV_MAP_PROFILE_ID);
  const regionCode = readNonEmptyString(env.DSV_MAP_REGION_CODE);
  const providerMode = readProviderMode(env.DSV_MAP_PROVIDER_MODE);
  const styleUrl = readNonEmptyString(env.DSV_MAP_STYLE_URL);
  const attribution = readNonEmptyString(env.DSV_MAP_ATTRIBUTION);
  const version = readNonEmptyString(env.DSV_MAP_VERSION);
  const bounds = readBounds(env.DSV_MAP_BOUNDS);
  const center = readLngLat(env.DSV_MAP_INITIAL_CENTER);
  const zoom = readZoom(env.DSV_MAP_INITIAL_ZOOM);

  if (
    profileId === undefined ||
    regionCode === undefined ||
    providerMode === undefined ||
    styleUrl === undefined ||
    attribution === undefined ||
    version === undefined ||
    bounds === undefined ||
    center === undefined ||
    zoom === undefined ||
    !isStyleUrlAllowed({ allowedHosts: readAllowedHosts(env.DSV_MAP_ALLOWED_HOSTS), providerMode, styleUrl }) ||
    !isCenterInsideBounds(center, bounds)
  ) return undefined;

  return {
    attribution,
    bounds,
    initialView: { center, zoom },
    profileId,
    providerMode,
    regionCode,
    styleUrl,
    version,
  };
}

function readNonEmptyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

function readProviderMode(value: string | undefined): DsvMapProviderMode | undefined {
  const mode = readNonEmptyString(value);
  return mode === 'public_allowlisted' || mode === 'self_hosted' ? mode : undefined;
}

function readBounds(value: string | undefined): DsvMapProfile['bounds'] | undefined {
  const values = readNumberTuple4(value);
  if (values === undefined) return undefined;
  const [west, south, east, north] = values;
  if (!isLongitude(west) || !isLongitude(east) || !isLatitude(south) || !isLatitude(north)) return undefined;
  if (west >= east || south >= north) return undefined;
  return [west, south, east, north];
}

function readLngLat(value: string | undefined): [lng: number, lat: number] | undefined {
  const values = readNumberTuple2(value);
  if (values === undefined) return undefined;
  const [lng, lat] = values;
  return isLongitude(lng) && isLatitude(lat) ? [lng, lat] : undefined;
}

function readNumberTuple2(value: string | undefined): [number, number] | undefined {
  const values = readNumberTuple(value, 2);
  return values === undefined ? undefined : [values[0] as number, values[1] as number];
}

function readNumberTuple4(value: string | undefined): [number, number, number, number] | undefined {
  const values = readNumberTuple(value, 4);
  return values === undefined
    ? undefined
    : [values[0] as number, values[1] as number, values[2] as number, values[3] as number];
}

function readNumberTuple(value: string | undefined, length: number): readonly number[] | undefined {
  const raw = readNonEmptyString(value);
  if (raw === undefined) return undefined;
  const values = raw.split(',').map((part) => Number(part.trim()));
  return values.length === length && values.every(Number.isFinite) ? values : undefined;
}

function readZoom(value: string | undefined): number | undefined {
  const raw = readNonEmptyString(value);
  if (raw === undefined) return undefined;
  const zoom = Number(raw);
  return Number.isFinite(zoom) && zoom >= 0 && zoom <= 24 ? zoom : undefined;
}

function readAllowedHosts(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host !== '');
}

function isStyleUrlAllowed(input: {
  allowedHosts: readonly string[];
  providerMode: DsvMapProviderMode;
  styleUrl: string;
}): boolean {
  if (input.providerMode === 'self_hosted') {
    return input.styleUrl.startsWith('/') && !input.styleUrl.startsWith('//');
  }
  if (input.styleUrl.startsWith('/') && !input.styleUrl.startsWith('//')) {
    return input.allowedHosts.length > 0;
  }
  try {
    const url = new URL(input.styleUrl);
    return url.protocol === 'https:' && input.allowedHosts.includes(url.host.toLowerCase());
  } catch {
    return false;
  }
}

function isCenterInsideBounds(
  [lng, lat]: DsvMapProfile['initialView']['center'],
  [west, south, east, north]: DsvMapProfile['bounds'],
): boolean {
  return lng >= west && lng <= east && lat >= south && lat <= north;
}

function isLongitude(value: number): boolean {
  return Number.isFinite(value) && value >= -180 && value <= 180;
}

function isLatitude(value: number): boolean {
  return Number.isFinite(value) && value >= -90 && value <= 90;
}
