import { sql } from 'drizzle-orm';
import type { FastifyPluginCallback } from 'fastify';
import type { ApiDeps } from '../app.ts';

/** Liveness for the reverse proxy and process supervisor. Says nothing about the game. */
export const healthRoutes: FastifyPluginCallback<{ deps: ApiDeps }> = (app, { deps }, done) => {
  app.get('/api/health', { config: { access: 'public' } }, async (_request, reply) => {
    try {
      await deps.ctx.db.execute(sql`SELECT 1`);
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });
  done();
};
