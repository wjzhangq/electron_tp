import { ApiError, Codes, type TaskInput, type TaskState, type TaskTick } from '@shared/api';

interface Entry {
  intervalSec: number;
  data: unknown;
  nextRunAt: number;
  timer?: NodeJS.Timeout;
}

export class AutoImportScheduler {
  private readonly tasks = new Map<string, Entry>();
  private paused = false;

  constructor(
    private readonly onTick: (tick: TaskTick) => void,
    private readonly minIntervalSec = 10,
  ) {}

  sync(list: TaskInput[]): TaskState[] {
    this.validate(list);
    const ids = new Set(list.map((t) => t.id));
    for (const id of [...this.tasks.keys()]) if (!ids.has(id)) this.remove(id);

    for (const t of list) {
      const cur = this.tasks.get(t.id);
      if (cur && cur.intervalSec === t.intervalSec) {
        cur.data = t.data; // 间隔不变：只更新数据，不重新计时
        continue;
      }
      if (cur) this.remove(t.id);
      const entry: Entry = { intervalSec: t.intervalSec, data: t.data, nextRunAt: 0 };
      this.tasks.set(t.id, entry);
      this.schedule(t.id, entry);
    }
    return this.list();
  }

  list(): TaskState[] {
    return [...this.tasks].map(([id, e]) => ({ id, intervalSec: e.intervalSec, nextRunAt: e.nextRunAt }));
  }

  /** FR-TSK-7：系统睡眠时暂停全部任务 */
  pauseAll(): void {
    this.paused = true;
    for (const e of this.tasks.values()) {
      clearInterval(e.timer);
      e.timer = undefined;
    }
  }

  /** FR-TSK-7：系统恢复时从当前时刻重新计时，不补发、不立即触发 */
  restartAll(): void {
    this.paused = false;
    for (const [id, e] of this.tasks) {
      clearInterval(e.timer);
      this.schedule(id, e);
    }
  }

  dispose(): void {
    for (const id of [...this.tasks.keys()]) this.remove(id);
  }

  private schedule(id: string, e: Entry): void {
    const ms = e.intervalSec * 1000;
    e.nextRunAt = Date.now() + ms;
    if (this.paused) return; // 睡眠期间提交的任务等 resume 时再计时
    e.timer = setInterval(() => {
      e.nextRunAt = Date.now() + ms;
      this.onTick({ id, data: e.data, nextRunAt: e.nextRunAt });
    }, ms);
  }

  private remove(id: string): void {
    const e = this.tasks.get(id);
    if (e) clearInterval(e.timer);
    this.tasks.delete(id);
  }

  private validate(list: unknown): asserts list is TaskInput[] {
    if (!Array.isArray(list)) throw new ApiError(Codes.PARAM_INVALID, 'tasks must be an array');
    const seen = new Set<string>();
    for (const t of list as Partial<TaskInput>[]) {
      if (typeof t?.id !== 'string' || !t.id) throw new ApiError(Codes.PARAM_INVALID, 'task.id is required');
      if (seen.has(t.id)) throw new ApiError(Codes.PARAM_INVALID, `duplicate task id: ${t.id}`);
      if (!Number.isInteger(t.intervalSec) || (t.intervalSec as number) < this.minIntervalSec) {
        throw new ApiError(Codes.PARAM_INVALID, `task.intervalSec must be an integer >= ${this.minIntervalSec}`);
      }
      seen.add(t.id);
    }
  }
}
