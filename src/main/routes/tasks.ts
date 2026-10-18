import type { TaskInput } from '@shared/api';
import type { Router } from '../chttp/router';
import type { AutoImportScheduler } from '../tasks/auto-import';

export function registerTaskRoutes(router: Router, scheduler: AutoImportScheduler): void {
  router.get('/api/tasks', () => scheduler.list());
  router.put('/api/tasks', async (req) => {
    const body = await req.json<{ tasks?: TaskInput[] }>();
    return scheduler.sync(body?.tasks as TaskInput[]);
  });
}
