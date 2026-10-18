import type { Router } from '../chttp/router';

export function registerSystemRoutes(router: Router): void {
  router.get('/api/ping', () => ({ pong: true, time: Date.now() }));
}
