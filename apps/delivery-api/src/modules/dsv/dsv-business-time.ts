/** Execution serviceDate is a PostgreSQL date, represented by UTC midnight. */
export function dsvBusinessDayBounds(serviceDate: Date): { start: Date; noon: Date; end: Date } {
  const date = serviceDate.toISOString().slice(0, 10);
  const start = new Date(`${date}T00:00:00+09:00`);
  return {
    start,
    noon: new Date(start.getTime() + 12 * 60 * 60 * 1000),
    end: new Date(start.getTime() + 24 * 60 * 60 * 1000),
  };
}

export function dsvServiceDateAt(at: Date): Date {
  return new Date(`${new Date(at.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)}T00:00:00.000Z`);
}

export function isDsvBusinessDay(serviceDate: Date, at: Date): boolean {
  const { start, end } = dsvBusinessDayBounds(serviceDate);
  return at >= start && at < end;
}

export function isDsvMissingStartWindow(serviceDate: Date, at: Date): boolean {
  const { start, noon } = dsvBusinessDayBounds(serviceDate);
  return at >= start && at < noon;
}
