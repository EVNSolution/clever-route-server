import {
  findDriverAppAddressGaps,
  type DriverAppAddressPart
} from './driver-app-address-contract.js';

export type PrivateDriverDemoStopTemplate = {
  address: string;
  amount: string;
  gateway: string;
  label: string;
  latitude: number;
  longitude: number;
  postalCode: string;
};

export type PrivateDriverDemoRouteTemplate = {
  proof: boolean;
  stops: readonly PrivateDriverDemoStopTemplate[];
};

// Every demo stop is a Toronto address with a postal code: the driver app drops a route whose stop has none.
export const PRIVATE_DRIVER_DEMO_CITY = 'Toronto';
export const PRIVATE_DRIVER_DEMO_PROVINCE = 'Ontario';
export const PRIVATE_DRIVER_DEMO_COUNTRY_CODE = 'CA';

export const PRIVATE_DRIVER_DEMO_TEMPLATES = {
  cash: {
    proof: false,
    stops: [
      { label: 'Nathan Phillips Square', address: '100 Queen Street West', postalCode: 'M5H 2N2', latitude: 43.6525, longitude: -79.3839, amount: '122.25', gateway: 'Cash' },
      { label: 'Osgoode Hall grounds', address: '130 Queen Street West', postalCode: 'M5H 2N6', latitude: 43.6515, longitude: -79.3855, amount: '40.00', gateway: 'Interac e-Transfer' },
      { label: 'Campbell House grounds', address: '160 Queen Street West', postalCode: 'M5H 3H3', latitude: 43.6508, longitude: -79.3873, amount: '20.00', gateway: 'Cash' }
    ]
  },
  proof: {
    proof: true,
    stops: [
      { label: 'Toronto City Hall grounds', address: '100 Queen Street West', postalCode: 'M5H 2N2', latitude: 43.6534, longitude: -79.3841, amount: '10.00', gateway: 'Prepaid' },
      { label: 'Trinity Square', address: '10 Trinity Square', postalCode: 'M5G 1B1', latitude: 43.6542, longitude: -79.3816, amount: '15.00', gateway: 'Prepaid' }
    ]
  },
  simple: {
    proof: false,
    stops: [
      { label: 'Yonge-Dundas Square', address: '1 Dundas Street East', postalCode: 'M5B 2H1', latitude: 43.6561, longitude: -79.3802, amount: '18.00', gateway: 'Cash' },
      { label: 'Massey Hall grounds', address: '178 Victoria Street', postalCode: 'M5B 1T7', latitude: 43.6543, longitude: -79.3787, amount: '12.50', gateway: 'Interac e-Transfer' }
    ]
  }
} as const satisfies Record<string, PrivateDriverDemoRouteTemplate>;

export type PrivateDriverDemoTemplateName = keyof typeof PRIVATE_DRIVER_DEMO_TEMPLATES;

export function isPrivateDriverDemoTemplateName(value: string): value is PrivateDriverDemoTemplateName {
  return Object.hasOwn(PRIVATE_DRIVER_DEMO_TEMPLATES, value);
}

/** Lists `stopN.part` for every template stop whose address would make the driver app drop the route. */
export function findTemplateAddressGaps(template: PrivateDriverDemoRouteTemplate): string[] {
  return template.stops.flatMap((stop, index) => findDriverAppAddressGaps({
    address1: stop.address,
    city: PRIVATE_DRIVER_DEMO_CITY,
    countryCode: PRIVATE_DRIVER_DEMO_COUNTRY_CODE,
    postalCode: stop.postalCode,
    province: PRIVATE_DRIVER_DEMO_PROVINCE
  }).map((part: DriverAppAddressPart) => `stop${index + 1}.${part}`));
}
