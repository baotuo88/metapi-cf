import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import * as schema from '../../server/db/schema.js';
import { registerCoreApiRoutes } from './api.js';
import type { CloudflareHonoEnv } from '../shared/http.js';

function createEmptyCloudflareDb() {
  const resolveRows = (table: unknown): any[] => {
    if (
      table === schema.settings
      || table === schema.tokenModelAvailability
      || table === schema.modelAvailability
      || table === schema.siteDisabledModels
      || table === schema.tokenRoutes
      || table === schema.routeChannels
      || table === schema.accountTokens
      || table === schema.oauthRouteUnitMembers
      || table === schema.oauthRouteUnits
      || table === schema.accounts
      || table === schema.sites
    ) {
      return [];
    }
    return [];
  };

  const makeSelectBuilder = () => {
    let table: unknown = null;
    const builder: any = {
      from(nextTable: unknown) {
        table = nextTable;
        return builder;
      },
      innerJoin() {
        return builder;
      },
      leftJoin() {
        return builder;
      },
      where() {
        return builder;
      },
      groupBy() {
        return builder;
      },
      orderBy() {
        return builder;
      },
      limit() {
        return builder;
      },
      offset() {
        return builder;
      },
      async all() {
        return resolveRows(table);
      },
      async get() {
        const rows = resolveRows(table);
        return rows[0];
      },
    };
    return builder;
  };

  return {
    select() {
      return makeSelectBuilder();
    },
    update() {
      return {
        set() {
          return {
            where() {
              return {
                async run() {
                  return { changes: 0 };
                },
              };
            },
            async run() {
              return { changes: 0 };
            },
          };
        },
      };
    },
    insert() {
      return {
        values() {
          return {
            onConflictDoUpdate() {
              return {
                async run() {
                  return { changes: 0 };
                },
              };
            },
            onConflictDoNothing() {
              return {
                async run() {
                  return { changes: 0 };
                },
              };
            },
            returning() {
              return {
                async get() {
                  return undefined;
                },
              };
            },
            async run() {
              return { changes: 0 };
            },
          };
        },
      };
    },
    delete() {
      return {
        where() {
          return {
            returning() {
              return {
                async get() {
                  return undefined;
                },
              };
            },
            async run() {
              return { changes: 0 };
            },
          };
        },
        async run() {
          return { changes: 0 };
        },
      };
    },
  };
}

function createTestApp() {
  const app = new Hono<CloudflareHonoEnv>();
  const fakeDb = createEmptyCloudflareDb();
  app.use('*', async (c, next) => {
    c.set('db', fakeDb as never);
    await next();
  });
  registerCoreApiRoutes(app);
  return app;
}

async function postJson(app: Hono<CloudflareHonoEnv>, path: string, body: unknown) {
  const request = new Request(`https://metapi.test${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return app.fetch(
    request,
    {
      METAPI_DB: {} as never,
      METAPI_FILES: {} as never,
      AUTH_TOKEN: '',
      PROXY_TOKEN: '',
    },
    {
      waitUntil() {
        // no-op for tests
      },
      passThroughOnException() {
        // no-op for tests
      },
    } as never,
  );
}

describe('cloudflare /api/routes/rebuild', () => {
  it('rebuilds routes only when refreshModels is false', async () => {
    const app = createTestApp();
    const response = await postJson(app, '/api/routes/rebuild', { refreshModels: false });
    const payload = await response.json() as Record<string, any>;

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.queued).toBe(false);
    expect(payload.rebuild).toMatchObject({
      models: 0,
      createdRoutes: 0,
      createdChannels: 0,
      removedChannels: 0,
      removedRoutes: 0,
    });
  });

  it('runs refresh + rebuild synchronously when wait is true', async () => {
    const app = createTestApp();
    const response = await postJson(app, '/api/routes/rebuild', { refreshModels: true, wait: true });
    const payload = await response.json() as Record<string, any>;

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(Array.isArray(payload.refresh)).toBe(true);
    expect(payload.refresh).toHaveLength(0);
    expect(payload.rebuild).toMatchObject({
      models: 0,
      createdRoutes: 0,
      createdChannels: 0,
      removedChannels: 0,
      removedRoutes: 0,
    });
  });

  it('queues an async task when refreshModels is enabled without wait', async () => {
    const app = createTestApp();
    const response = await postJson(app, '/api/routes/rebuild', { refreshModels: true });
    const payload = await response.json() as Record<string, any>;

    expect(response.status).toBe(202);
    expect(payload.success).toBe(true);
    expect(payload.queued).toBe(true);
    expect(typeof payload.reused).toBe('boolean');
    expect(typeof payload.jobId).toBe('string');
    expect(payload.jobId.length).toBeGreaterThan(0);
    expect(payload.taskId).toBe(payload.jobId);
  });
});
