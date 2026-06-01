import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import * as schema from '../../server/db/schema.js';
import { registerCoreApiRoutes } from './api.js';
import type { CloudflareHonoEnv } from '../shared/http.js';

function createNotifyTestDb(runtimeSettings: Record<string, unknown> | null) {
  const resolveRows = (table: unknown): any[] => {
    if (table === schema.settings) {
      if (!runtimeSettings) return [];
      return [{ value: JSON.stringify(runtimeSettings) }];
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

function createTestApp(runtimeSettings: Record<string, unknown> | null) {
  const app = new Hono<CloudflareHonoEnv>();
  const fakeDb = createNotifyTestDb(runtimeSettings);
  app.use('*', async (c, next) => {
    c.set('db', fakeDb as never);
    await next();
  });
  registerCoreApiRoutes(app);
  return app;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('cloudflare /api/settings/notify/test', () => {
  it('returns 400 when no notification channel is enabled', async () => {
    const app = createTestApp({});
    const request = new Request('https://metapi.test/api/settings/notify/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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
        waitUntil() {},
        passThroughOnException() {},
      } as never,
    );
    const payload = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(400);
    expect(payload.success).toBe(false);
    expect(String(payload.message || '')).toContain('未启用任何通知渠道');
  });

  it('sends webhook test notification when webhook is enabled', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const app = createTestApp({
      webhookEnabled: true,
      webhookUrl: 'https://notify.example.com/hook',
    });
    const request = new Request('https://metapi.test/api/settings/notify/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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
        waitUntil() {},
        passThroughOnException() {},
      } as never,
    );
    const payload = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.attempted).toBe(1);
    expect(payload.succeeded).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstUrl = fetchMock.mock.calls.at(0)?.at(0);
    expect(String(firstUrl || '')).toBe('https://notify.example.com/hook');
  });
});
