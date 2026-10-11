// The driver app (1.3.x) accepts an assigned route only when every stop address has these five parts as strings.
// It drops the whole route without a message otherwise, so synthetic and imported stops must satisfy this.
export const DRIVER_APP_REQUIRED_ADDRESS_PARTS = ['address1', 'city', 'province', 'postalCode', 'countryCode'] as const;

export type DriverAppAddressPart = (typeof DRIVER_APP_REQUIRED_ADDRESS_PARTS)[number];

export function findDriverAppAddressGaps(
  address: Partial<Record<DriverAppAddressPart, string | null | undefined>>
): DriverAppAddressPart[] {
  return DRIVER_APP_REQUIRED_ADDRESS_PARTS.filter((part) => {
    const value = address[part];
    return typeof value !== 'string' || value.trim() === '';
  });
}
