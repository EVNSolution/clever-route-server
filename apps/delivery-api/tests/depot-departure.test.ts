import { describe, expect, test } from 'vitest';

import { resolveDepotDeparture } from '../src/modules/route-tracking/depot-departure.js';

const depot = { latitude: 37.5, longitude: 127 };
const near = { latitude: 37.5005, longitude: 127 }; // ~55 m
const far = { latitude: 37.52, longitude: 127 }; // ~2.2 km
const at = (minutes: number) => new Date(Date.UTC(2026, 9, 16, 0, minutes));
const sample = (id: string, minutes: number, point: { latitude: number; longitude: number }) => ({
  id,
  observedAt: at(minutes),
  ...point,
});

describe('resolveDepotDeparture', () => {
  test('arrival is the first inside position after the start and departure the first outside one after it', () => {
    const result = resolveDepotDeparture({
      depot,
      endAt: null,
      samples: [sample('a', 1, far), sample('b', 5, near), sample('c', 8, near), sample('d', 12, far)],
      startedAt: at(0),
      startedPosition: far,
    });

    expect(result.arrivedAt).toEqual(at(5));
    expect(result.departedAt).toEqual(at(12));
    expect(result.evidence).toMatchObject({
      evidenceEventId: 'd',
      observedAt: at(12).toISOString(),
      source: 'LOCATION_UPDATED',
      status: 'CONFIRMED',
      thresholdMeters: 150,
    });
  });

  test('a start pressed inside the radius departs at the first position outside it', () => {
    const result = resolveDepotDeparture({
      depot,
      endAt: null,
      samples: [sample('a', 0, far), sample('b', 3, near), sample('c', 6, far)],
      startedAt: at(2),
      startedPosition: near,
    });

    expect(result.arrivedAt).toEqual(at(2));
    expect(result.departedAt).toEqual(at(6));
    expect(result.evidence.status).toBe('CONFIRMED');
  });

  test('a start pressed after leaving the depot departs at the end of the last stay before it', () => {
    const result = resolveDepotDeparture({
      depot,
      endAt: null,
      samples: [sample('road', 0, far), sample('in1', 1, near), sample('in2', 3, near), sample('out', 4, far), sample('late', 9, far)],
      startedAt: at(6),
      startedPosition: far,
    });

    expect(result.arrivedAt).toEqual(at(1));
    expect(result.departedAt).toEqual(at(4));
    expect(result.evidence).toMatchObject({ evidenceEventId: 'out', status: 'CONFIRMED' });
  });

  test('a vehicle still inside at the start uses the positions after the start', () => {
    const result = resolveDepotDeparture({
      depot,
      endAt: null,
      samples: [sample('in', 1, near), sample('in2', 7, near), sample('out', 9, far)],
      startedAt: at(5),
      startedPosition: null,
    });

    expect(result.arrivedAt).toEqual(at(7));
    expect(result.departedAt).toEqual(at(9));
  });

  test('a depot stay older than the look-back is ignored', () => {
    const result = resolveDepotDeparture({
      depot,
      endAt: null,
      samples: [sample('old', 0, near), sample('out', 1, far), sample('late', 250, far)],
      startedAt: at(200),
      startedPosition: null,
    });

    expect(result.departedAt).toBeNull();
    expect(result.evidence.status).toBe('UNCONFIRMED');
  });

  test('no depot arrival is unconfirmed and omits the departure time', () => {
    const result = resolveDepotDeparture({
      depot,
      endAt: null,
      samples: [sample('a', 1, far), sample('b', 4, far)],
      startedAt: at(0),
      startedPosition: null,
    });

    expect(result.departedAt).toBeNull();
    expect(result.evidence).toEqual({
      distanceToDepotMeters: null,
      evidenceEventId: null,
      observedAt: null,
      source: 'NONE',
      status: 'UNCONFIRMED',
      thresholdMeters: 150,
    });
  });

  test('arrival without a later outside position is unconfirmed', () => {
    const result = resolveDepotDeparture({
      depot,
      endAt: null,
      samples: [sample('a', 1, near), sample('b', 4, near)],
      startedAt: at(0),
      startedPosition: null,
    });

    expect(result.arrivedAt).toEqual(at(1));
    expect(result.departedAt).toBeNull();
    expect(result.evidence.status).toBe('UNCONFIRMED');
  });

  test('positions at or after the route completion are not read as a departure', () => {
    const result = resolveDepotDeparture({
      depot,
      endAt: at(10),
      samples: [sample('a', 2, far), sample('b', 12, near), sample('c', 20, far)],
      startedAt: at(0),
      startedPosition: null,
    });

    expect(result.arrivedAt).toBeNull();
  });

  test('without depot coordinates or a start the evidence is unavailable', () => {
    expect(resolveDepotDeparture({ depot: null, endAt: null, samples: [], startedAt: at(0), startedPosition: null }).evidence.status)
      .toBe('UNAVAILABLE');
    expect(resolveDepotDeparture({ depot, endAt: null, samples: [], startedAt: null, startedPosition: null }).evidence.status)
      .toBe('UNAVAILABLE');
  });
});
