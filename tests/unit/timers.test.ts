import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Timers } from '../../src/main/timers';
import type { TimerInput, TimerTick } from '../../src/shared/ipc';

const T0 = new Date('2026-01-01T00:00:00Z').getTime();

let ticks: Array<[number, TimerTick]>;
let t: Timers;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  ticks = [];
  t = new Timers((owner, tick) => ticks.push([owner, tick]));
});

afterEach(() => {
  t.dispose();
  vi.useRealTimers();
});

describe('Timers validation', () => {
  it('rejects empty ids and non-positive or non-integer intervals', () => {
    expect(() => t.set(1, { id: '', intervalSec: 10 })).toThrow(/id/);
    expect(() => t.set(1, { id: 1 as unknown as string, intervalSec: 10 })).toThrow(/id/);
    expect(() => t.set(1, null as unknown as TimerInput)).toThrow(/id/);
    expect(() => t.set(1, { id: 'a', intervalSec: 0 })).toThrow(/>= 1/);
    expect(() => t.set(1, { id: 'a', intervalSec: 1.5 })).toThrow(/integer/);
    expect(() => t.set(1, { id: 'a', intervalSec: '10' as unknown as number })).toThrow(/integer/);
    expect(t.list(1)).toEqual([]);
  });

  it('does not impose a business minimum, only a configurable technical one', () => {
    expect(() => t.set(1, { id: 'a', intervalSec: 1 })).not.toThrow();
    const strict = new Timers(() => {}, 30);
    expect(() => strict.set(1, { id: 'a', intervalSec: 29 })).toThrow(/>= 30/);
    strict.dispose();
  });
});

describe('Timers scheduling', () => {
  it('notifies the owner on every interval with nextRunAt', () => {
    expect(t.set(7, { id: 'a', intervalSec: 10, data: { n: 1 } })).toEqual({
      id: 'a',
      intervalSec: 10,
      nextRunAt: T0 + 10_000,
    });
    vi.advanceTimersByTime(10_000);
    expect(ticks).toEqual([[7, { id: 'a', data: { n: 1 }, nextRunAt: T0 + 20_000 }]]);
    expect(t.list(7)[0]!.nextRunAt).toBe(T0 + 20_000);
    vi.advanceTimersByTime(10_000);
    expect(ticks).toHaveLength(2);
  });

  it('isolates owners: same id under different owners are independent', () => {
    t.set(1, { id: 'sync', intervalSec: 10, data: 'one' });
    t.set(2, { id: 'sync', intervalSec: 20, data: 'two' });
    expect(t.list(1)).toEqual([{ id: 'sync', intervalSec: 10, nextRunAt: T0 + 10_000 }]);
    expect(t.list(2)).toEqual([{ id: 'sync', intervalSec: 20, nextRunAt: T0 + 20_000 }]);
    t.clearOwner(1);
    vi.advanceTimersByTime(20_000);
    expect(ticks).toEqual([[2, { id: 'sync', data: 'two', nextRunAt: T0 + 40_000 }]]);
    expect(t.list(1)).toEqual([]);
  });

  it('keeps timing when only data changes and restarts timing when interval changes', () => {
    t.set(1, { id: 'same', intervalSec: 10, data: 'old' });
    t.set(1, { id: 'diff', intervalSec: 10, data: 'old' });
    vi.advanceTimersByTime(6_000);
    expect(t.set(1, { id: 'same', intervalSec: 10, data: 'new' }).nextRunAt).toBe(T0 + 10_000);
    expect(t.set(1, { id: 'diff', intervalSec: 20, data: 'new' }).nextRunAt).toBe(T0 + 26_000);
    vi.advanceTimersByTime(4_000);
    expect(ticks).toEqual([[1, { id: 'same', data: 'new', nextRunAt: T0 + 20_000 }]]);
    vi.advanceTimersByTime(16_000);
    expect(ticks.filter(([, k]) => k.id === 'diff')).toEqual([
      [1, { id: 'diff', data: 'new', nextRunAt: T0 + 46_000 }],
    ]);
  });

  it('clear removes one timer and ignores unknown ids', () => {
    t.set(1, { id: 'a', intervalSec: 10 });
    t.set(1, { id: 'b', intervalSec: 10 });
    t.clear(1, 'a');
    t.clear(1, 'missing');
    t.clear(99, 'a');
    expect(t.list(1).map((s) => s.id)).toEqual(['b']);
    t.clear(1, 'b');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('pauses on suspend and restarts from resume time without catching up', () => {
    t.set(1, { id: 'a', intervalSec: 10 });
    vi.advanceTimersByTime(5_000);
    t.pauseAll();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(ticks).toHaveLength(0);

    // 睡眠期间设置的定时器也不计时
    t.set(2, { id: 'b', intervalSec: 10 });
    expect(vi.getTimerCount()).toBe(0);

    t.resumeAll();
    const resumeAt = T0 + 65_000;
    expect(t.list(1)).toEqual([{ id: 'a', intervalSec: 10, nextRunAt: resumeAt + 10_000 }]);
    expect(t.list(2)).toEqual([{ id: 'b', intervalSec: 10, nextRunAt: resumeAt + 10_000 }]);
    vi.advanceTimersByTime(9_999);
    expect(ticks).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(ticks.map(([o, k]) => `${o}:${k.id}`)).toEqual(['1:a', '2:b']);
  });

  it('dispose clears every timer of every owner', () => {
    t.set(1, { id: 'a', intervalSec: 10 });
    t.set(2, { id: 'b', intervalSec: 30 });
    t.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(t.list(1)).toEqual([]);
    expect(t.list(2)).toEqual([]);
  });
});
