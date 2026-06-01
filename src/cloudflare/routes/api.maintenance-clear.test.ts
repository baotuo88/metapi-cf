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

function createMaintenanceTestDb(options?: { joinDelay?: Promise<void>; clearUsageDelay?: Promise<void> }) {
  const insertedEvents: Array<Record<string, unknown>> = [];
  const makeSelectBuilder = () => {
    let joined = false;
    let table: unknown = null;
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
        if (joined && table === schema.accounts && options?.joinDelay) {
          await options.joinDelay;
        }
        return [];
      },
      async get() {
        return undefined;
      },
    };
    return builder;
  };

  return {
    insertedEvents,
    select() {
      return makeSelectBuilder();
    },
    update(table?: unknown) {
      const targetTable = table || null;
      const resolveChanges = () => {
        if (targetTable === schema.routeChannels) return 14;
        if (targetTable === schema.accounts) return 6;
        return 0;
      };
      return {
        set() {
          return {
            where() {
              return {
                async run() {
                  return { changes: resolveChanges() };
                },
              };
            },
            async run() {
              return { changes: resolveChanges() };
            },
          };
        },
      };
    },
    insert(table?: unknown) {
      let targetTable: unknown = table || null;
      return {
        values(payload?: unknown) {
          if (targetTable === schema.events) {
            if (Array.isArray(payload)) {
              for (const item of payload) {
                if (item && typeof item === 'object') insertedEvents.push(item as Record<string, unknown>);
              }
            } else if (payload && typeof payload === 'object') {
              insertedEvents.push(payload as Record<string, unknown>);
            }
          }
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
    delete(table?: unknown) {
      let targetTable: unknown = table || null;
      const resolveChanges = () => {
        if (targetTable === schema.modelAvailability) return 12;
        if (targetTable === schema.tokenModelAvailability) return 7;
        if (targetTable === schema.routeChannels) return 11;
        if (targetTable === schema.tokenRoutes) return 4;
        if (targetTable === schema.proxyLogs) return 30;
        if (targetTable === schema.siteDayUsage) return 9;
        if (targetTable === schema.siteHourUsage) return 18;
        if (targetTable === schema.modelDayUsage) return 5;
        return 0;
      };
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
              if (targetTable === schema.proxyLogs && options?.clearUsageDelay) {
                await options.clearUsageDelay;
              }
              return { changes: resolveChanges() };
            },
          };
        },
        async run() {
          if (targetTable === schema.proxyLogs && options?.clearUsageDelay) {
            await options.clearUsageDelay;
          }
          return { changes: resolveChanges() };
        },
      };
    },
  };
}

function createTestApp(options?: { joinDelay?: Promise<void>; clearUsageDelay?: Promise<void> }) {
  const app = new Hono<CloudflareHonoEnv>();
  const fakeDb = createMaintenanceTestDb(options);
  app.use('*', async (c, next) => {
    c.set('db', fakeDb as never);
    await next();
  });
  registerCoreApiRoutes(app);
  return { app, fakeDb };
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
      waitUntil() {},
      passThroughOnException() {},
    } as never,
  );
}

describe('cloudflare maintenance clear routes', () => {
  it('queues clear-cache rebuild task and reuses in-flight task', async () => {
    const gate = createDeferred<void>();
    const { app, fakeDb } = createTestApp({ joinDelay: gate.promise });
    const first = await postJson(app, '/api/settings/maintenance/clear-cache', {});
    const firstPayload = await first.json() as Record<string, any>;
    const second = await postJson(app, '/api/settings/maintenance/clear-cache', {});
    const secondPayload = await second.json() as Record<string, any>;

    expect(first.status).toBe(202);
    expect(firstPayload.success).toBe(true);
    expect(firstPayload.queued).toBe(true);
    expect(firstPayload.reused).toBe(false);
    expect(firstPayload.deletedModelAvailability).toBe(12);
    expect(firstPayload.deletedTokenModelAvailability).toBe(7);
    expect(firstPayload.deletedRouteChannels).toBe(11);
    expect(firstPayload.deletedTokenRoutes).toBe(4);
    expect(typeof firstPayload.jobId).toBe('string');
    expect(firstPayload.taskId).toBe(firstPayload.jobId);

    expect(second.status).toBe(202);
    expect(secondPayload.success).toBe(true);
    expect(secondPayload.queued).toBe(true);
    expect(secondPayload.reused).toBe(true);
    expect(secondPayload.deletedModelAvailability).toBe(12);
    expect(secondPayload.deletedTokenModelAvailability).toBe(7);
    expect(secondPayload.deletedRouteChannels).toBe(11);
    expect(secondPayload.deletedTokenRoutes).toBe(4);
    expect(secondPayload.jobId).toBe(firstPayload.jobId);
    expect(secondPayload.taskId).toBe(firstPayload.taskId);

    gate.resolve();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (fakeDb.insertedEvents.some((item) => String(item.title || '').includes('缓存清理后重建'))) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const rebuildEvent = fakeDb.insertedEvents.find((item) => String(item.title || '').includes('缓存清理后重建'));
    expect(!!rebuildEvent).toBe(true);
    expect(String(rebuildEvent?.message || '')).toContain('删除通道 11');
    expect(String(rebuildEvent?.message || '')).toContain('删除路由 4');
  });

  it('queues clear-usage task and reuses in-flight task', async () => {
    const gate = createDeferred<void>();
    const { app } = createTestApp({ clearUsageDelay: gate.promise });
    const first = await postJson(app, '/api/settings/maintenance/clear-usage', {});
    const firstPayload = await first.json() as Record<string, any>;
    const second = await postJson(app, '/api/settings/maintenance/clear-usage', {});
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

  it('returns real deletion counts for clear-usage when wait=true', async () => {
    const { app, fakeDb } = createTestApp();
    const response = await postJson(app, '/api/settings/maintenance/clear-usage', { wait: true });
    const payload = await response.json() as Record<string, any>;

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.queued).toBe(false);
    expect(payload.reused).toBe(false);
    expect(payload.deletedProxyLogs).toBe(30);
    expect(payload.deletedSiteDayUsage).toBe(9);
    expect(payload.deletedSiteHourUsage).toBe(18);
    expect(payload.deletedModelDayUsage).toBe(5);
    expect(payload.resetRouteChannelStats).toBe(14);
    expect(payload.resetAccountBalanceUsage).toBe(6);
    expect(String(payload.message || '')).toContain('使用统计已清理：日志 30');
    expect(String(payload.message || '')).toContain('重置通道统计 14');
    expect(fakeDb.insertedEvents.some((item) => String(item.title || '') === '使用统计已清理')).toBe(true);
  });
});
