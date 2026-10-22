import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { ReviewUnitResult } from '../src/review/work-types';

test('real SDK diagnoses bad shortrefs before schema validation and captures twelve host-owned spans after correction', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-receipt-sdk-'));
  try {
    const stdout = execFileSync(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        join(import.meta.dirname, 'pi/fixtures/work-sdk-entry.ts'),
      ],
      {
        cwd: directory,
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          ...process.env,
          FIXTURE_DIR: directory,
          FIXTURE_ROLE: 'worker-recovery',
          PI_CODING_AGENT_DIR: directory,
          PI_OFFLINE: '1',
        },
      }
    );
    const report = JSON.parse(stdout.trim().split('\n').at(-1)!) as {
      result: { reviewUnit: ReviewUnitResult };
      requests: number;
      expectedSpanIds: string[];
      warnings: string[];
      rejection: string;
      submitProperties: string[][];
      toolSets: string[][];
    };
    expect(report.requests).toBe(4);
    expect(report.rejection).toContain('S13');
    expect(report.rejection).toContain('S1..S12');
    expect(
      report.warnings.some(
        message => message.includes('receipt_rejected') && message.includes('S13')
      )
    ).toBe(true);
    expect(report.rejection).toContain('F1');
    expect(report.rejection).toMatch(/missing|disposition/i);
    expect(
      report.warnings.some(
        message => message.includes('receipt_rejected') && message.includes('F1')
      )
    ).toBe(true);
    expect(report.result.reviewUnit).toMatchObject({
      unitId: 'unit-1',
      status: 'reviewed',
      coveredSpanIds: report.expectedSpanIds,
      reconciledFindingIds: ['F1'],
      findings: [{ id: 'F1', lifecycle: 'fixed' }],
    });
    expect(report.result.reviewUnit.coveredSpanIds).toHaveLength(12);
    for (const properties of report.submitProperties) {
      expect(properties).toContain('status');
      expect(properties).not.toContain('unitId');
      expect(properties).not.toContain('coveredSpanIds');
      expect(properties).not.toContain('reconciledFindingIds');
    }
    for (const names of report.toolSets) {
      expect(names.sort()).toEqual(['read', 'submit_review_unit_result']);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 35_000);
