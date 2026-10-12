import { describe, expect, test } from 'vitest';
import { clipCustomerTrailLines } from '../src/routes/dsv-v1-read.routes.js';

// 0.01 deg longitude at 37.5N is about 880m.
const depot: [number, number] = [126.9, 37.5];

// Dense GPS line: one vertex per 0.001 deg (about 88m).
function denseLine(from: number, to: number): Array<[number, number]> {
  const steps = Math.round(Math.abs(to - from) / 0.001);
  return Array.from({ length: steps + 1 }, (_, index) =>
    [Number((from + Math.sign(to - from) * index * 0.001).toFixed(3)), 37.5] as [number, number]);
}

describe('clipCustomerTrailLines', () => {
  test('ends at the customer on a dense line, not where the 1km circle starts', () => {
    const segments = clipCustomerTrailLines([denseLine(126.9, 126.98)], depot, [126.95, 37.5]);
    expect(segments[0]!.coordinates.at(-1)).toEqual([126.95, 37.5]);
  });

  test('starts at the depot departure on a round trip, not at the return', () => {
    const outbound = denseLine(126.9, 126.95);
    const inbound = denseLine(126.95, 126.9);
    inbound[inbound.length - 1] = [126.9, 37.5000001];
    const segments = clipCustomerTrailLines([outbound, inbound], [126.9, 37.5000001], [126.95, 37.5]);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.coordinates[0]![0]).toBeCloseTo(126.9, 6);
    expect(segments[0]!.coordinates.at(-1)).toEqual([126.95, 37.5]);
  });

  test('returns a trail for a single customer stop', () => {
    const segments = clipCustomerTrailLines([[[126.9, 37.5], [126.95, 37.5]]], depot, [126.95, 37.5]);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.coordinates[0]).toEqual([126.9, 37.5]);
    // Cut on the first segment within 1km of the stop.
    expect(segments[0]!.coordinates.at(-1)).toEqual([126.95, 37.5]);
  });

  test('cuts by position when all stops were completed at once later', () => {
    // One time-ordered line far past the customer; completion time is not used.
    const line: Array<[number, number]> = [[126.9, 37.5], [126.92, 37.5], [126.94, 37.5], [126.96, 37.5], [126.98, 37.5]];
    const segments = clipCustomerTrailLines([line], depot, [126.94, 37.501]);
    expect(segments).toEqual([{ coordinates: [[126.9, 37.5], [126.92, 37.5], [126.94, 37.5]] }]);
  });

  test('uses the first approach to the stop when the vehicle revisits the area', () => {
    const outbound: Array<[number, number]> = [[126.9, 37.5], [126.95, 37.5]];
    const away: Array<[number, number]> = [[126.95, 37.5], [126.95, 37.6]];
    const back: Array<[number, number]> = [[126.95, 37.6], [126.95, 37.5]];
    const segments = clipCustomerTrailLines([outbound, away, back], depot, [126.95, 37.5]);
    expect(segments).toEqual([{ coordinates: [[126.9, 37.5], [126.95, 37.5]] }]);
  });

  test('skips an early drive-by of the last stop and ends at the real visit', () => {
    // Real case 2026-10-12: the vehicle passed about 490m from the last stop at 00:52Z, then reached it at 03:11Z.
    const toArea = denseLine(126.9, 126.95);
    const driveBy: Array<[number, number]> = [[126.95, 37.5], [126.95, 37.4955], [126.96, 37.4955]];
    const tour: Array<[number, number]> = [[126.96, 37.4955], [126.96, 37.52], [126.955, 37.52], [126.955, 37.5002]];
    const segments = clipCustomerTrailLines([toArea, driveBy, tour], depot, [126.955, 37.5]);
    expect(segments).toHaveLength(3);
    const last = segments.at(-1)!.coordinates.at(-1)!;
    expect(last[0]).toBeCloseTo(126.955, 3);
    expect(last[1]).toBeCloseTo(37.5002, 4);
  });

  test('starts at the first GPS point when the depot is far from the trail', () => {
    const segments = clipCustomerTrailLines([[[127, 37.5], [127.05, 37.5]]], depot, [127.05, 37.5]);
    expect(segments[0]!.coordinates[0]).toEqual([127, 37.5]);
  });
});
