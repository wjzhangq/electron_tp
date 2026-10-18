import type { Router } from '../router';

export function registerSystemRoutes(router: Router): void {
  router.get('/api/ping', () => ({ pong: true, time: Date.now() }));
}
