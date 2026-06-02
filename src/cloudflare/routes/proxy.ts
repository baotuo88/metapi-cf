import { Hono, type Context } from 'hono';
import {
  getCloudflareDb,
  type CloudflareHonoEnv,
} from '../shared/http.js';
import { authorizeCloudflareProxyRequest } from '../proxy/auth.js';
import { forwardCloudflareProxyRequest } from '../proxy/runtime.js';

function resolveAliasedResponsesDownstreamPath(pathname: string): '/v1/responses' | '/v1/responses/compact' | null {
  if (pathname === '/responses') return '/v1/responses';
  return pathname.endsWith('/compact') ? '/v1/responses/compact' : null;
}

export function registerProxyRoutes(app: Hono<CloudflareHonoEnv>) {
  const handleProxyRequest = async (c: Context<CloudflareHonoEnv>, pathOverride?: string) => {
    const db = getCloudflareDb(c);
    const auth = await authorizeCloudflareProxyRequest({
      db,
      envProxyToken: c.env.PROXY_TOKEN,
      request: {
        header: (name: string) => c.req.header(name),
        query: (name: string) => c.req.query(name),
      },
    });

    if (!auth.ok) {
      return c.json({
        error: {
          message: auth.error,
          type: auth.status === 401 ? 'authentication_error' : 'permission_error',
        },
      }, auth.status as never);
    }

    c.set('proxyAuth', auth.context);
    return await forwardCloudflareProxyRequest({
      c,
      db,
      auth: auth.context,
      pathOverride,
    });
  };

  app.all('/v1/*', async (c) => handleProxyRequest(c));

  app.post('/chat/completions', async (c) => handleProxyRequest(c, '/v1/chat/completions'));

  app.post('/responses', async (c) => handleProxyRequest(c, '/v1/responses'));
  app.post('/responses/*', async (c) => {
    const downstreamPath = resolveAliasedResponsesDownstreamPath(new URL(c.req.url).pathname);
    if (!downstreamPath) {
      return c.json({
        error: {
          message: 'Unknown /responses alias path',
          type: 'invalid_request_error',
        },
      }, 404);
    }
    return handleProxyRequest(c, downstreamPath);
  });
  app.get('/responses', async (c) => handleProxyRequest(c, '/v1/responses'));
  app.get('/responses/*', async (c) => {
    const downstreamPath = resolveAliasedResponsesDownstreamPath(new URL(c.req.url).pathname);
    if (!downstreamPath) {
      return c.json({
        error: {
          message: 'Unknown /responses alias path',
          type: 'invalid_request_error',
        },
      }, 404);
    }
    return handleProxyRequest(c, downstreamPath);
  });
}
