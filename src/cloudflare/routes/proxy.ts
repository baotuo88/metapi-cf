import { Hono } from 'hono';
import {
  getCloudflareDb,
  type CloudflareHonoEnv,
} from '../shared/http.js';
import { authorizeCloudflareProxyRequest } from '../proxy/auth.js';
import { forwardCloudflareProxyRequest } from '../proxy/runtime.js';

export function registerProxyRoutes(app: Hono<CloudflareHonoEnv>) {
  app.all('/v1/*', async (c) => {
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
    });
  });
}
