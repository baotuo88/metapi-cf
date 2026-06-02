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

function createModelsProbeDb(options?: { accountId?: number; joinDelay?: Promise<void> }) {
  const account = {
    id: options?.accountId || 77,
    siteId: 11,
    username: 'probe-user',
    accessToken: 'sk-probe',
    apiToken: null,
    status: 'active',
    extraConfig: null,
  };
  const site = {
    id: 11,
    name: 'Probe Site',
    url: 'https://upstream.example.com',
    platform: 'openai',
    status: 'active',
    apiKey: null,
    customHeaders: null,
  };
  const insertedModels: string[] = [];

  const makeSelectBuilder = () => {
    let table: unknown = null;
    let joined = false;
    const builder: any = {
      from(nextTable: unknown) {
        table = nextTable;
        return builder;
      },
      innerJoin() {
        joined = true;
        return builder;
      },
      leftJoin() {
        joined = true;
        return builder;
      },
      where() {
        return builder;
      },
      orderBy() {
        return builder;
      },
      limit() {
        return builder;
      },
      async all() {
        if (table === schema.accounts && joined) {
          if (options?.joinDelay) await options.joinDelay;
          return [{ account, site }];
        }
        if (table === schema.siteApiEndpoints) return [];
        return [];
      },
      async get() {
        return undefined;
      },
    };
    return builder;
  };

  return {
    insertedModels,
    select() {
      return makeSelectBuilder();
    },
    delete() {
      return {
        where() {
          return {
            async run() {
              return { changes: 0 };
            },
          };
        },
      };
    },
    insert(table?: unknown) {
      return {
        values(payload?: Record<string, unknown>) {
          if (table === schema.modelAvailability && typeof payload?.modelName === 'string') {
            insertedModels.push(payload.modelName);
          }
          return {
            onConflictDoUpdate() {
              return {
                async run() {
                  return { changes: 1 };
                },
              };
            },
            async run() {
              return { changes: 1 };
            },
          };
        },
      };
    },
  };
}

function createTestApp(db: ReturnType<typeof createModelsProbeDb>) {
  const app = new Hono<CloudflareHonoEnv>();
  app.use('*', async (c, next) => {
    c.set('db', db as never);
    await next();
  });
  registerCoreApiRoutes(app);
  return app;
}

async function postJson(app: Hono<CloudflareHonoEnv>, path: string, body: unknown) {
  return app.fetch(
    new Request(`https://metapi.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
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
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('cloudflare models probe route', () => {
  it('runs model probe synchronously when wait is true', async () => {
    const db = createModelsProbeDb({ accountId: 77 });
    const app = createTestApp(db);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 'gpt-probe-a' }, { id: 'gpt-probe-b' }],
    }))));

    const response = await postJson(app, '/api/models/probe', {
      accountId: 77,
      wait: true,
    });
    const payload = await response.json() as {
      success?: boolean;
      queued?: boolean;
      summary?: { totalAccounts?: number; supported?: number; scanned?: number };
    };

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.queued).toBe(false);
    expect(payload.summary?.totalAccounts).toBe(1);
    expect(payload.summary?.supported).toBe(2);
    expect(payload.summary?.scanned).toBe(2);
    expect(db.insertedModels).toEqual(['gpt-probe-a', 'gpt-probe-b']);
  });

  it('queues model probe when wait is not requested', async () => {
    const gate = createDeferred<void>();
    const db = createModelsProbeDb({ accountId: 88, joinDelay: gate.promise });
    const app = createTestApp(db);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 'gpt-queued' }],
    }))));

    const response = await postJson(app, '/api/models/probe', { accountId: 88 });
    const payload = await response.json() as {
      success?: boolean;
      queued?: boolean;
      reused?: boolean;
      jobId?: string;
      taskId?: string;
      status?: string;
    };

    expect(response.status).toBe(202);
    expect(payload.success).toBe(true);
    expect(payload.queued).toBe(true);
    expect(payload.reused).toBe(false);
    expect(typeof payload.jobId).toBe('string');
    expect(payload.taskId).toBe(payload.jobId);
    expect(payload.status).toBe('running');

    gate.resolve();
  });

  it('rejects non-object probe payloads', async () => {
    const db = createModelsProbeDb();
    const app = createTestApp(db);

    const response = await postJson(app, '/api/models/probe', ['bad']);
    const payload = await response.json() as { success?: boolean; message?: string };

    expect(response.status).toBe(400);
    expect(payload.success).toBe(false);
    expect(payload.message).toContain('请求体必须是对象');
  });
});
