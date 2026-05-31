import { Hono } from 'hono';
import type { CloudflareEnv } from './env.js';
import { settings } from '../server/db/schema.js';
import { ensureD1Bootstrap } from './db/d1.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerCoreApiRoutes } from './routes/api.js';
import { registerMonitorRoutes } from './routes/monitor.js';
import { registerProxyRoutes } from './routes/proxy.js';
import {
  getCloudflareDb,
  isPublicCloudflareApiRoute,
  requireAdminAuth,
  type CloudflareHonoEnv,
} from './shared/http.js';

const app = new Hono<CloudflareHonoEnv>();

app.get('/api/cloudflare/health', async (c) => {
  const db = getCloudflareDb(c);
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
    nodeApiProxyConfigured: false,
    apiProxyMode: 'worker-only',
    probes: {
      d1SchemaReadable: settingsProbe,
    },
  });
});

app.use('/api/*', async (c, next) => {
  if (isPublicCloudflareApiRoute(new URL(c.req.url).pathname)) {
    await next();
    return;
  }
  return requireAdminAuth(c, next);
});

// Mount the newly migrated active routes
registerAuthRoutes(app);
registerCoreApiRoutes(app);
registerMonitorRoutes(app);
registerProxyRoutes(app);

app.notFound((c) => c.json({
  error: 'not_found',
  message: 'Cloudflare Worker route not found.',
}, 404));

const handler: ExportedHandler<CloudflareEnv> = {
  fetch: async (request, env, ctx) => {
    await ensureD1Bootstrap(env.METAPI_DB);
    return app.fetch(request, env, ctx);
  },
  scheduled: async (_controller, env, ctx) => {
    await ensureD1Bootstrap(env.METAPI_DB);
    ctx.waitUntil(Promise.resolve(env));
  },
};

export default handler;
