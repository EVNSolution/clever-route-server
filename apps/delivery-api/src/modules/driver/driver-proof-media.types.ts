export type DriverProofMediaSource = 'camera' | 'library';

export type StoreDriverProofMediaInput = {
  contentType: string;
  deliveryStopId: string;
  driverId: string;
  fileBytes: Buffer;
  filename: string;
  idempotencyKey?: string;
  routePlanId: string;
  shopDomain: string;
  shopId: string;
  source: DriverProofMediaSource;
};

export type StoreDriverProofMediaResult = {
  contentType: string;
  kind: 'photo';
  mediaId: string;
  sha256: string;
  sizeBytes: number;
  source: DriverProofMediaSource;
  storageKey: string;
  uploadedAt: string;
};

export type CreateDriverProofMediaReadAccessInput = {
  driverId: string;
  mediaId: string;
  routePlanId: string;
  shopDomain: string;
  shopId: string;
};

export type CreateDriverProofMediaReadAccessResult = {
  contentType: string;
  expiresAt: string;
  kind: 'photo';
  mediaId: string;
  url: string;
};

export type DriverProofMediaScanInput = {
  contentType: string;
  fileBytes: Buffer;
  sha256: string;
  storageKey: string;
};

export type DriverProofMediaScanResult =
  | { status: 'clean' }
  | { reason: string; status: 'rejected' };

export type DriverProofMediaScanner = {
  scanProofMedia(input: DriverProofMediaScanInput): Promise<DriverProofMediaScanResult>;
};

export type DriverProofMediaScanMonitorInput = {
  contentType: string;
  mediaId: string;
  reason?: string;
  scannedAt: Date;
  sha256: string;
  status: DriverProofMediaScanResult['status'];
  storageKey: string;
};

export type DriverProofMediaScanMonitor = {
  recordProofMediaScan(input: DriverProofMediaScanMonitorInput): Promise<void>;
};

export type DriverProofMediaServiceContract = {
  createProofMediaReadAccess(input: CreateDriverProofMediaReadAccessInput): Promise<CreateDriverProofMediaReadAccessResult>;
  storeProofMedia(input: StoreDriverProofMediaInput): Promise<StoreDriverProofMediaResult>;
};

export class DriverProofMediaScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DriverProofMediaScopeError';
  }
}

export class DriverProofMediaScanRejectedError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Proof media rejected by malware scan: ${reason}`);
    this.name = 'DriverProofMediaScanRejectedError';
    this.reason = reason;
  }
}

export class DriverProofMediaAccessUnavailableError extends Error {
  constructor(message = 'Proof media read access is not configured') {
    super(message);
    this.name = 'DriverProofMediaAccessUnavailableError';
  }
}

export class DriverProofMediaIdempotencyConflictError extends Error {
  constructor() {
    super('Proof media idempotency key was reused with different content');
    this.name = 'DriverProofMediaIdempotencyConflictError';
  }
}

export class DriverProofMediaIdempotencyPendingError extends Error {
  constructor() {
    super('Proof media idempotent upload is still pending');
    this.name = 'DriverProofMediaIdempotencyPendingError';
  }
}
