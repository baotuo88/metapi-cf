import { describe, expect, it } from 'vitest';
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

function createSyncAllTestDb(options?: { joinDelay?: Promise<void> }) {
  const resolveRows = async (table: unknown, joined: boolean): Promise<any[]> => {
    if (joined && table === schema.accounts) {
      if (options?.joinDelay) await options.joinDelay;
      return [];
    }
    if (table === schema.accountTokens) return [];
    if (table === schema.accounts) return [];
    if (table === schema.sites) return [];
    return [];
  };

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
        return resolveRows(table, joined);
      },
      async get() {
        const rows = await resolveRows(table, joined);
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

function createTestApp(db: ReturnType<typeof createSyncAllTestDb>) {
  const app = new Hono<CloudflareHonoEnv>();
  app.use('*', async (c, next) => {
    c.set('db', db as never);
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

describe('cloudflare /api/account-tokens/sync-all', () => {
  it('returns sync summary when wait=true', async () => {
    const app = createTestApp(createSyncAllTestDb());
    const response = await postJson(app, '/api/account-tokens/sync-all', { wait: true });
    const payload = await response.json() as Record<string, any>;

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.queued).toBe(false);
    expect(payload.summary).toMatchObject({
      synced: 0,
      skipped: 0,
      failed: 0,
    });
    expect(Array.isArray(payload.results)).toBe(true);
    expect(payload.results).toHaveLength(0);
  });

  it('queues async task and reuses in-flight sync-all task', async () => {
    const gate = createDeferred<void>();
    const app = createTestApp(createSyncAllTestDb({ joinDelay: gate.promise }));

    const first = await postJson(app, '/api/account-tokens/sync-all', {});
    const firstPayload = await first.json() as Record<string, any>;
    const second = await postJson(app, '/api/account-tokens/sync-all', {});
    const secondPayload = await second.json() as Record<string, any>;

    expect(first.status).toBe(202);
    expect(firstPayload.success).toBe(true);
    expect(firstPayload.queued).toBe(true);
    expect(firstPayload.reused).toBe(false);
    expect(typeof firstPayload.jobId).toBe('string');
    expect(firstPayload.taskId).toBe(firstPayload.jobId);

    expect(second.status).toBe(202);
    expect(secondPayload.success).toBe(true);
    expect(secondPayload.queued).toBe(true);
    expect(secondPayload.reused).toBe(true);
    expect(secondPayload.jobId).toBe(firstPayload.jobId);
    expect(secondPayload.taskId).toBe(firstPayload.taskId);

    gate.resolve();
  });
});
