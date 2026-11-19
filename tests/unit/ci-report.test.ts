import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

const scratch = mkdtempSync(join(tmpdir(), 'wrl-report-guard-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function report(group: 'unit' | 'integration', total: number, skipped = 0) {
  const fileCount = group === 'unit' ? 5 : 3;
  const testResults = Array.from({ length: fileCount }, (_, index) => ({
    name: `/sandbox/tests/${group}/fixture${index}.test.ts`,
    assertionResults: Array.from(
      { length: Math.floor(total / fileCount) + (index < total % fileCount ? 1 : 0) },
      (_, i) => ({ status: skipped > 0 && index === 0 && i === 0 ? 'pending' : 'passed' }),
    ),
  }));
  return {
    success: true,
    numTotalTests: total,
    numPassedTests: total - skipped,
    numFailedTests: 0,
    numPendingTests: skipped,
    numTodoTests: 0,
    testResults,
  };
}

function verify(unit = report('unit', 25), integration = report('integration', 13)) {
  const unitFile = join(scratch, 'unit.json');
  const integrationFile = join(scratch, 'integration.json');
  writeFileSync(unitFile, JSON.stringify(unit));
  writeFileSync(integrationFile, JSON.stringify(integration));
  return spawnSync(process.execPath, ['scripts/ci/check-test-reports.mjs', unitFile, integrationFile], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

describe('CI report completeness guard', () => {
  it('accepts both full passing test reports', () => {
    const result = verify();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('integration: 13 passed, 0 skipped');
  });

  it('rejects skipped integration tests even when the report says success', () => {
    const result = verify(report('unit', 25), report('integration', 13, 1));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('incomplete, skipped');
  });

  it('rejects silently shrinking the integration suite', () => {
    const result = verify(report('unit', 25), report('integration', 12));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('incomplete, skipped');
  });

  it('rejects a misplaced unit report in place of the integration report', () => {
    const result = verify(report('unit', 25), report('unit', 25));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('unexpected test path');
  });
});
