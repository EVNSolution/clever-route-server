export const dsvScopes = [
  'dsv:session:read',
  'dsv:customers:read',
  'dsv:customers:write',
  'dsv:destinations:read',
  'dsv:destinations:write',
  'dsv:resources:read',
  'dsv:resources:write',
  'dsv:conditions:read',
  'dsv:conditions:write',
  'dsv:imports:read',
  'dsv:imports:write',
  'dsv:imports:apply',
  'dsv:dispatches:read',
  'dsv:dispatches:write',
  'dsv:control:read',
  'dsv:records:read',
  'dsv:settings:read',
  'dsv:settings:write',
  'dsv:customer-deliveries:read',
  'driver:assignments:read',
  'driver:assignments:release',
  'driver:assignments:acquire',
  'driver:events:write',
  'driver:proofs:write',
  'device:telemetry:write',
] as const;

export type DsvScope = typeof dsvScopes[number];
export type DsvPrincipalType = 'DSV_ADMIN' | 'CUSTOMER_USER' | 'DRIVER' | 'IMPORT_WORKER' | 'DEVICE';

type DsvPrincipalBase = {
  principalType: DsvPrincipalType;
  scopes: readonly DsvScope[];
  shopId: string;
};

export type DsvAdminPrincipal = DsvPrincipalBase & {
  actorId?: string;
  displayName?: string;
  principalType: 'DSV_ADMIN';
  shopDomain?: string;
};

export type DsvCustomerUserPrincipal = DsvPrincipalBase & {
  customerId: string;
  principalType: 'CUSTOMER_USER';
  shopDomain?: string;
};

export type DsvDriverPrincipal = DsvPrincipalBase & {
  driverId: string;
  principalType: 'DRIVER';
};

export type DsvImportWorkerPrincipal = DsvPrincipalBase & {
  principalType: 'IMPORT_WORKER';
};

export type DsvDevicePrincipal = DsvPrincipalBase & {
  principalType: 'DEVICE';
};

export type DsvPrincipal =
  | DsvAdminPrincipal
  | DsvCustomerUserPrincipal
  | DsvDriverPrincipal
  | DsvImportWorkerPrincipal
  | DsvDevicePrincipal;

export const dsvAdminScopes = [
  'dsv:session:read',
  'dsv:customers:read',
  'dsv:customers:write',
  'dsv:destinations:read',
  'dsv:destinations:write',
  'dsv:resources:read',
  'dsv:resources:write',
  'dsv:conditions:read',
  'dsv:conditions:write',
  'dsv:imports:read',
  'dsv:imports:write',
  'dsv:imports:apply',
  'dsv:dispatches:read',
  'dsv:dispatches:write',
  'dsv:control:read',
  'dsv:records:read',
  'dsv:settings:read',
  'dsv:settings:write',
] as const satisfies readonly DsvScope[];

export class DsvForbiddenError extends Error {
  readonly code = 'DSV_FORBIDDEN';
  readonly details: {
    principalType: DsvPrincipalType;
    requiredScopes: readonly DsvScope[];
    shopId: string;
  };
  readonly httpStatus = 403;

  constructor(input: { principal: DsvPrincipal; requiredScopes: readonly DsvScope[] }) {
    super('DSV principal does not have the required scope.');
    this.name = 'DsvForbiddenError';
    this.details = {
      principalType: input.principal.principalType,
      requiredScopes: input.requiredScopes,
      shopId: input.principal.shopId,
    };
  }
}

export function createDsvAdminPrincipal(input: {
  actorId?: string;
  displayName?: string;
  scopes?: readonly DsvScope[];
  shopDomain?: string;
  shopId: string;
}): DsvAdminPrincipal {
  return {
    actorId: input.actorId ?? 'legacy-env-admin',
    ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
    principalType: 'DSV_ADMIN',
    scopes: input.scopes ?? dsvAdminScopes,
    ...(input.shopDomain === undefined ? {} : { shopDomain: input.shopDomain }),
    shopId: input.shopId,
  };
}

export function normalizeDsvScopes(values: readonly string[]): DsvScope[] | null {
  const knownScopes = new Set<string>(dsvScopes);
  if (values.some((scope) => !knownScopes.has(scope))) return null;
  return [...new Set(values)] as DsvScope[];
}

export function createDsvCustomerUserPrincipalFromAccount(input: {
  account: { customerId: string; shopId: string; status: string };
  shopDomain?: string;
}): DsvCustomerUserPrincipal {
  if (input.account.status !== 'ACTIVE') {
    const principal: DsvPrincipal = {
      customerId: input.account.customerId,
      principalType: 'CUSTOMER_USER',
      scopes: [],
      shopId: input.account.shopId,
    };
    throw new DsvForbiddenError({ principal, requiredScopes: ['dsv:customer-deliveries:read'] });
  }
  return {
    customerId: input.account.customerId,
    principalType: 'CUSTOMER_USER',
    scopes: ['dsv:session:read', 'dsv:customer-deliveries:read'],
    ...(input.shopDomain === undefined ? {} : { shopDomain: input.shopDomain }),
    shopId: input.account.shopId,
  };
}

export function requireDsvScopes(principal: DsvPrincipal, requiredScopes: readonly DsvScope[]): void {
  if (requiredScopes.length === 0) return;
  const granted = new Set(principal.scopes);
  if (requiredScopes.every((scope) => granted.has(scope))) return;
  throw new DsvForbiddenError({ principal, requiredScopes });
}

export function requireCustomerDeliveryPrincipal(input: {
  customerId?: string;
  destinationId?: string;
  principal: DsvPrincipal;
}): DsvCustomerUserPrincipal {
  requireDsvScopes(input.principal, ['dsv:customer-deliveries:read']);
  if (input.principal.principalType !== 'CUSTOMER_USER' || input.principal.customerId === '') {
    throw new DsvForbiddenError({
      principal: input.principal,
      requiredScopes: ['dsv:customer-deliveries:read'],
    });
  }
  if (input.customerId !== undefined && input.customerId !== input.principal.customerId) {
    throw new DsvForbiddenError({
      principal: input.principal,
      requiredScopes: ['dsv:customer-deliveries:read'],
    });
  }
  return input.principal;
}
