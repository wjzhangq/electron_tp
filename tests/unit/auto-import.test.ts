import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutoImportScheduler } from '../../src/main/tasks/auto-import';
import type { TaskInput, TaskTick } from '../../src/shared/api';

const T0 = new Date('2026-01-01T00:00:00Z').getTime();

let ticks: TaskTick[];
let s: AutoImportScheduler;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  ticks = [];
  s = new AutoImportScheduler((t) => ticks.push(t));
});

afterEach(() => {
  s.dispose();
  vi.useRealTimers();
});

const expectCode = (fn: () => unknown, code: number, msg?: RegExp) => {
  try {
    fn();
  } catch (e) {
    expect((e as { code: number }).code).toBe(code);
    if (msg) expect((e as Error).message).toMatch(msg);
    return;
  }
  throw new Error('expected to throw');
};

describe('AutoImportScheduler validation (FR-TSK-1)', () => {
  it('rejects non-arrays, empty or duplicate ids and bad intervals with 3006', () => {
    expectCode(() => s.sync(undefined as unknown as TaskInput[]), 3006, /array/);
    expectCode(() => s.sync([{ id: '', intervalSec: 10, data: 1 }]), 3006, /id/);
    expectCode(() => s.sync([{ id: 1 as unknown as string, intervalSec: 10, data: 1 }]), 3006, /id/);
    expectCode(() => s.sync([null as unknown as TaskInput]), 3006, /id/);
    expectCode(
      () =>
        s.sync([
          { id: 'a', intervalSec: 10, data: 1 },
          { id: 'a', intervalSec: 20, data: 2 },
        ]),
      3006,
      /duplicate/,
    );
    expectCode(() => s.sync([{ id: 'a', intervalSec: 9, data: 1 }]), 3006, />= 10/);
    expectCode(() => s.sync([{ id: 'a', intervalSec: 10.5, data: 1 }]), 3006);
    expectCode(() => s.sync([{ id: 'a', intervalSec: '10' as unknown as number, data: 1 }]), 3006);
  });

  it('does not change existing tasks when validation fails', () => {
    s.sync([{ id: 'a', intervalSec: 10, data: 1 }]);
    expectCode(() => s.sync([{ id: 'b', intervalSec: 1, data: 1 }]), 3006);
    expect(s.list().map((t) => t.id)).toEqual(['a']);
  });
});

describe('AutoImportScheduler scheduling', () => {
  it('lists tasks with nextRunAt and emits ticks (FR-TSK-4/5)', () => {
    const state = s.sync([{ id: 'a', intervalSec: 10, data: { n: 1 } }]);
    expect(state).toEqual([{ id: 'a', intervalSec: 10, nextRunAt: T0 + 10_000 }]);
    vi.advanceTimersByTime(10_000);
    expect(ticks).toEqual([{ id: 'a', data: { n: 1 }, nextRunAt: T0 + 20_000 }]);
    expect(s.list()[0]!.nextRunAt).toBe(T0 + 20_000);
    vi.advanceTimersByTime(10_000);
    expect(ticks).toHaveLength(2);
  });

  it('replaces the full list: removes, creates and updates (FR-TSK-2)', () => {
    s.sync([
      { id: 'a', intervalSec: 10, data: 1 },
      { id: 'b', intervalSec: 10, data: 1 },
    ]);
    s.sync([
      { id: 'b', intervalSec: 10, data: 2 },
      { id: 'c', intervalSec: 20, data: 3 },
    ]);
    expect(s.list().map((t) => t.id)).toEqual(['b', 'c']);
    vi.advanceTimersByTime(20_000);
    expect(ticks.filter((t) => t.id === 'a')).toHaveLength(0);
    expect(ticks.filter((t) => t.id === 'b').map((t) => t.data)).toEqual([2, 2]);
    expect(ticks.filter((t) => t.id === 'c').map((t) => t.data)).toEqual([3]);
  });

  it('keeps timing when only data changes and restarts timing when interval changes (FR-TSK-3)', () => {
    s.sync([
      { id: 'same', intervalSec: 10, data: 'old' },
      { id: 'diff', intervalSec: 10, data: 'old' },
    ]);
    vi.advanceTimersByTime(6_000);
    const state = s.sync([
      { id: 'same', intervalSec: 10, data: 'new' },
      { id: 'diff', intervalSec: 20, data: 'new' },
    ]);
    expect(state.find((t) => t.id === 'same')!.nextRunAt).toBe(T0 + 10_000);
    expect(state.find((t) => t.id === 'diff')!.nextRunAt).toBe(T0 + 26_000);
    vi.advanceTimersByTime(4_000);
    expect(ticks).toEqual([{ id: 'same', data: 'new', nextRunAt: T0 + 20_000 }]);
    vi.advanceTimersByTime(16_000);
    expect(ticks.filter((t) => t.id === 'diff')).toEqual([{ id: 'diff', data: 'new', nextRunAt: T0 + 46_000 }]);
  });

  it('pauses all tasks on suspend and restarts from resume time without catching up (FR-TSK-7)', () => {
    s.sync([{ id: 'a', intervalSec: 10, data: 1 }]);
    vi.advanceTimersByTime(5_000);
    s.pauseAll();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000); // 睡眠期间不触发
    expect(ticks).toHaveLength(0);

    // 睡眠期间提交的任务也不计时
    s.sync([
      { id: 'a', intervalSec: 10, data: 1 },
      { id: 'b', intervalSec: 10, data: 2 },
    ]);
    expect(vi.getTimerCount()).toBe(0);

    s.restartAll();
    const resumeAt = T0 + 65_000;
    expect(s.list()).toEqual([
      { id: 'a', intervalSec: 10, nextRunAt: resumeAt + 10_000 },
      { id: 'b', intervalSec: 10, nextRunAt: resumeAt + 10_000 },
    ]);
    expect(ticks).toHaveLength(0); // 不立即触发、不补发
    vi.advanceTimersByTime(9_999);
    expect(ticks).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(ticks.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('restartAll without pause also restarts timing from now', () => {
    s.sync([{ id: 'a', intervalSec: 10, data: 1 }]);
    vi.advanceTimersByTime(7_000);
    s.restartAll();
    expect(s.list()[0]!.nextRunAt).toBe(T0 + 17_000);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('dispose clears every timer', () => {
    s.sync([
      { id: 'a', intervalSec: 10, data: 1 },
      { id: 'b', intervalSec: 30, data: 1 },
    ]);
    s.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(s.list()).toEqual([]);
  });

  it('honours a custom minimum interval', () => {
    const fast = new AutoImportScheduler(() => {}, 1);
    expect(() => fast.sync([{ id: 'a', intervalSec: 1, data: 1 }])).not.toThrow();
    fast.dispose();
  });
});
