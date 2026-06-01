import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import * as schema from '../../server/db/schema.js';
import { registerCoreApiRoutes } from './api.js';
import type { CloudflareHonoEnv } from '../shared/http.js';

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createAnnouncementTestDb() {
  const siteRows = [
    {
      id: 101,
      name: 'Site A',
      url: 'https://site-a.example.com',
      status: 'active',
      platform: 'newapi',
      apiKey: '',
      customHeaders: null,
    },
    {
      id: 202,
      name: 'Site B',
      url: 'https://site-b.example.com',
      status: 'active',
      platform: 'newapi',
      apiKey: '',
      customHeaders: null,
    },
    {
      id: 303,
      name: 'Site C',
      url: 'https://site-c.example.com',
      status: 'active',
      platform: 'newapi',
      apiKey: '',
      customHeaders: null,
    },
    {
      id: 404,
      name: 'Site D',
      url: 'https://site-d.example.com',
      status: 'active',
      platform: 'newapi',
      apiKey: '',
      customHeaders: null,
    },
  ];

  const accountRows = [
    {
      id: 1,
      siteId: 101,
      status: 'active',
      accessToken: 'token-a',
      apiToken: null,
      username: 'user-101',
      extraConfig: null,
    },
    {
      id: 2,
      siteId: 202,
      status: 'active',
      accessToken: 'token-b',
      apiToken: null,
      username: 'user-202',
      extraConfig: null,
    },
    {
      id: 3,
      siteId: 303,
      status: 'active',
      accessToken: 'token-c',
      apiToken: null,
      username: 'user-303',
      extraConfig: null,
    },
    {
      id: 4,
      siteId: 404,
      status: 'active',
      accessToken: 'token-d',
      apiToken: null,
      username: 'user-404',
      extraConfig: null,
    },
  ];

  const resolveRows = (table: unknown): any[] => {
    if (table === schema.sites) return siteRows;
    if (table === schema.accounts) return accountRows;
    if (table === schema.siteApiEndpoints) return [];
    if (table === schema.siteAnnouncements) return [];
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
  const fakeDb = createAnnouncementTestDb();
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('cloudflare /api/site-announcements/sync', () => {
  it('reuses a running task with the same site dedupe key', async () => {
    const gate = createDeferred<void>();
    vi.stubGlobal('fetch', vi.fn(async () => {
      await gate.promise;
      return new Response(JSON.stringify({ data: 'notice' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));

    const app = createTestApp();
    const first = await postJson(app, '/api/site-announcements/sync', { siteId: 101 });
    const firstPayload = await first.json() as Record<string, unknown>;

    const second = await postJson(app, '/api/site-announcements/sync', { siteId: 101 });
    const secondPayload = await second.json() as Record<string, unknown>;

    expect(first.status).toBe(200);
    expect(firstPayload.success).toBe(true);
    expect(firstPayload.queued).toBe(true);
    expect(firstPayload.reused).toBe(false);
    expect(typeof firstPayload.taskId).toBe('string');

    expect(second.status).toBe(200);
    expect(secondPayload.success).toBe(true);
    expect(secondPayload.queued).toBe(true);
    expect(secondPayload.reused).toBe(true);
    expect(secondPayload.taskId).toBe(firstPayload.taskId);

    gate.resolve();
  });

  it('does not reuse a running task when dedupe key differs', async () => {
    const gate = createDeferred<void>();
    vi.stubGlobal('fetch', vi.fn(async () => {
      await gate.promise;
      return new Response(JSON.stringify({ data: 'notice' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));

    const app = createTestApp();
    const first = await postJson(app, '/api/site-announcements/sync', { siteId: 303 });
    const firstPayload = await first.json() as Record<string, unknown>;

    const second = await postJson(app, '/api/site-announcements/sync', { siteId: 404 });
    const secondPayload = await second.json() as Record<string, unknown>;

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(firstPayload.reused).toBe(false);
    expect(secondPayload.reused).toBe(false);
    expect(typeof firstPayload.taskId).toBe('string');
    expect(typeof secondPayload.taskId).toBe('string');
    expect(secondPayload.taskId).not.toBe(firstPayload.taskId);

    gate.resolve();
  });
});
