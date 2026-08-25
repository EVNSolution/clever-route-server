#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const [path, expectedSha, expectedCurrentMode, targetMode] = process.argv.slice(2);
if (!path || !/^[0-9a-f]{40}$/u.test(expectedSha ?? '')) fail('exact source SHA is required');
const modes = ['OBSERVE', 'GUARDED', 'FULL'];
if (!modes.includes(expectedCurrentMode) || !modes.includes(targetMode)) fail('valid current and target modes are required');
const evidence = JSON.parse(await readFile(path, 'utf8'));
if (evidence.sourceSha !== expectedSha) fail('evidence source SHA mismatch');
if (evidence.currentMode !== expectedCurrentMode) fail('evidence current mode mismatch');
if (evidence.runtime?.capabilityVersion !== 1
  || !/^sha256:[0-9a-f]{64}$/u.test(evidence.runtime?.imageId ?? '')
  || !/@sha256:[0-9a-f]{64}$/u.test(evidence.runtime?.imageRepoDigest ?? '')
  || evidence.runtime?.revision !== expectedSha) fail('live runtime digest, image ID, revision, and capability are required');
if (expectedCurrentMode === 'OBSERVE' && targetMode === 'FULL') fail('OBSERVE to FULL is prohibited');
if (targetMode === 'OBSERVE') pass();
if (targetMode === expectedCurrentMode) fail('target mode must differ from current mode');
const generatedAt = typeof evidence.generatedAt === 'string' ? Date.parse(evidence.generatedAt) : Number.NaN;
if (!Number.isFinite(generatedAt) || generatedAt < Date.now() - 24 * 60 * 60 * 1000 || generatedAt > Date.now() + 5 * 60 * 1000) fail('evidence is missing, stale, or future-dated');
const adoption = evidence.activeSessions?.adoptionPercent;
const gate = evidence.gate ?? {};
if (typeof adoption !== 'number' || adoption < 95) fail('receipt-aware active-session adoption must be at least 95%');
if (!Number.isInteger(gate.consecutiveCleanReviewedDays) || gate.consecutiveCleanReviewedDays < 7) fail('seven consecutive clean reviewed days are required');
if (!Number.isInteger(gate.minimumDailySampleCount) || gate.minimumDailySampleCount < 1) fail('each closed review day requires at least one eligible completion sample');
if (gate.falsePositiveCount !== 0 || gate.unreviewedWouldRejectCount !== 0) fail('false-positive and unreviewed counts must be zero');
if (!Number.isInteger(gate.recoveryCohortCount) || gate.recoveryCohortCount < 1) fail('receipt recovery cohort evidence is required');
if (typeof gate.recoveryWithinFiveMinutesPercent !== 'number' || gate.recoveryWithinFiveMinutesPercent < 99.5 || evidence.recoveryVerified !== true) fail('at least 99.5% receipt recovery within five minutes is required');
if (targetMode === 'FULL') {
  if (expectedCurrentMode !== 'GUARDED') fail('FULL requires current GUARDED mode');
  if (evidence.activeSessions?.legacyActiveCount !== 0 || evidence.legacyRetirementVerified !== true) fail('legacy retirement evidence is required');
}
pass();

function fail(message) { process.stderr.write(`route-completion-evidence: ${message}\n`); process.exit(65); }
function pass() { process.stdout.write('ROUTE_COMPLETION_EVIDENCE=VERIFIED\n'); process.exit(0); }
