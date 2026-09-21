import type {
  CompletionCandidate,
  CompletionPolicy,
  CompletionSample,
  CompletionStop
} from './completion-assistance.contract.js';

export type CompletionEvidenceValidation = { verifiedExitAt?: Date; holdReason?: string };

export function validateVisitEvidence(
  candidate: CompletionCandidate,
  policy: CompletionPolicy,
  stops: CompletionStop[],
  serverSamples: CompletionSample[],
  now: Date
): CompletionEvidenceValidation {
  if (candidate.policyVersion !== policy.version) return held('policy_version_mismatch');
  const target = stops.find((stop) => stop.deliveryStopId === candidate.deliveryStopId);
  if (target?.coordinates === null || target?.coordinates === undefined) return held('stop_coordinates_missing');
  if (candidate.evidence.length > 64) return held('evidence_limit_exceeded');
  if (candidate.evidence.length < policy.minDwellSamples + 2) return held('insufficient_evidence');
  const samples = candidate.evidence;
  const timestamps = samples.map((sample) => Date.parse(sample.occurredAt));
  if (timestamps.some((time) => !Number.isFinite(time) || time > now.getTime())) return held('invalid_sample_time');
  if (timestamps.some((time, index) => index > 0 && time <= timestamps[index - 1]!)) return held('sample_time_not_increasing');
  if (!hasEquivalentServerSequence(samples, serverSamples)) return held('server_evidence_sequence_mismatch');
  if (timestamps.some((time, index) => index > 0 && time - timestamps[index - 1]! > policy.maxGapMs)) {
    return held('sample_gap_exceeded');
  }
  if (samples.some((sample) => sample.accuracyMeters > policy.maxAccuracyMeters)) return held('accuracy_too_low');

  const first = samples[0]!;
  if (!certainlyOutside(target.coordinates, first, policy.enterRadiusMeters)) return held('approach_not_verified');
  const arrivalIndex = samples.findIndex((sample, index) => index > 0
    && certainlyInside(target.coordinates!, sample, policy.enterRadiusMeters));
  if (arrivalIndex < 0 || samples[arrivalIndex]!.occurredAt !== candidate.arrivalAt) return held('arrival_not_verified');

  const exitIndex = samples.length - 1;
  const exit = samples[exitIndex]!;
  if (exit.occurredAt !== candidate.exitAt || !certainlyOutside(target.coordinates, exit, policy.exitRadiusMeters)) {
    return held('exit_not_verified');
  }
  if (isAmbiguous(target, stops, samples.slice(arrivalIndex, exitIndex), policy.ambiguityRadiusMeters)) {
    return held('ambiguous_stop');
  }

  let insideCount = 0;
  let verifiedDwellAt: string | undefined;
  const arrivalTime = timestamps[arrivalIndex]!;
  for (let index = arrivalIndex; index < exitIndex; index += 1) {
    const sample = samples[index]!;
    if (verifiedDwellAt !== undefined) {
      if (certainlyOutside(target.coordinates, sample, policy.exitRadiusMeters)) return held('earlier_exit_observed');
      continue;
    }
    if (!certainlyInside(target.coordinates, sample, policy.enterRadiusMeters)) return held('dwell_not_continuous');
    insideCount += 1;
    if (
      verifiedDwellAt === undefined
      && insideCount >= policy.minDwellSamples
      && timestamps[index]! - arrivalTime >= policy.dwellMs
    ) verifiedDwellAt = sample.occurredAt;
  }
  if (verifiedDwellAt === undefined || verifiedDwellAt !== candidate.dwellCompletedAt) return held('dwell_not_verified');
  return { verifiedExitAt: new Date(exit.occurredAt) };
}

function held(holdReason: string): CompletionEvidenceValidation {
  return { holdReason };
}

function hasEquivalentServerSequence(
  evidence: CompletionSample[],
  serverSamples: CompletionSample[]
): boolean {
  const firstTime = Date.parse(evidence[0]!.occurredAt);
  const exitTime = Date.parse(evidence.at(-1)!.occurredAt);
  const serverWindow = serverSamples
    .filter((sample) => {
      const time = Date.parse(sample.occurredAt);
      return time >= firstTime && time <= exitTime;
    })
    .sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt));
  return serverWindow.length === evidence.length
    && evidence.every((sample, index) => samePersistedSample(sample, serverWindow[index]!));
}

function samePersistedSample(client: CompletionSample, server: CompletionSample): boolean {
  return server.occurredAt === client.occurredAt
    && coordinateAtDatabasePrecision(server.latitude) === coordinateAtDatabasePrecision(client.latitude)
    && coordinateAtDatabasePrecision(server.longitude) === coordinateAtDatabasePrecision(client.longitude)
    && server.accuracyMeters === client.accuracyMeters;
}

function coordinateAtDatabasePrecision(value: number): string {
  return value.toFixed(7);
}

function certainlyInside(
  stop: { latitude: number; longitude: number },
  sample: CompletionSample,
  radiusMeters: number
): boolean {
  return distanceMeters(stop, sample) + sample.accuracyMeters <= radiusMeters;
}

function certainlyOutside(
  stop: { latitude: number; longitude: number },
  sample: CompletionSample,
  radiusMeters: number
): boolean {
  return distanceMeters(stop, sample) - sample.accuracyMeters >= radiusMeters;
}

function isAmbiguous(
  target: CompletionStop,
  stops: CompletionStop[],
  dwellSamples: CompletionSample[],
  radiusMeters: number
): boolean {
  const targetCoordinates = target.coordinates!;
  return stops.some((other) => other.deliveryStopId !== target.deliveryStopId
    && other.coordinates !== null
    && distanceMeters(targetCoordinates, other.coordinates) <= radiusMeters * 2
    && dwellSamples.some((sample) => (
      distanceMeters(targetCoordinates, sample) - sample.accuracyMeters <= radiusMeters
      && distanceMeters(other.coordinates!, sample) - sample.accuracyMeters <= radiusMeters
    )));
}

function distanceMeters(
  left: { latitude: number; longitude: number },
  right: { latitude: number; longitude: number }
): number {
  const radians = (value: number) => value * Math.PI / 180;
  const latitudeDelta = radians(right.latitude - left.latitude);
  const longitudeDelta = radians(right.longitude - left.longitude);
  const leftLatitude = radians(left.latitude);
  const rightLatitude = radians(right.latitude);
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(leftLatitude) * Math.cos(rightLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}
