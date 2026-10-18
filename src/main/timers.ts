// 不依赖 electron：主进程定时器，到点通知所属页面。
// 只保存在内存中，按页面（webContents）隔离；页面导航或销毁时由调用方 clearOwner。
// 业务语义（名称、最小间隔、持久化）不在壳里规定，minIntervalSec 只防止误用造成的忙循环。
import type { TimerInput, TimerState, TimerTick } from '@shared/ipc';

interface Entry {
  intervalSec: number;
  data: unknown;
  nextRunAt: number;
  timer?: NodeJS.Timeout;
}

export class Timers {
  private readonly owners = new Map<number, Map<string, Entry>>();
  private paused = false;

  constructor(
    private readonly notify: (owner: number, tick: TimerTick) => void,
    private readonly minIntervalSec = 1,
  ) {}

  /** 新建或更新；间隔不变时只替换 data，不重新计时 */
  set(owner: number, input: TimerInput): TimerState {
    this.validate(input);
    let timers = this.owners.get(owner);
    if (!timers) this.owners.set(owner, (timers = new Map()));
    const cur = timers.get(input.id);
    if (cur && cur.intervalSec === input.intervalSec) {
      cur.data = input.data;
      return this.state(input.id, cur);
    }
    if (cur) clearInterval(cur.timer);
    const entry: Entry = { intervalSec: input.intervalSec, data: input.data, nextRunAt: 0 };
    timers.set(input.id, entry);
    this.schedule(owner, input.id, entry);
    return this.state(input.id, entry);
  }

  clear(owner: number, id: string): void {
    const timers = this.owners.get(owner);
    const e = timers?.get(id);
    if (!timers || !e) return;
    clearInterval(e.timer);
    timers.delete(id);
    if (timers.size === 0) this.owners.delete(owner);
  }

  clearOwner(owner: number): void {
    for (const e of this.owners.get(owner)?.values() ?? []) clearInterval(e.timer);
    this.owners.delete(owner);
  }

  list(owner: number): TimerState[] {
    return [...(this.owners.get(owner) ?? [])].map(([id, e]) => this.state(id, e));
  }

  /** 系统睡眠时暂停全部定时器 */
  pauseAll(): void {
    this.paused = true;
    for (const [, , e] of this.entries()) {
      clearInterval(e.timer);
      e.timer = undefined;
    }
  }

  /** 系统恢复时从当前时刻重新计时，不补发、不立即触发 */
  resumeAll(): void {
    this.paused = false;
    for (const [owner, id, e] of this.entries()) {
      clearInterval(e.timer);
      this.schedule(owner, id, e);
    }
  }

  dispose(): void {
    for (const owner of [...this.owners.keys()]) this.clearOwner(owner);
  }

  private *entries(): Generator<[number, string, Entry]> {
    for (const [owner, timers] of this.owners) for (const [id, e] of timers) yield [owner, id, e];
  }

  private state(id: string, e: Entry): TimerState {
    return { id, intervalSec: e.intervalSec, nextRunAt: e.nextRunAt };
  }

  private schedule(owner: number, id: string, e: Entry): void {
    const ms = e.intervalSec * 1000;
    e.nextRunAt = Date.now() + ms;
    if (this.paused) return; // 睡眠期间设置的定时器等恢复时再计时
    e.timer = setInterval(() => {
      e.nextRunAt = Date.now() + ms;
      this.notify(owner, { id, data: e.data, nextRunAt: e.nextRunAt });
    }, ms);
  }

  private validate(input: unknown): asserts input is TimerInput {
    const t = input as Partial<TimerInput> | null;
    if (typeof t?.id !== 'string' || !t.id) throw new Error('timer.id must be a non-empty string');
    if (!Number.isInteger(t.intervalSec) || (t.intervalSec as number) < this.minIntervalSec) {
      throw new Error(`timer.intervalSec must be an integer >= ${this.minIntervalSec}`);
    }
  }
}
