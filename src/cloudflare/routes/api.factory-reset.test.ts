import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import * as schema from '../../server/db/schema.js';
import { registerCoreApiRoutes } from './api.js';
import type { CloudflareHonoEnv } from '../shared/http.js';

function createEmptyCloudflareDb() {
  const resolveRows = (table: unknown): any[] => {
    if (table === schema.settings) return [];
    if (table === schema.sites) return [];
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

describe('cloudflare /api/settings/maintenance/factory-reset', () => {
  it('runs real reset flow and returns execution summary', async () => {
    const app = createTestApp();
    const request = new Request('https://metapi.test/api/settings/maintenance/factory-reset', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: '{}',
    });
    const response = await app.fetch(
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
    const payload = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.preservedSettings).toEqual(['auth_token']);
    expect(payload.seededSites).toBe(4);
  });
});
