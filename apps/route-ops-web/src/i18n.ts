export type AppLocale = 'en-CA' | 'ko-KR';

export function resolveLocale(value: string | null | undefined): AppLocale {
  return value === 'ko-KR' ? 'ko-KR' : 'en-CA';
}

export const settingsCopy = {
  'en-CA': {
    settingsEyebrow: 'Settings',
    settingsTitle: 'Store settings',
    storeAddress: 'Store address',
    latitude: 'Latitude',
    longitude: 'Longitude',
    language: 'Language',
    english: 'English',
    korean: '한국어',
    saveSettings: 'Save settings',
    saving: 'Saving…',
    geocodeAndSave: 'Geocode & save coordinates',
    geocoding: 'Geocoding…',
    blankAddress: 'Enter a store address before geocoding.',
    saved: 'Settings saved.',
    remembered: 'Saved coordinates were reused from store settings.',
    geocodeSaved(latitude: number, longitude: number): string {
      return `Coordinates saved: ${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
    },
    depotMapTitle: 'Depot map',
    depotMapSubtitle: 'Click the configured map to update the depot draft; manual fields remain authoritative.',
    providersEyebrow: 'Providers',
    providersTitle: 'Map/router status',
    mapProvider: 'Map provider',
    providerMode: 'Provider mode',
    routeGeometryProvider: 'Route geometry provider',
    noProviderSecrets: 'No provider secrets are displayed in the browser. Unconfigured mode never calls public tile/router hosts.',
    none: 'none',
    depot: 'Depot',
    defaultDepot: 'Default depot'
  },
  'ko-KR': {
    settingsEyebrow: '설정',
    settingsTitle: '매장 설정',
    storeAddress: '매장 주소',
    latitude: '위도',
    longitude: '경도',
    language: '언어',
    english: 'English',
    korean: '한국어',
    saveSettings: '설정 저장',
    saving: '저장 중…',
    geocodeAndSave: '주소로 좌표 저장',
    geocoding: '좌표 변환 중…',
    blankAddress: '좌표 변환 전에 매장 주소를 입력하세요.',
    saved: '설정을 저장했습니다.',
    remembered: '매장 설정에 저장된 좌표를 다시 사용했습니다.',
    geocodeSaved(latitude: number, longitude: number): string {
      return `좌표 저장 완료: ${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
    },
    depotMapTitle: '출발지 지도',
    depotMapSubtitle: '지도를 클릭하면 출발지 초안 좌표가 바뀝니다. 직접 입력한 필드가 최종 기준입니다.',
    providersEyebrow: '제공자',
    providersTitle: '지도/경로 상태',
    mapProvider: '지도 제공자',
    providerMode: '제공자 모드',
    routeGeometryProvider: '경로 제공자',
    noProviderSecrets: '브라우저에는 제공자 비밀값을 표시하지 않습니다. 미설정 모드에서는 공개 지도/경로 호스트를 호출하지 않습니다.',
    none: '없음',
    depot: '출발지',
    defaultDepot: '기본 출발지'
  }
} as const;

export const orderDetailLabels = {
  blockerReasons: {
    ambiguous_delivery_day: 'Delivery day unclear',
    ambiguous_delivery_time_window: 'Delivery time unclear',
    delivery_date_weekday_mismatch: 'Delivery day unclear',
    delivery_date_weekday_unverified: 'Delivery day unclear',
    delivery_day_unparsed: 'Delivery day unclear',
    delivery_time_window_unparsed: 'Delivery time unclear',
    missing_coordinates: 'Need coordinates',
    missing_delivery_area: 'Missing delivery area',
    missing_delivery_date: 'Missing delivery date',
    missing_route_scope: 'Missing route scope',
    missing_time_window: 'Missing time window',
  },
  diagnosticPaths: {
    'line_items[0].name': 'Ordered items',
    'meta_data._tomatono_delivery_day': 'Delivery day',
    'meta_data._tomatono_fulfillment_type': 'Fulfillment type',
    'meta_data._tomatono_order_type': 'Order type',
    'shipping_lines[0].method_title': 'Shipping method',
  },
  geocodeStatus: {
    FAILED: 'Geocode failed',
    NOT_REQUIRED: 'Coordinates not required',
    PENDING: 'Awaiting geocode',
    RESOLVED: 'Coordinates available',
  },
} as const;

export const orderBlockerLabels = orderDetailLabels.blockerReasons;

export const orderFieldLabels = {
  ...orderDetailLabels.diagnosticPaths,
  address1: 'Street address',
  address2: 'Address line 2',
  city: 'City',
  countryCode: 'Country',
  deliveryArea: 'Delivery area',
  deliveryDate: 'Delivery date',
  deliverySession: 'Delivery session',
  postalCode: 'Postal code',
  province: 'Province/region',
  serviceType: 'Service type',
  timeWindowEnd: 'Time window end',
  timeWindowStart: 'Time window start',
} as const;
