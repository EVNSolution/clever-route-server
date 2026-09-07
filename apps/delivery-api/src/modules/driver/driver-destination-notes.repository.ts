import type { PrismaClient } from '@prisma/client';
import { dsvDestinationIdentity } from '../dsv/dsv-destination-identity.js';

export type DriverLunchEntryStatus = 'AVAILABLE' | 'UNAVAILABLE';

export type DriverDestinationNotes = {
  lunchEntryStatus: DriverLunchEntryStatus | null;
  lunchEntryStatusUpdatedAt: string | null;
  lunchTimeRange: string | null;
  lunchTimeRangeUpdatedAt: string | null;
  memo: string | null;
  memoUpdatedAt: string | null;
  openTime: string | null;
  openTimeUpdatedAt: string | null;
  requiredArrivalTime: string | null;
  requiredArrivalTimeUpdatedAt: string | null;
};

export type DriverDestinationNotesPatch = Partial<{
  lunchEntryStatus: DriverLunchEntryStatus | null;
  lunchTimeRange: string | null;
  memo: string | null;
  openTime: string | null;
  requiredArrivalTime: string | null;
}>;

export type UpdateDriverDestinationNotesInput = {
  destinationId: string;
  driverId: string;
  patch: DriverDestinationNotesPatch;
  routePlanId: string;
  shopId: string;
};

export type DriverDestinationNotesServiceContract = {
  update(input: UpdateDriverDestinationNotesInput): Promise<DriverDestinationNotes>;
};

type DestinationNotesPrisma = Pick<PrismaClient, 'deliveryCustomerProfile' | 'routePlanStop'>;
export type DestinationNotesRecord = {
  driverLunchEntryStatus: string | null;
  driverLunchEntryStatusUpdatedAt: Date | null;
  driverLunchTimeRange: string | null;
  driverLunchTimeRangeUpdatedAt: Date | null;
  driverMemo: string | null;
  driverMemoUpdatedAt: Date | null;
  driverOpenTime: string | null;
  driverOpenTimeUpdatedAt: Date | null;
  driverRequiredArrivalTime: string | null;
  driverRequiredArrivalTimeUpdatedAt: Date | null;
  id: string;
};

export type CanonicalDestinationProfileRecord = DestinationNotesRecord & {
  canonicalName: string | null;
  createdAt: Date;
  isStoreReviewData: boolean;
  mergedIntoProfileId: string | null;
  normalizedAddress: unknown;
};

export type CanonicalDestinationProjection = {
  destinationId: string;
  memberIds: string[];
  notes: DriverDestinationNotes;
};

export const driverDestinationNotesSelect = {
  driverLunchEntryStatus: true,
  driverLunchEntryStatusUpdatedAt: true,
  driverLunchTimeRange: true,
  driverLunchTimeRangeUpdatedAt: true,
  driverMemo: true,
  driverMemoUpdatedAt: true,
  driverOpenTime: true,
  driverOpenTimeUpdatedAt: true,
  driverRequiredArrivalTime: true,
  driverRequiredArrivalTimeUpdatedAt: true,
  id: true
} as const;

export const canonicalDestinationProfileSelect = {
  ...driverDestinationNotesSelect,
  canonicalName: true,
  createdAt: true,
  isStoreReviewData: true,
  mergedIntoProfileId: true,
  normalizedAddress: true
} as const;

export class DriverDestinationNotesScopeError extends Error {
  readonly code = 'DESTINATION_NOTES_ROUTE_SCOPE_REJECTED';

  constructor() {
    super('현재 배송 경로의 배송지만 수정할 수 있습니다.');
    this.name = 'DriverDestinationNotesScopeError';
  }
}

export class PrismaDriverDestinationNotesRepository implements DriverDestinationNotesServiceContract {
  constructor(
    private readonly prisma: DestinationNotesPrisma,
    private readonly now: () => Date = () => new Date()
  ) {}

  async update(input: UpdateDriverDestinationNotesInput): Promise<DriverDestinationNotes> {
    const profiles = await this.prisma.deliveryCustomerProfile.findMany({
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: canonicalDestinationProfileSelect,
      where: { mergedIntoProfileId: null, shopId: input.shopId }
    }) as CanonicalDestinationProfileRecord[];
    const projection = buildCanonicalDestinationProjection(profiles).get(input.destinationId);
    if (projection === undefined) throw new DriverDestinationNotesScopeError();
    const routeStop = await this.prisma.routePlanStop.findFirst({
      select: {
        deliveryStop: {
          select: {
            order: {
              select: {
                destinationId: true
              }
            }
          }
        }
      },
      where: {
        deliveryStop: { order: { destinationId: { in: projection.memberIds }, shopId: input.shopId } },
        routePlan: { driverId: input.driverId, shopId: input.shopId },
        routePlanId: input.routePlanId,
        shopId: input.shopId
      }
    });
    if (routeStop === null) throw new DriverDestinationNotesScopeError();

    const canonical = profiles.find((profile) => profile.id === projection.destinationId);
    if (canonical === undefined) throw new DriverDestinationNotesScopeError();
    const current = fromDriverDestinationNotes(projection.notes, canonical.id);

    const changedAt = this.now();
    const data: Record<string, string | Date | null> = {};
    copyChangedField(input.patch, 'memo', current.driverMemo, data, 'driverMemo', 'driverMemoUpdatedAt', changedAt);
    copyChangedField(input.patch, 'openTime', current.driverOpenTime, data, 'driverOpenTime', 'driverOpenTimeUpdatedAt', changedAt);
    copyChangedField(
      input.patch,
      'lunchTimeRange',
      current.driverLunchTimeRange,
      data,
      'driverLunchTimeRange',
      'driverLunchTimeRangeUpdatedAt',
      changedAt
    );
    copyChangedField(
      input.patch,
      'lunchEntryStatus',
      current.driverLunchEntryStatus,
      data,
      'driverLunchEntryStatus',
      'driverLunchEntryStatusUpdatedAt',
      changedAt
    );
    copyChangedField(
      input.patch,
      'requiredArrivalTime',
      current.driverRequiredArrivalTime,
      data,
      'driverRequiredArrivalTime',
      'driverRequiredArrivalTimeUpdatedAt',
      changedAt
    );

    const saved = Object.keys(data).length === 0
      ? current
      : await this.prisma.deliveryCustomerProfile.update({
          data,
          select: driverDestinationNotesSelect,
          where: { id_shopId: { id: projection.destinationId, shopId: input.shopId } }
        });
    if (Object.keys(data).length === 0) return projection.notes;
    const nextProfiles = profiles.map((profile) => profile.id === projection.destinationId ? { ...profile, ...saved } : profile);
    return buildCanonicalDestinationProjection(nextProfiles).get(input.destinationId)?.notes ?? toDriverDestinationNotes(saved);
  }
}

export function buildCanonicalDestinationProjection(
  profiles: CanonicalDestinationProfileRecord[]
): Map<string, CanonicalDestinationProjection> {
  const groups = new Map<string, CanonicalDestinationProfileRecord[]>();
  for (const profile of profiles) {
    if (profile.mergedIntoProfileId !== null) continue;
    const address = destinationAddress(profile.normalizedAddress);
    if (address.address === '') continue;
    const identity = dsvDestinationIdentity({
      address: address.address,
      detailAddress: address.detailAddress,
      destinationName: profile.canonicalName ?? address.name ?? profile.id
    });
    const key = `${profile.isStoreReviewData ? '1' : '0'}\u0000${identity.name}\u0000${identity.address}`;
    groups.set(key, [...(groups.get(key) ?? []), profile]);
  }
  const result = new Map<string, CanonicalDestinationProjection>();
  for (const group of groups.values()) {
    const ordered = [...group].sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id));
    const canonical = ordered[0];
    if (canonical === undefined) continue;
    const projection = {
      destinationId: canonical.id,
      memberIds: ordered.map(({ id }) => id),
      notes: aggregateDestinationNotes(ordered)
    };
    for (const profile of ordered) result.set(profile.id, projection);
  }
  return result;
}

function aggregateDestinationNotes(profiles: CanonicalDestinationProfileRecord[]): DriverDestinationNotes {
  const field = (valueKey: keyof DestinationNotesRecord, timestampKey: keyof DestinationNotesRecord): [string | null, string | null] => {
    const timestamped = [...profiles]
      .filter((profile) => profile[timestampKey] instanceof Date)
      .sort((left, right) => {
        const leftAt = (left[timestampKey] as Date).getTime();
        const rightAt = (right[timestampKey] as Date).getTime();
        return rightAt - leftAt || right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id);
      });
    const row = timestamped[0] ?? [...profiles]
      .filter((profile) => typeof profile[valueKey] === 'string')
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id))[0];
    return row === undefined ? [null, null] : [typeof row[valueKey] === 'string' ? row[valueKey] : null, iso(row[timestampKey] as Date | null)];
  };
  const [memo, memoUpdatedAt] = field('driverMemo', 'driverMemoUpdatedAt');
  const [openTime, openTimeUpdatedAt] = field('driverOpenTime', 'driverOpenTimeUpdatedAt');
  const [lunchTimeRange, lunchTimeRangeUpdatedAt] = field('driverLunchTimeRange', 'driverLunchTimeRangeUpdatedAt');
  const [lunchEntryStatus, lunchEntryStatusUpdatedAt] = field('driverLunchEntryStatus', 'driverLunchEntryStatusUpdatedAt');
  const [requiredArrivalTime, requiredArrivalTimeUpdatedAt] = field('driverRequiredArrivalTime', 'driverRequiredArrivalTimeUpdatedAt');
  return {
    lunchEntryStatus: isLunchEntryStatus(lunchEntryStatus) ? lunchEntryStatus : null,
    lunchEntryStatusUpdatedAt,
    lunchTimeRange,
    lunchTimeRangeUpdatedAt,
    memo,
    memoUpdatedAt,
    openTime,
    openTimeUpdatedAt,
    requiredArrivalTime,
    requiredArrivalTimeUpdatedAt
  };
}

function destinationAddress(value: unknown): { address: string; detailAddress: string | null; name: string | null } {
  const row = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const text = (key: string): string | null => typeof row[key] === 'string' && row[key].trim() !== '' ? row[key].trim() : null;
  return {
    address: text('address') ?? text('address1') ?? '',
    detailAddress: text('detailAddress') ?? text('address2'),
    name: text('name')
  };
}

function fromDriverDestinationNotes(notes: DriverDestinationNotes, id: string): DestinationNotesRecord {
  return {
    driverLunchEntryStatus: notes.lunchEntryStatus,
    driverLunchEntryStatusUpdatedAt: dateOrNull(notes.lunchEntryStatusUpdatedAt),
    driverLunchTimeRange: notes.lunchTimeRange,
    driverLunchTimeRangeUpdatedAt: dateOrNull(notes.lunchTimeRangeUpdatedAt),
    driverMemo: notes.memo,
    driverMemoUpdatedAt: dateOrNull(notes.memoUpdatedAt),
    driverOpenTime: notes.openTime,
    driverOpenTimeUpdatedAt: dateOrNull(notes.openTimeUpdatedAt),
    driverRequiredArrivalTime: notes.requiredArrivalTime,
    driverRequiredArrivalTimeUpdatedAt: dateOrNull(notes.requiredArrivalTimeUpdatedAt),
    id
  };
}

function dateOrNull(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}

export function toDriverDestinationNotes(record: DestinationNotesRecord | null): DriverDestinationNotes {
  if (record === null) {
    return {
      lunchEntryStatus: null,
      lunchEntryStatusUpdatedAt: null,
      lunchTimeRange: null,
      lunchTimeRangeUpdatedAt: null,
      memo: null,
      memoUpdatedAt: null,
      openTime: null,
      openTimeUpdatedAt: null,
      requiredArrivalTime: null,
      requiredArrivalTimeUpdatedAt: null
    };
  }
  return {
    lunchEntryStatus: isLunchEntryStatus(record.driverLunchEntryStatus) ? record.driverLunchEntryStatus : null,
    lunchEntryStatusUpdatedAt: iso(record.driverLunchEntryStatusUpdatedAt),
    lunchTimeRange: record.driverLunchTimeRange,
    lunchTimeRangeUpdatedAt: iso(record.driverLunchTimeRangeUpdatedAt),
    memo: record.driverMemo,
    memoUpdatedAt: iso(record.driverMemoUpdatedAt),
    openTime: record.driverOpenTime,
    openTimeUpdatedAt: iso(record.driverOpenTimeUpdatedAt),
    requiredArrivalTime: record.driverRequiredArrivalTime,
    requiredArrivalTimeUpdatedAt: iso(record.driverRequiredArrivalTimeUpdatedAt)
  };
}

function copyChangedField(
  patch: DriverDestinationNotesPatch,
  patchKey: keyof DriverDestinationNotesPatch,
  currentValue: string | null,
  data: Record<string, string | Date | null>,
  valueKey: string,
  updatedAtKey: string,
  changedAt: Date
): void {
  if (!Object.prototype.hasOwnProperty.call(patch, patchKey)) return;
  const nextValue = patch[patchKey] ?? null;
  if (nextValue === currentValue) return;
  data[valueKey] = nextValue;
  data[updatedAtKey] = changedAt;
}

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function isLunchEntryStatus(value: string | null): value is DriverLunchEntryStatus {
  return value === 'AVAILABLE' || value === 'UNAVAILABLE';
}
