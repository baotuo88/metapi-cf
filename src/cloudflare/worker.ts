import { Hono } from 'hono';
import type { CloudflareEnv } from './env.js';
import { settings } from '../server/db/schema.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerCoreApiRoutes } from './routes/api.js';
import { registerProxyRoutes } from './routes/proxy.js';
import {
  getCloudflareDb,
  isPublicCloudflareApiRoute,
  jsonNotImplemented,
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
registerProxyRoutes(app);

// Fallbacks for unported subsystems
app.all('/api/*', (c) => c.json(jsonNotImplemented('api-routes'), 501));
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
