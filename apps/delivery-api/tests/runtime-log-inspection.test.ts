import { readFile } from 'node:fs/promises';

import { describe, expect, test } from 'vitest';

describe('runtime log inspection tooling', () => {
  test('provides a safe self-hosted workflow for reading recent EC2 logs', async () => {
    const workflow = await readFile('.github/workflows/inspect-ec2-runtime.yml', 'utf8');

    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('self-hosted');
    expect(workflow).toContain('clever-route-server');
    expect(workflow).toContain('scripts/inspect-ec2-runtime.sh');
  });

  test('inspection script reads compose logs without printing runtime secrets', async () => {
    const script = await readFile('scripts/inspect-ec2-runtime.sh', 'utf8');

    expect(script).toContain('docker compose');
    expect(script).toContain('logs --since');
    expect(script).toContain('delivery-api');
    expect(script).toContain('caddy');
    expect(script).toContain('route_plans');
    expect(script).not.toMatch(/\bcat\s+\.env\b/u);
    expect(script).not.toMatch(/printenv/u);
    expect(script).not.toMatch(/\benv\s*\|/u);
  });
});
