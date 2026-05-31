import { Hono } from 'hono';
import type { Context } from 'hono';
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

function normalizeNodeApiBaseUrl(raw: string | undefined): string {
  const value = (raw || '').trim();
  if (!value) return '';
  return value.replace(/\/+$/, '');
}

async function forwardToNodeRuntime(c: Context<CloudflareHonoEnv>) {
  const baseUrl = normalizeNodeApiBaseUrl(c.env.NODE_API_BASE_URL);
  if (!baseUrl) {
    return c.json(jsonNotImplemented('api-routes'), 501);
  }

  const requestUrl = new URL(c.req.url);
  const targetUrl = `${baseUrl}${requestUrl.pathname}${requestUrl.search}`;
  const headers = new Headers(c.req.raw.headers);
  headers.delete('host');
  headers.delete('content-length');

  const method = c.req.method.toUpperCase();
  const body = method === 'GET' || method === 'HEAD'
    ? undefined
    : c.req.raw.body;

  try {
    const response = await fetch(targetUrl, {
      method,
      headers,
      body,
      redirect: 'manual',
    });
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to reach Node runtime';
    return c.json({
      error: 'upstream_unavailable',
      message,
    }, 502);
  }
}

app.get('/api/cloudflare/health', async (c) => {
  const db = getCloudflareDb(c);
  const nodeApiBaseUrl = normalizeNodeApiBaseUrl(c.env.NODE_API_BASE_URL);
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
    nodeApiProxyConfigured: Boolean(nodeApiBaseUrl),
    apiProxyMode: nodeApiBaseUrl ? 'hybrid-node-proxy' : 'worker-only',
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
app.all('/api/*', (c) => forwardToNodeRuntime(c));
app.all('/monitor-proxy/*', (c) => forwardToNodeRuntime(c));

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
