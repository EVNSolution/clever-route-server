import { normalizeRouteEngineBaseUrl } from './route-engine-coverage.js';

export type OsrmMatrixFetch = (url: string, init: {
  method: 'GET'; redirect: 'error'; signal?: AbortSignal;
}) => Promise<Response>;

export type OsrmTollMatrix = { durations: number[][]; distances: number[][] };

/** Uses the same OSRM graph and exclusion as displayed geometry. No fallback speed or toll allowance. */
export async function fetchAvoidTollsMatrix(input: {
  baseUrl: string;
  coordinates: Array<[number, number]>;
  fetch: OsrmMatrixFetch;
  signal: AbortSignal;
}): Promise<OsrmTollMatrix> {
  const baseUrl = normalizeRouteEngineBaseUrl('OSRM', input.baseUrl);
  const coordinatePath = input.coordinates.map(([lng, lat]) => `${lng},${lat}`).join(';');
  const response = await input.fetch(
    `${baseUrl}/table/v1/driving/${coordinatePath}?annotations=duration,distance&exclude=toll`,
    { method: 'GET', redirect: 'error', signal: input.signal },
  );
  if (!response.ok) throw new Error('Toll-avoiding OSRM Table request failed.');
  const payload: unknown = await response.json();
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Toll-avoiding OSRM Table response was invalid.');
  }
  const object = payload as Record<string, unknown>;
  if (object.code !== 'Ok' || (Array.isArray(object.fallback_speed_cells) && object.fallback_speed_cells.length > 0)) {
    throw new Error('Toll-avoiding OSRM Table did not find a complete road matrix.');
  }
  return {
    durations: readMatrix(object.durations, input.coordinates.length),
    distances: readMatrix(object.distances, input.coordinates.length),
  };
}

function readMatrix(value: unknown, size: number): number[][] {
  if (!Array.isArray(value) || value.length !== size) throw new Error('Incomplete toll-avoiding road matrix.');
  return value.map((row: unknown) => {
    if (!Array.isArray(row) || row.length !== size) throw new Error('Incomplete toll-avoiding road matrix.');
    return row.map((cell: unknown) => {
      // VROOM accepts nonnegative integer seconds/metres. Never turn an unreachable null into zero.
      if (typeof cell !== 'number' || !Number.isFinite(cell) || cell < 0 || cell > 0xffffffff) {
        throw new Error('Toll-avoiding road matrix has an unreachable or invalid cell.');
      }
      return Math.round(cell);
    });
  });
}
