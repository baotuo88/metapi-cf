import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import * as schema from '../../server/db/schema.js';
import { registerCoreApiRoutes } from './api.js';
import type { CloudflareHonoEnv } from '../shared/http.js';

function createOauthQuotaTestDb() {
  const accountRows = [
    {
      id: 1,
      siteId: 1,
      username: 'claude-user',
      accessToken: 'token',
      apiToken: null,
      balance: 0,
      balanceUsed: 0,
      quota: 0,
      unitCost: null,
      valueScore: 0,
      status: 'active',
      isPinned: false,
      sortOrder: 0,
      checkinEnabled: true,
      lastCheckinAt: null,
      lastBalanceRefresh: null,
      oauthProvider: 'claude',
      oauthAccountKey: 'acct-1',
      oauthProjectId: null,
      extraConfig: JSON.stringify({
        oauth: {
          planType: 'pro',
        },
      }),
      createdAt: null,
      updatedAt: null,
    },
  ];

  const resolveRows = (table: unknown): any[] => {
    if (table === schema.accounts) return accountRows;
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
  const fakeDb = createOauthQuotaTestDb();
  app.use('*', async (c, next) => {
    c.set('db', fakeDb as never);
    await next();
  });
  registerCoreApiRoutes(app);
  return app;
}

describe('cloudflare /api/oauth/connections/:id/quota/refresh', () => {
  it('returns official unsupported windows snapshot for non-codex providers', async () => {
    const app = createTestApp();
    const request = new Request('https://metapi.test/api/oauth/connections/1/quota/refresh', {
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
        waitUntil() {},
        passThroughOnException() {},
      } as never,
    );
    const payload = await response.json() as Record<string, any>;

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.quota).toMatchObject({
      status: 'unsupported',
      source: 'official',
      providerMessage: 'official quota windows are not exposed for claude oauth',
      windows: {
        fiveHour: {
          supported: false,
          message: 'official 5h quota window is unavailable for this provider',
        },
        sevenDay: {
          supported: false,
          message: 'official 7d quota window is unavailable for this provider',
        },
      },
      subscription: {
        planType: 'pro',
      },
    });
    expect(typeof payload.quota.lastSyncAt).toBe('string');
  });
});
