import { Prisma } from "@prisma/client";
import { describe, expect, test } from "vitest";

import { PrismaDeliveryCustomerProfileService } from "../src/modules/delivery-customer/delivery-customer-profile.service.js";

const shopId = "00000000-0000-0000-0000-000000000001";
const orderId = "00000000-0000-0000-0000-000000000101";

function profile(input: Partial<Record<string, unknown>> = {}) {
  return {
    addressFingerprint: "CA|ON|TORONTO|M5V2T6|123 QUEEN ST|UNIT 4",
    adminMemo: null,
    canonicalEmail: "driver@example.test",
    canonicalName: "Jane Driver",
    canonicalPhone: "4165550100",
    createdAt: new Date("2026-06-18T00:00:00.000Z"),
    id: "00000000-0000-0000-0000-000000000201",
    mergedIntoProfileId: null,
    normalizedAddress: {
      address1: "123 Queen St",
      address2: "Unit 4",
      city: "Toronto",
      countryCode: "CA",
      postalCode: "M5V2T6",
      province: "ON",
    },
    normalizedNameKey: "jane driver",
    shopId,
    updatedAt: new Date("2026-06-18T00:00:00.000Z"),
    ...input,
  };
}

function order() {
  return {
    deliveryStops: [
      {
        address1: "123 Queen St",
        address2: "Unit 4",
        city: "Toronto",
        countryCode: "CA",
        instructions: "Leave at the front desk.",
        phone: "+1 (416) 555-0100",
        postalCode: "M5V 2T6",
        province: "ON",
        recipientName: "Jane Driver",
      },
    ],
    email: "driver@example.test",
    id: orderId,
    phone: "+1 (416) 555-0100",
    rawPayload: {},
    shippingAddress: {},
    shopId,
  };
}

function createService(
  initialProfiles: ReturnType<typeof profile>[] = [],
  options: { failFirstLinkCreateWithUnique?: boolean } = {},
) {
  let shouldFailFirstLinkCreateWithUnique = options.failFirstLinkCreateWithUnique === true;
  const state = {
    links: [] as Array<{
      id: string;
      matchReasons: string[];
      matchScore: unknown;
      matchStatus: string;
      orderId: string;
      profileId: string;
      shopId: string;
    }>,
    profiles: [...initialProfiles],
  };
  const tx = {
    deliveryCustomerProfile: {
      create: ({ data }: { data: Record<string, unknown> }) => {
        const created = profile({
          ...data,
          id: `00000000-0000-0000-0000-00000000030${state.profiles.length}`,
        });
        state.profiles.push(created);
        return Promise.resolve(created);
      },
      findFirst: ({ where }: { where: Record<string, string> }) =>
        Promise.resolve(
          state.profiles.find(
            (candidate) =>
              candidate.id === where.id && candidate.shopId === where.shopId,
          ) ?? null,
        ),
      findMany: ({ where }: { where: Record<string, string | null> }) =>
        Promise.resolve(
          state.profiles.filter(
            (candidate) =>
              candidate.shopId === where.shopId &&
              candidate.addressFingerprint === where.addressFingerprint &&
              candidate.mergedIntoProfileId === where.mergedIntoProfileId,
          ),
        ),
      findUnique: ({ where }: { where: { id: string } }) =>
        Promise.resolve(
          state.profiles.find((candidate) => candidate.id === where.id) ?? null,
        ),
      update: ({
        data,
        where,
      }: {
        data: Record<string, unknown>;
        where: { id: string };
      }) => {
        const index = state.profiles.findIndex(
          (candidate) => candidate.id === where.id,
        );
        const current = state.profiles[index];
        if (current === undefined) throw new Error("profile not found");
        const updated: typeof current = { ...current, ...data };
        state.profiles[index] = updated;
        return Promise.resolve(updated);
      },
    },
    deliveryCustomerProfileOrderLink: {
      create: ({ data }: { data: Record<string, unknown> }) => {
        const created = {
          id: `00000000-0000-0000-0000-00000000040${state.links.length}`,
          matchReasons: Array.isArray(data.matchReasons)
            ? data.matchReasons.filter(
                (reason): reason is string => typeof reason === "string",
              )
            : [],
          matchScore: data.matchScore,
          matchStatus: String(data.matchStatus),
          orderId: String(data.orderId),
          profileId: String(data.profileId),
          shopId: String(data.shopId),
        };
        if (shouldFailFirstLinkCreateWithUnique) {
          shouldFailFirstLinkCreateWithUnique = false;
          state.links.push(created);
          throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
            clientVersion: "test",
            code: "P2002",
          });
        }
        state.links.push(created);
        return Promise.resolve(created);
      },
    },
    order: {
      findFirst: () => {
        const links = state.links
          .filter((link) => link.orderId === orderId && link.shopId === shopId)
          .map((link) => ({
            ...link,
            profile:
              state.profiles.find(
                (candidate) => candidate.id === link.profileId,
              ) ?? state.profiles[0],
          }));
        return Promise.resolve({
          ...order(),
          deliveryCustomerProfileLinks: links,
        });
      },
    },
  };
  const prisma = {
    $transaction: (run: (transaction: typeof tx) => unknown) =>
      Promise.resolve(run(tx)),
    shop: {
      findUnique: () => Promise.resolve({ id: shopId }),
    },
  };
  return {
    service: new PrismaDeliveryCustomerProfileService(prisma as never),
    state,
  };
}

describe("PrismaDeliveryCustomerProfileService", () => {
  test("creates one order-linked profile and keeps repeated reads idempotent", async () => {
    const { service, state } = createService();

    const first = await service.getOrderCustomerNoteContext({
      orderId,
      shopDomain: "tenant-a.example.test",
    });
    const second = await service.getOrderCustomerNoteContext({
      orderId,
      shopDomain: "tenant-a.example.test",
    });

    expect(first?.customerNote).toBe("Leave at the front desk.");
    expect(first?.deliveryCustomer?.matchStatus).toBe("CREATED_NEW");
    expect(second?.deliveryCustomer?.profileId).toBe(first?.deliveryCustomer?.profileId);
    expect(state.profiles).toHaveLength(1);
    expect(state.links).toHaveLength(1);
  });

  test("auto-matches only when same address has strong corroboration", async () => {
    const existing = profile();
    const { service, state } = createService([existing]);

    const context = await service.getOrderCustomerNoteContext({
      orderId,
      shopDomain: "tenant-a.example.test",
    });

    expect(context?.deliveryCustomer?.profileId).toBe(existing.id);
    expect(context?.deliveryCustomer?.matchStatus).toBe("AUTO_MATCHED");
    expect(context?.deliveryCustomer?.matchReasons).toContain("same_address_phone_exact");
    expect(state.profiles).toHaveLength(1);
  });

  test("keeps ambiguous same-address candidates separate", async () => {
    const { service, state } = createService([
      profile({ id: "00000000-0000-0000-0000-000000000211", canonicalEmail: null, canonicalPhone: null }),
      profile({ id: "00000000-0000-0000-0000-000000000212", canonicalEmail: null, canonicalPhone: null }),
    ]);

    const context = await service.getOrderCustomerNoteContext({
      orderId,
      shopDomain: "tenant-a.example.test",
    });

    expect(context?.deliveryCustomer?.matchStatus).toBe("CREATED_NEW");
    expect(context?.deliveryCustomer?.matchReasons).toContain("no_unambiguous_existing_profile");
    expect(state.profiles).toHaveLength(3);
  });

  test("rereads the existing order link when concurrent first materialization wins", async () => {
    const existing = profile();
    const { service, state } = createService([existing], {
      failFirstLinkCreateWithUnique: true,
    });

    const context = await service.getOrderCustomerNoteContext({
      orderId,
      shopDomain: "tenant-a.example.test",
    });

    expect(context?.deliveryCustomer?.profileId).toBe(existing.id);
    expect(context?.deliveryCustomer?.matchStatus).toBe("AUTO_MATCHED");
    expect(state.links).toHaveLength(1);
  });


  test("ignores same-order links from other shops instead of leaking their memo", async () => {
    const otherTenantProfile = profile({
      adminMemo: "Other tenant memo",
      id: "00000000-0000-0000-0000-000000000288",
      shopId: "00000000-0000-0000-0000-000000000002",
    });
    const { service, state } = createService([otherTenantProfile]);
    state.links.push({
      id: "00000000-0000-0000-0000-000000000488",
      matchReasons: ["same_address_phone_exact"],
      matchScore: new Prisma.Decimal(1),
      matchStatus: "AUTO_MATCHED",
      orderId,
      profileId: otherTenantProfile.id,
      shopId: "00000000-0000-0000-0000-000000000002",
    });

    const context = await service.getOrderCustomerNoteContext({
      orderId,
      shopDomain: "tenant-a.example.test",
    });

    expect(context?.deliveryCustomer?.adminMemo).not.toBe("Other tenant memo");
    expect(context?.deliveryCustomer?.profileId).not.toBe(otherTenantProfile.id);
    expect(state.links).toHaveLength(2);
  });

  test("does not resolve merged profiles across shop boundaries", async () => {
    const crossShopTargetId = "00000000-0000-0000-0000-000000000299";
    const source = profile({
      adminMemo: "Tenant A memo",
      id: "00000000-0000-0000-0000-000000000298",
      mergedIntoProfileId: crossShopTargetId,
      shopId,
    });
    const otherTenantTarget = profile({
      adminMemo: "Other tenant secret",
      id: crossShopTargetId,
      shopId: "00000000-0000-0000-0000-000000000002",
    });
    const { service, state } = createService([source, otherTenantTarget]);
    state.links.push({
      id: "00000000-0000-0000-0000-000000000499",
      matchReasons: ["same_address_phone_exact"],
      matchScore: new Prisma.Decimal(1),
      matchStatus: "AUTO_MATCHED",
      orderId,
      profileId: source.id,
      shopId,
    });

    const context = await service.getOrderCustomerNoteContext({
      orderId,
      shopDomain: "tenant-a.example.test",
    });

    expect(context?.deliveryCustomer?.adminMemo).toBe("Tenant A memo");
    expect(context?.deliveryCustomer?.profileId).toBe(source.id);
    expect(context?.deliveryCustomer?.adminMemo).not.toBe("Other tenant secret");
  });
});
