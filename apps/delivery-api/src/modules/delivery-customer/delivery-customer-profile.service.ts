import {
  Prisma,
  type DeliveryCustomerProfile,
  type DeliveryCustomerProfileOrderLink,
  type DeliveryStop,
  type Order,
  type PrismaClient,
} from "@prisma/client";

export type DeliveryCustomerMatchStatus = "AUTO_MATCHED" | "CREATED_NEW";

export type DeliveryCustomerContext = {
  customerNote: string | null;
  deliveryCustomer: {
    adminMemo: string | null;
    matchReasons: string[];
    matchStatus: DeliveryCustomerMatchStatus;
    profileId: string;
  } | null;
  orderId: string;
};

export type DeliveryCustomerAdminMemoResult = {
  deliveryCustomer: {
    adminMemo: string | null;
    profileId: string;
  };
};

export type DeliveryCustomerMergeResult = {
  deliveryCustomer: {
    adminMemo: string | null;
    profileId: string;
  };
  mergedProfileId: string;
};

type OrderWithStopAndLink = Order & {
  deliveryCustomerProfileLinks: Array<
    DeliveryCustomerProfileOrderLink & { profile: DeliveryCustomerProfile }
  >;
  deliveryStops: DeliveryStop[];
};

type CustomerSource = {
  address: NormalizedAddress;
  addressFingerprint: string;
  email: string | null;
  isolated: boolean;
  name: string | null;
  nameKey: string | null;
  phone: string | null;
};

type NormalizedAddress = {
  address1: string | null;
  address2: string | null;
  city: string | null;
  countryCode: string | null;
  postalCode: string | null;
  province: string | null;
};

type CandidateDecision = {
  matchReasons: string[];
  matchScore: number;
  profile: DeliveryCustomerProfile;
} | null;

export class PrismaDeliveryCustomerProfileService {
  constructor(private readonly prisma: PrismaClient) {}

  async getOrderCustomerNoteContext(input: {
    orderId: string;
    shopDomain: string;
  }): Promise<DeliveryCustomerContext | null> {
    const shop = await this.prisma.shop.findUnique({
      select: { id: true },
      where: { shopDomain: input.shopDomain },
    });
    if (shop === null) return null;

    try {
      return await this.materializeOrderCustomerNoteContext(input.orderId, shop.id);
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) throw error;
      return this.readLinkedOrderCustomerNoteContext(input.orderId, shop.id, error);
    }
  }

  async updateAdminMemo(input: {
    adminMemo: string | null;
    profileId: string;
    shopDomain: string;
  }): Promise<DeliveryCustomerAdminMemoResult | null> {
    const shop = await this.prisma.shop.findUnique({
      select: { id: true },
      where: { shopDomain: input.shopDomain },
    });
    if (shop === null) return null;

    return this.prisma.$transaction(async (tx) => {
      const profile = await tx.deliveryCustomerProfile.findFirst({
        where: { id: input.profileId, shopId: shop.id },
      });
      if (profile === null) return null;
      const target = await resolveMergedProfile(tx, profile, shop.id);
      if (target === null) return null;
      const updated = await tx.deliveryCustomerProfile.update({
        data: { adminMemo: normalizeAdminMemo(input.adminMemo) },
        where: { id: target.id },
      });
      return {
        deliveryCustomer: {
          adminMemo: updated.adminMemo,
          profileId: updated.id,
        },
      };
    });
  }

  async mergeProfiles(input: {
    sourceProfileId: string;
    targetProfileId: string;
    shopDomain: string;
  }): Promise<DeliveryCustomerMergeResult | null> {
    if (input.sourceProfileId === input.targetProfileId) return null;
    const shop = await this.prisma.shop.findUnique({
      select: { id: true },
      where: { shopDomain: input.shopDomain },
    });
    if (shop === null) return null;

    return this.prisma.$transaction(async (tx) => {
      const [source, target] = await Promise.all([
        tx.deliveryCustomerProfile.findFirst({
          where: { id: input.sourceProfileId, shopId: shop.id },
        }),
        tx.deliveryCustomerProfile.findFirst({
          where: { id: input.targetProfileId, shopId: shop.id },
        }),
      ]);
      if (source === null || target === null) return null;
      const resolvedTarget = await resolveMergedProfile(tx, target, shop.id);
      if (resolvedTarget === null || source.id === resolvedTarget.id) return null;
      await tx.deliveryCustomerProfile.update({
        data: { mergedIntoProfileId: resolvedTarget.id },
        where: { id: source.id },
      });
      return {
        deliveryCustomer: {
          adminMemo: resolvedTarget.adminMemo,
          profileId: resolvedTarget.id,
        },
        mergedProfileId: source.id,
      };
    });
  }

  private async materializeOrderCustomerNoteContext(
    orderId: string,
    shopId: string,
  ): Promise<DeliveryCustomerContext | null> {
    return this.prisma.$transaction(async (tx) => {
      const order = await findOrderWithCustomerProfileContext(tx, orderId, shopId);
      if (order === null) return null;

      const existingLink = order.deliveryCustomerProfileLinks[0] ?? null;
      if (existingLink !== null) {
        const profile = await resolveMergedProfile(tx, existingLink.profile, shopId);
        if (profile === null) return toContextWithoutDeliveryCustomer(order);
        return toContext({
          matchReasons: readStringArray(existingLink.matchReasons),
          matchStatus: readMatchStatus(existingLink.matchStatus),
          order,
          profile,
        });
      }

      const source = readCustomerSource(order);
      const candidates = await tx.deliveryCustomerProfile.findMany({
        orderBy: { createdAt: "asc" },
        where: {
          addressFingerprint: source.addressFingerprint,
          mergedIntoProfileId: null,
          shopId,
        },
      });
      const decision = source.isolated
        ? null
        : chooseConservativeMatch(source, candidates);
      const matchStatus: DeliveryCustomerMatchStatus =
        decision === null ? "CREATED_NEW" : "AUTO_MATCHED";
      const matchReasons =
        decision?.matchReasons ??
        (source.isolated
          ? ["missing_address_order_scoped_profile"]
          : ["no_unambiguous_existing_profile"]);
      const matchScore = decision?.matchScore ?? 1;
      const profile =
        decision?.profile ??
        (await tx.deliveryCustomerProfile.create({
          data: {
            addressFingerprint: source.addressFingerprint,
            canonicalEmail: source.email,
            canonicalName: source.name,
            canonicalPhone: source.phone,
            normalizedAddress: source.address,
            normalizedNameKey: source.nameKey,
            shopId,
          },
        }));
      const link = await tx.deliveryCustomerProfileOrderLink.create({
        data: {
          matchReasons,
          matchScore: new Prisma.Decimal(matchScore),
          matchStatus,
          orderId: order.id,
          profileId: profile.id,
          shopId,
        },
      });

      return toContext({
        matchReasons: readStringArray(link.matchReasons),
        matchStatus,
        order,
        profile,
      });
    });
  }

  private async readLinkedOrderCustomerNoteContext(
    orderId: string,
    shopId: string,
    originalError: unknown,
  ): Promise<DeliveryCustomerContext | null> {
    return this.prisma.$transaction(async (tx) => {
      const order = await findOrderWithCustomerProfileContext(tx, orderId, shopId);
      const existingLink = order?.deliveryCustomerProfileLinks[0] ?? null;
      if (order === null || existingLink === null) throw originalError;
      const profile = await resolveMergedProfile(tx, existingLink.profile, shopId);
      if (profile === null) return toContextWithoutDeliveryCustomer(order);
      return toContext({
        matchReasons: readStringArray(existingLink.matchReasons),
        matchStatus: readMatchStatus(existingLink.matchStatus),
        order,
        profile,
      });
    });
  }
}

async function findOrderWithCustomerProfileContext(
  tx: Prisma.TransactionClient,
  orderId: string,
  shopId: string,
): Promise<OrderWithStopAndLink | null> {
  return tx.order.findFirst({
    include: {
      deliveryCustomerProfileLinks: {
        include: { profile: true },
        orderBy: { createdAt: "asc" },
        take: 1,
        where: { shopId },
      },
      deliveryStops: { take: 1 },
    },
    where: { id: orderId, shopId },
  });
}

function toContext(input: {
  matchReasons: string[];
  matchStatus: DeliveryCustomerMatchStatus;
  order: OrderWithStopAndLink;
  profile: DeliveryCustomerProfile;
}): DeliveryCustomerContext {
  return {
    customerNote: readCustomerNote(input.order),
    deliveryCustomer: {
      adminMemo: input.profile.adminMemo,
      matchReasons: input.matchReasons,
      matchStatus: input.matchStatus,
      profileId: input.profile.id,
    },
    orderId: input.order.id,
  };
}

function toContextWithoutDeliveryCustomer(
  order: OrderWithStopAndLink,
): DeliveryCustomerContext {
  return {
    customerNote: readCustomerNote(order),
    deliveryCustomer: null,
    orderId: order.id,
  };
}

async function resolveMergedProfile(
  tx: Prisma.TransactionClient,
  profile: DeliveryCustomerProfile,
  shopId: string,
): Promise<DeliveryCustomerProfile | null> {
  const scopedProfile = await tx.deliveryCustomerProfile.findFirst({
    where: { id: profile.id, shopId },
  });
  if (scopedProfile === null) return null;

  let current = scopedProfile;
  const visited = new Set<string>();
  while (current.mergedIntoProfileId !== null && !visited.has(current.id)) {
    visited.add(current.id);
    const next = await tx.deliveryCustomerProfile.findFirst({
      where: { id: current.mergedIntoProfileId, shopId },
    });
    if (next === null) return current;
    current = next;
  }
  return current;
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

function readCustomerSource(order: OrderWithStopAndLink): CustomerSource {
  const stop = order.deliveryStops[0] ?? null;
  const rawShipping = objectOrNull(order.shippingAddress);
  const address = normalizeAddress({
    address1: stop?.address1 ?? readString(rawShipping?.address1),
    address2: stop?.address2 ?? readString(rawShipping?.address2),
    city: stop?.city ?? readString(rawShipping?.city),
    countryCode: stop?.countryCode ?? readString(rawShipping?.countryCode),
    postalCode: stop?.postalCode ?? readString(rawShipping?.postalCode),
    province: stop?.province ?? readString(rawShipping?.province),
  });
  const normalAddressFingerprint = buildAddressFingerprint(address);
  const isolated = normalAddressFingerprint === null;
  const raw = objectOrNull(order.rawPayload);
  const name = normalizeText(stop?.recipientName ?? readString(raw?.recipientName));
  return {
    address,
    addressFingerprint: isolated ? `order:${order.id}` : normalAddressFingerprint,
    email: normalizeEmail(order.email),
    isolated,
    name,
    nameKey: normalizeNameKey(name),
    phone: normalizePhone(stop?.phone ?? order.phone),
  };
}

function readCustomerNote(order: OrderWithStopAndLink): string | null {
  const stop = order.deliveryStops[0] ?? null;
  const raw = objectOrNull(order.rawPayload);
  return (
    normalizeText(stop?.instructions) ??
    normalizeText(readString(raw?.customer_note)) ??
    normalizeText(readString(raw?.customerNote))
  );
}

function chooseConservativeMatch(
  source: CustomerSource,
  candidates: DeliveryCustomerProfile[],
): CandidateDecision {
  const matches = candidates
    .map((profile) => scoreCandidate(source, profile))
    .filter((match): match is Exclude<CandidateDecision, null> => match !== null)
    .sort((a, b) => b.matchScore - a.matchScore);
  if (matches.length !== 1) return null;
  return matches[0] ?? null;
}

function scoreCandidate(
  source: CustomerSource,
  profile: DeliveryCustomerProfile,
): CandidateDecision {
  const phoneConflict =
    source.phone !== null &&
    profile.canonicalPhone !== null &&
    source.phone !== profile.canonicalPhone;
  const emailConflict =
    source.email !== null &&
    profile.canonicalEmail !== null &&
    source.email !== profile.canonicalEmail;
  if (phoneConflict || emailConflict) return null;

  const reasons: string[] = [];
  let score = 0;
  if (
    source.phone !== null &&
    profile.canonicalPhone !== null &&
    source.phone === profile.canonicalPhone
  ) {
    reasons.push("same_address_phone_exact");
    score = Math.max(score, 1);
  }
  if (
    source.email !== null &&
    profile.canonicalEmail !== null &&
    source.email === profile.canonicalEmail
  ) {
    reasons.push("same_address_email_exact");
    score = Math.max(score, 1);
  }
  const nameScore = similarity(source.nameKey, profile.normalizedNameKey);
  if (nameScore >= 0.92) {
    reasons.push("same_address_name_high_similarity");
    score = Math.max(score, nameScore);
  }
  if (reasons.length === 0) return null;
  return { matchReasons: reasons, matchScore: score, profile };
}

function normalizeAddress(input: {
  address1: string | null | undefined;
  address2: string | null | undefined;
  city: string | null | undefined;
  countryCode: string | null | undefined;
  postalCode: string | null | undefined;
  province: string | null | undefined;
}): NormalizedAddress {
  return {
    address1: normalizeText(input.address1)?.toUpperCase() ?? null,
    address2: normalizeText(input.address2)?.toUpperCase() ?? null,
    city: normalizeText(input.city)?.toUpperCase() ?? null,
    countryCode: normalizeText(input.countryCode)?.toUpperCase() ?? null,
    postalCode: normalizePostalCode(input.postalCode),
    province: normalizeText(input.province)?.toUpperCase() ?? null,
  };
}

function buildAddressFingerprint(address: NormalizedAddress): string | null {
  if (address.postalCode === null && address.address1 === null) return null;
  return [
    address.countryCode ?? "",
    address.province ?? "",
    address.city ?? "",
    address.postalCode ?? "",
    address.address1 ?? "",
    address.address2 ?? "",
  ].join("|");
}

function normalizeText(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized === "" ? null : normalized;
}

function normalizePostalCode(value: string | null | undefined): string | null {
  const normalized = normalizeText(value);
  if (normalized === null) return null;
  return normalized.replace(/\s+/g, "").toUpperCase();
}

function normalizePhone(value: string | null | undefined): string | null {
  const normalized = normalizeText(value);
  if (normalized === null) return null;
  const digits = normalized.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits.length === 0 ? null : digits;
}

function normalizeEmail(value: string | null | undefined): string | null {
  const normalized = normalizeText(value);
  return normalized === null ? null : normalized.toLowerCase();
}

function normalizeNameKey(value: string | null): string | null {
  if (value === null) return null;
  const key = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return key === "" ? null : key;
}

function similarity(left: string | null, right: string | null): number {
  if (left === null || right === null) return 0;
  if (left === right) return 1;
  const leftTokens = new Set(left.split(" ").filter(Boolean));
  const rightTokens = new Set(right.split(" ").filter(Boolean));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let shared = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) shared += 1;
  }
  return (2 * shared) / (leftTokens.size + rightTokens.size);
}

function readMatchStatus(value: string): DeliveryCustomerMatchStatus {
  return value === "AUTO_MATCHED" ? "AUTO_MATCHED" : "CREATED_NEW";
}

function readStringArray(value: Prisma.JsonValue): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function normalizeAdminMemo(value: string | null): string | null {
  return normalizeText(value);
}

function objectOrNull(value: Prisma.JsonValue | null): Record<string, Prisma.JsonValue> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, Prisma.JsonValue>)
    : null;
}

function readString(value: Prisma.JsonValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}
