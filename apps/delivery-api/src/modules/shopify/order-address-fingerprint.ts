export type DeliveryStopAddressFields = {
  address1: string | null;
  address2: string | null;
  city: string | null;
  countryCode: string | null;
  postalCode: string | null;
  province: string | null;
};

export function addressFingerprint(input: DeliveryStopAddressFields): string | null {
  const payload = addressFingerprintPayload(input);
  return Object.values(payload).some((value) => value !== null)
    ? JSON.stringify(payload)
    : null;
}

export function addressFingerprintPayload(
  input: DeliveryStopAddressFields,
): Record<keyof DeliveryStopAddressFields, string | null> {
  return {
    address1: normalizeAddressFingerprintPart(input.address1),
    address2: normalizeAddressFingerprintPart(input.address2),
    city: normalizeAddressFingerprintPart(input.city),
    countryCode: normalizeAddressFingerprintPart(input.countryCode),
    postalCode: normalizeAddressFingerprintPart(input.postalCode),
    province: normalizeAddressFingerprintPart(input.province),
  };
}

function normalizeAddressFingerprintPart(value: string | null): string | null {
  const normalized = value?.trim().replace(/\s+/gu, ' ').toLowerCase() ?? '';
  return normalized === '' ? null : normalized;
}
