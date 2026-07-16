export type DriverConsentType = 'LOCATION_INFORMATION' | 'PERSONAL_INFORMATION';

export type DriverConsentRecordInput = {
  accepted: true;
  type: DriverConsentType;
  version: string;
};

export type RecordDriverConsentsInput = {
  accountId: string;
  appContext: Record<string, unknown> | null;
  consents: DriverConsentRecordInput[];
  deviceContext: Record<string, unknown> | null;
  recordedAt: Date;
  routePlanId: string;
};

export type RecordDriverConsentsResult = {
  status: 'CONSENT_RECORDED';
  recordedAt: string;
  records: Array<{
    accepted: boolean;
    type: DriverConsentType;
    version: string;
  }>;
};

export type DriverConsentServiceContract = {
  recordDriverConsents(input: RecordDriverConsentsInput): Promise<RecordDriverConsentsResult>;
};
