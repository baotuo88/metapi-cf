import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import * as schema from '../../server/db/schema.js';
import { registerCoreApiRoutes } from './api.js';
import type { CloudflareHonoEnv } from '../shared/http.js';

function createCheckinTestDb(options?: { throwOnAccountUpdate?: boolean }) {
  const siteRow = {
    id: 1,
    name: 'Site A',
    url: 'https://site-a.example.com',
    platform: 'new-api',
    status: 'active',
    apiKey: null,
    createdAt: '2026-01-01 00:00:00',
    updatedAt: '2026-01-01 00:00:00',
    isPinned: false,
    sortOrder: 0,
    proxyUrl: null,
    useSystemProxy: false,
    customHeaders: null,
    externalCheckinUrl: null,
    globalWeight: 1,
    postRefreshProbeEnabled: false,
    postRefreshProbeModel: '',
    postRefreshProbeScope: 'single',
    postRefreshProbeLatencyThresholdMs: 0,
  };
  const accountRow = {
    id: 1,
    siteId: 1,
    username: 'demo',
    accessToken: 'session=abc123',
    apiToken: null,
    balance: 0,
    balanceUsed: 0,
    quota: 0,
    unitCost: null,
    valueScore: 0,
    status: 'active',
    checkinEnabled: true,
    lastCheckinAt: null,
    lastBalanceRefresh: null,
    extraConfig: null,
    createdAt: '2026-01-01 00:00:00',
    updatedAt: '2026-01-01 00:00:00',
    isPinned: false,
    sortOrder: 0,
    oauthProvider: null,
    oauthAccountKey: null,
    oauthProjectId: null,
  };

  const checkinLogs: Array<Record<string, unknown>> = [];
  const accountUpdates: Array<Record<string, unknown>> = [];

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
        if (table === schema.accounts && joined) {
          return [{ account: accountRow, site: siteRow }];
        }
        if (table === schema.accounts) return [accountRow];
        if (table === schema.sites) return [siteRow];
        return [];
      },
      async get() {
        if (table === schema.accounts) return accountRow;
        if (table === schema.sites) return siteRow;
        return undefined;
      },
    };
    return builder;
  };

  return {
    checkinLogs,
    accountUpdates,
    select() {
      return makeSelectBuilder();
    },
    update(table?: unknown) {
      const target = table || null;
      return {
        set(payload?: Record<string, unknown>) {
          if (target === schema.accounts && payload && typeof payload === 'object') {
            accountUpdates.push(payload);
          }
          return {
            where() {
              return {
                async run() {
                  if (target === schema.accounts && options?.throwOnAccountUpdate) {
                    throw new Error('account update failed');
                  }
                  return { changes: 1 };
                },
              };
            },
            async run() {
              if (target === schema.accounts && options?.throwOnAccountUpdate) {
                throw new Error('account update failed');
              }
              return { changes: 1 };
            },
          };
        },
      };
    },
    insert(table?: unknown) {
      const target = table || null;
      return {
        values(payload?: unknown) {
          if (target === schema.checkinLogs) {
            if (Array.isArray(payload)) {
              for (const item of payload) {
                if (item && typeof item === 'object') checkinLogs.push(item as Record<string, unknown>);
              }
            } else if (payload && typeof payload === 'object') {
              checkinLogs.push(payload as Record<string, unknown>);
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
              return { changes: 1 };
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

function createTestApp(options?: { throwOnAccountUpdate?: boolean }) {
  const app = new Hono<CloudflareHonoEnv>();
  const fakeDb = createCheckinTestDb(options);
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
    headers: { 'content-type': 'application/json' },
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('cloudflare checkin rate limit handling', () => {
  it('returns skipped instead of failed when upstream checkin is rate-limited', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/user/checkin')) {
        return new Response(JSON.stringify({ message: 'Too Many Requests' }), {
          status: 429,
          headers: {
            'content-type': 'application/json',
          },
        });
      }
      return new Response(JSON.stringify({ success: true, data: { quota: 10, used_quota: 0 } }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { app, fakeDb } = createTestApp();
    const response = await postJson(app, '/api/checkin/trigger/1', {});
    const payload = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.status).toBe('skipped');
    expect(payload.skipped).toBe(true);
    expect(String(payload.message || '')).toContain('请求过于频繁');
    expect(fakeDb.checkinLogs).toHaveLength(1);
    expect(String(fakeDb.checkinLogs[0]?.status || '')).toBe('skipped');
    expect(fakeDb.accountUpdates.length).toBeGreaterThan(0);
    expect(fakeDb.accountUpdates[0]?.lastCheckinAt).toBeUndefined();
  });

  it('includes retry-after hint when upstream provides retry-after header', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/user/checkin')) {
        return new Response(JSON.stringify({ message: 'rate limit exceeded' }), {
          status: 429,
          headers: {
            'content-type': 'application/json',
            'retry-after': '120',
          },
        });
      }
      return new Response(JSON.stringify({ success: true, data: { quota: 10, used_quota: 0 } }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { app } = createTestApp();
    const response = await postJson(app, '/api/checkin/trigger/1', {});
    const payload = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(payload.status).toBe('skipped');
    expect(String(payload.message || '')).toContain('120 秒后重试');
  });

  it('preserves upstream network error detail for single-account checkin failure', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/user/checkin')) {
        throw new Error('connect timeout');
      }
      return new Response(JSON.stringify({ success: true, data: { quota: 10, used_quota: 0 } }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { app, fakeDb } = createTestApp();
    const response = await postJson(app, '/api/checkin/trigger/1', {});
    const payload = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(400);
    expect(payload.success).toBe(false);
    expect(payload.status).toBe('failed');
    expect(String(payload.message || '')).toContain('connect timeout');
    expect(fakeDb.checkinLogs).toHaveLength(1);
    expect(String(fakeDb.checkinLogs[0]?.status || '')).toBe('failed');
    expect(String(fakeDb.checkinLogs[0]?.message || '')).toContain('connect timeout');
  });

  it('writes failed checkin log when bulk checkin throws during per-account update', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/user/checkin')) {
        return new Response(JSON.stringify({ success: true, message: 'ok', data: { reward: '1' } }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        });
      }
      if (url.endsWith('/api/user/self')) {
        return new Response(JSON.stringify({
          success: true,
          data: {
            quota: 10,
            used_quota: 0,
            username: 'demo',
          },
        }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        });
      }
      return new Response('{}', {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { app, fakeDb } = createTestApp({ throwOnAccountUpdate: true });
    const response = await postJson(app, '/api/checkin/trigger', {});
    const payload = await response.json() as Record<string, unknown>;
    const summary = payload.summary as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(summary.failed).toBe(1);
    expect(summary.success).toBe(0);
    expect(fakeDb.checkinLogs.length).toBeGreaterThan(0);
    const failedLog = fakeDb.checkinLogs.find((item) => String(item.status || '') === 'failed');
    expect(!!failedLog).toBe(true);
    expect(String(failedLog?.message || '')).toContain('account update failed');
  });
});
