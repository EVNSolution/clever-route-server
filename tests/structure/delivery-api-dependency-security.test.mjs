import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const lockfile = JSON.parse(readFileSync(
  resolve(repositoryRoot, 'apps/delivery-api/package-lock.json'),
  'utf8'
));

function versionsFor(packageName) {
  return Object.entries(lockfile.packages)
    .filter(([path, metadata]) => packageNameAt(path, metadata) === packageName)
    .map(([, metadata]) => metadata.version);
}

function packageNameAt(path, metadata) {
  if (metadata.name) return metadata.name;
  return path.replace(/^node_modules\//u, '').replace(/^.*\/node_modules\//u, '');
}

function compareVersions(actual, expected) {
  const actualParts = actual.split('.').map(Number);
  const expectedParts = expected.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (actualParts[index] !== expectedParts[index]) {
      return actualParts[index] - expectedParts[index];
    }
  }
  return 0;
}

function assertMinimum(packageName, minimumByMajor) {
  const versions = versionsFor(packageName);
  assert.notEqual(versions.length, 0, `${packageName} must remain represented in the lockfile`);
  for (const version of versions) {
    const minimum = minimumByMajor[version.split('.')[0]];
    if (minimum) {
      assert.ok(
        compareVersions(version, minimum) >= 0,
        `${packageName}@${version} must resolve to ${minimum} or newer within major ${version.split('.')[0]}`
      );
    }
  }
}

test('locks known advisory fixes that are available without major migrations', () => {
  assertMinimum('firebase-admin', { 14: '14.3.0' });
  assertMinimum('fast-uri', { 3: '3.1.5' });
  assertMinimum('brace-expansion', { 2: '2.1.4', 5: '5.0.9' });
  assertMinimum('nanoid', { 3: '3.3.18' });
  assertMinimum('postcss', { 8: '8.5.23' });
  assertMinimum('vite', { 8: '8.0.16' });
});

test('keeps the audited dependency set identical to the production image boundary', () => {
  const packageJson = JSON.parse(readFileSync(
    resolve(repositoryRoot, 'apps/delivery-api/package.json'),
    'utf8'
  ));
  const dockerfile = readFileSync(resolve(repositoryRoot, 'apps/delivery-api/Dockerfile'), 'utf8');

  assert.equal(
    packageJson.scripts['audit:production'],
    'npm audit --omit=dev --omit=optional --audit-level=moderate'
  );
  assert.match(dockerfile, /prune --omit=dev --omit=optional/u);
  assert.match(dockerfile, /import\('firebase-admin\/messaging'\)/u);
  assert.match(dockerfile, /import\('@prisma\/client'\)/u);
});
