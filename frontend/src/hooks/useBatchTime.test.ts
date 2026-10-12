import { describe, expect, it } from 'vitest';
import type { GenerationTask } from '../lib/api';
import { formatDuration, taskMs } from './useBatchTime';

const task = (patch: Partial<GenerationTask>): GenerationTask =>
  ({ status: 'completed', started_at: null, finished_at: null, ...patch }) as GenerationTask;

describe('batch time', () => {
  it('formats minutes and hours', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(7_400)).toBe('0:07');
    expect(formatDuration(65_000)).toBe('1:05');
    expect(formatDuration(3_729_000)).toBe('1:02:09');
    expect(formatDuration(-5)).toBe('0:00');
  });

  it('counts only the time a task actually ran', () => {
    const t0 = '2026-10-12T10:00:00+00:00';
    const t1 = '2026-10-12T10:00:30+00:00';
    const now = Date.parse('2026-10-12T10:05:00+00:00');
    expect(taskMs(task({ started_at: t0, finished_at: t1 }), now)).toBe(30_000);
    expect(taskMs(task({ status: 'running', started_at: t0 }), now)).toBe(300_000);
    // Queued, or interrupted without an end: nothing to count.
    expect(taskMs(task({ status: 'queued' }), now)).toBe(0);
    expect(taskMs(task({ status: 'interrupted', started_at: t0 }), now)).toBe(0);
  });
});
