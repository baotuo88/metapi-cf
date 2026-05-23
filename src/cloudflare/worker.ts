import { Hono } from 'hono';
import { createD1Db } from './db/d1.js';
import type { CloudflareEnv } from './env.js';
import { settings } from '../server/db/schema.js';

type HonoBindings = {
  Bindings: CloudflareEnv;
};

const app = new Hono<HonoBindings>();

function jsonNotImplemented(feature: string) {
  return {
    error: 'not_implemented',
    feature,
    message: 'This Cloudflare Worker entry is a migration skeleton. The Fastify route has not been ported yet.',
  };
}

app.get('/api/cloudflare/health', async (c) => {
  const db = createD1Db(c.env.METAPI_DB);
  const settingsProbe = await db
    .select()
    .from(settings)
    .limit(1)
    .all()
    .then(() => true, () => false);

  return c.json({
    ok: true,
    runtime: 'cloudflare-worker',
    environment: c.env.ENVIRONMENT || 'development',
    bindings: {
      d1: Boolean(c.env.METAPI_DB),
      r2: Boolean(c.env.METAPI_FILES),
    },
    probes: {
      d1SchemaReadable: settingsProbe,
    },
  });
});

app.all('/api/*', (c) => c.json(jsonNotImplemented('api-routes'), 501));
app.all('/v1/*', (c) => c.json(jsonNotImplemented('openai-compatible-proxy'), 501));
app.all('/monitor-proxy/*', (c) => c.json(jsonNotImplemented('monitor-proxy'), 501));

app.notFound((c) => c.json({
  error: 'not_found',
  message: 'Cloudflare Worker route not found.',
}, 404));

const handler: ExportedHandler<CloudflareEnv> = {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
  scheduled: async (_controller, env, ctx) => {
    ctx.waitUntil(Promise.resolve(env));
  },
};

export default handler;
