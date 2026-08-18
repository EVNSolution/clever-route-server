import type { PrismaClient } from '@prisma/client';

export type DriverLunchEntryStatus = 'AVAILABLE' | 'UNAVAILABLE';

export type DriverDestinationNotes = {
  lunchEntryStatus: DriverLunchEntryStatus | null;
  lunchEntryStatusUpdatedAt: string | null;
  lunchTimeRange: string | null;
  lunchTimeRangeUpdatedAt: string | null;
  memo: string | null;
  memoUpdatedAt: string | null;
  requiredArrivalTime: string | null;
  requiredArrivalTimeUpdatedAt: string | null;
};

export type DriverDestinationNotesPatch = Partial<{
  lunchEntryStatus: DriverLunchEntryStatus | null;
  lunchTimeRange: string | null;
  memo: string | null;
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
type DestinationNotesRecord = {
  driverLunchEntryStatus: string | null;
  driverLunchEntryStatusUpdatedAt: Date | null;
  driverLunchTimeRange: string | null;
  driverLunchTimeRangeUpdatedAt: Date | null;
  driverMemo: string | null;
  driverMemoUpdatedAt: Date | null;
  driverRequiredArrivalTime: string | null;
  driverRequiredArrivalTimeUpdatedAt: Date | null;
  id: string;
};

export const driverDestinationNotesSelect = {
  driverLunchEntryStatus: true,
  driverLunchEntryStatusUpdatedAt: true,
  driverLunchTimeRange: true,
  driverLunchTimeRangeUpdatedAt: true,
  driverMemo: true,
  driverMemoUpdatedAt: true,
  driverRequiredArrivalTime: true,
  driverRequiredArrivalTimeUpdatedAt: true,
  id: true
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
    const routeStop = await this.prisma.routePlanStop.findFirst({
      select: {
        deliveryStop: {
          select: {
            order: {
              select: {
                destination: { select: driverDestinationNotesSelect }
              }
            }
          }
        }
      },
      where: {
        deliveryStop: { order: { destinationId: input.destinationId, shopId: input.shopId } },
        routePlan: { driverId: input.driverId, shopId: input.shopId },
        routePlanId: input.routePlanId,
        shopId: input.shopId
      }
    });
    const current = routeStop?.deliveryStop.order.destination as DestinationNotesRecord | null | undefined;
    if (current === null || current === undefined) throw new DriverDestinationNotesScopeError();

    const changedAt = this.now();
    const data: Record<string, string | Date | null> = {};
    copyChangedField(input.patch, 'memo', current.driverMemo, data, 'driverMemo', 'driverMemoUpdatedAt', changedAt);
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
          where: { id_shopId: { id: input.destinationId, shopId: input.shopId } }
        });
    return toDriverDestinationNotes(saved);
  }
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
