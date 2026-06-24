export type AdminDriverAuthStatus = 'APP_LINKED' | 'INVITE_PENDING';
export type AdminDriverStatus = 'ACTIVE' | 'INACTIVE' | 'PENDING' | 'SUSPENDED';

export type AdminDriverRow = {
  authStatus: AdminDriverAuthStatus;
  authSubject: 'present' | null;
  createdAt: string;
  displayName: string;
  id: string;
  inviteCode: string | null;
  inviteCodeExpiresAt: string | null;
  lastSeenAt: string | null;
  phone: string | null;
  recentEventsCount: number;
  status: AdminDriverStatus;
  updatedAt: string;
};

export type CreatePendingDriverInput = {
  createdBy: string;
  displayName: string | null;
  inviteLink: string | null;
  phone: string;
  appId?: string | undefined;
  shopDomain: string;
  source: 'clever-app-driver-invite';
};

export type CreatePendingDriverRecordInput = {
  displayName: string | null;
  phone: string;
  appId?: string | undefined;
  shopDomain: string;
};

export type ListAdminDriversInput = {
  appId?: string | undefined;
  shopDomain: string;
};

export type DeleteAdminDriverInput = {
  driverId: string;
  appId?: string | undefined;
  shopDomain: string;
};

export type RegenerateInviteCodeInput = {
  driverId: string;
  appId?: string | undefined;
  shopDomain: string;
};

export type AdminDriverServiceContract = {
  createPendingDriver(input: CreatePendingDriverInput): Promise<AdminDriverRow>;
  deleteDriver(input: DeleteAdminDriverInput): Promise<string>;
  listDrivers(input: ListAdminDriversInput): Promise<AdminDriverRow[]>;
  regenerateInviteCode(input: RegenerateInviteCodeInput): Promise<AdminDriverRow>;
};
