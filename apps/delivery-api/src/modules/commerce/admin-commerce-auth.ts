import { timingSafeEqual } from 'node:crypto';

export type AdminCommerceActor = {
  allowedShopDomains: '*' | readonly string[];
  subject: string;
};

export type AdminCommerceTokenVerifier = {
  verify(token: string): AdminCommerceActor;
};

export class StaticAdminCommerceTokenVerifier implements AdminCommerceTokenVerifier {
  private readonly tokenBuffer: Buffer;
  private readonly actor: AdminCommerceActor;

  constructor(options: { actorSubject?: string; allowedShopDomains?: readonly string[] | '*'; token: string }) {
    const token = options.token.trim();
    if (token === '') {
      throw new Error('CLEVER admin API token is required');
    }
    this.tokenBuffer = Buffer.from(token, 'utf8');
    this.actor = {
      allowedShopDomains: options.allowedShopDomains ?? [],
      subject: normalizeActorSubject(options.actorSubject)
    };
  }

  verify(token: string): AdminCommerceActor {
    const candidate = Buffer.from(token.trim(), 'utf8');
    if (candidate.byteLength !== this.tokenBuffer.byteLength || !timingSafeEqual(candidate, this.tokenBuffer)) {
      throw new Error('Invalid CLEVER admin bearer token');
    }
    return this.actor;
  }
}

export function parseAllowedShopDomains(value: string | undefined): readonly string[] | '*' {
  const rawValue = value?.trim();
  if (rawValue === undefined || rawValue === '') {
    return [];
  }
  if (rawValue === '*') {
    return '*';
  }

  const domains = rawValue
    .split(',')
    .map((domain) => normalizeShopDomainForAuth(domain))
    .filter((domain) => domain !== '');

  if (domains.length === 0) return [];
  return [...new Set(domains)];
}

export function canAccessShopDomain(actor: AdminCommerceActor, shopDomain: string): boolean {
  if (actor.allowedShopDomains === '*') return true;
  const normalized = normalizeShopDomainForAuth(shopDomain);
  return actor.allowedShopDomains.includes(normalized);
}

export function describeAllowedShopDomains(actor: AdminCommerceActor): string {
  return actor.allowedShopDomains === '*' ? '*' : actor.allowedShopDomains.join(',');
}

function normalizeActorSubject(value: string | undefined): string {
  const subject = value?.trim();
  return subject === undefined || subject === '' ? 'internal-operator' : subject;
}

function normalizeShopDomainForAuth(value: string): string {
  return value.trim().toLowerCase().replace(/^https?:\/\//iu, '').replace(/\/.*$/u, '');
}
